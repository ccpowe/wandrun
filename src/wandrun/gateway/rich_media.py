"""Disposable media cache and SSRF-constrained image acquisition.

The caller must look up the URL in an authenticated, persisted message. This
module never accepts an HTTP request or authorizes a message reference itself.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import socket
import struct
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp.abc import AbstractResolver
from yarl import URL


MAX_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 20_000_000
MAX_SIDE = 8192
CACHE_BYTES = 512 * 1024 * 1024
CACHE_AGE = 30 * 24 * 60 * 60
USER_AGENT = "Wandrun/0.1 (+https://github.com/ccpowe/wandrun)"
_KEY = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_HOST = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\Z")
_HEADER_LIMIT = 512
# IPv4/IPv6 translation prefixes can reach an internal IPv4 destination even
# when the outer address is classified global. Egress firewall policy is still
# needed for deployment-specific NAT64 prefixes and routed public LAN ranges.
_TRANSLATION = tuple(ipaddress.ip_network(net) for net in (
    "64:ff9b::/96", "64:ff9b:1::/48", "2001::/32", "2002::/16",
))


class MediaError(Exception):
    """Safe error for a media HTTP response; never contains an upstream URL."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass(frozen=True)
class MediaData:
    data: bytes
    mime: str
    width: int
    height: int


class MediaCache:
    """Atomic, process-local LRU cache for proxied images.

    Fetch age is independent of recent access: a popular image must still be
    refetched after 30 days. Synchronous reads/writes complete before returning
    bytes; a caller never keeps an open cache file across an await.
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._prune()

    def _entries(self):
        now = time.time()
        entries = []
        for entry in self.root.iterdir():
            if entry.is_dir() and not entry.is_symlink():
                continue
            if entry.is_symlink() or not entry.is_file() or not _KEY.fullmatch(entry.name):
                # This directory is dedicated to disposable media, not uploads.
                entry.unlink(missing_ok=True)
                continue
            try:
                stat = entry.stat()
                with entry.open("rb") as file:
                    header = file.readline(_HEADER_LIMIT + 1)
                meta = json.loads(header)
                fetched = meta["fetched"]
                if (len(header) > _HEADER_LIMIT or not isinstance(fetched, (int, float))
                        or fetched > now + 60 or now - fetched >= CACHE_AGE
                        or stat.st_size > CACHE_BYTES):
                    entry.unlink(missing_ok=True)
                    continue
                entries.append((stat.st_mtime, stat.st_size, entry))
            except (OSError, ValueError, KeyError, TypeError):
                entry.unlink(missing_ok=True)
        return entries

    def _prune(self, protected: Path | None = None):
        entries = self._entries()
        total = sum(size for _, size, _ in entries)
        for _, size, path in sorted(entries):
            if total <= CACHE_BYTES:
                break
            if path != protected:
                path.unlink(missing_ok=True)
                total -= size

    def get(self, key: str) -> MediaData | None:
        if not _KEY.fullmatch(key):
            raise ValueError("invalid media cache key")
        path = self.root / key
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as file:
                header = file.readline(_HEADER_LIMIT + 1)
                if len(header) > _HEADER_LIMIT:
                    raise ValueError("invalid cache header")
                meta = json.loads(header)
                if time.time() - meta["fetched"] >= CACHE_AGE or meta["fetched"] > time.time() + 60:
                    raise ValueError("expired cache entry")
                size = meta["size"]
                if type(size) is not int or not 0 < size <= CACHE_BYTES:
                    raise ValueError("invalid cache size")
                data = file.read(size + 1)
                if len(data) != size or hashlib.sha256(data).hexdigest() != meta["sha256"]:
                    raise ValueError("corrupt cache entry")
                result = MediaData(data, meta["mime"], meta["width"], meta["height"])
                if result.mime not in ("image/jpeg", "image/png") or not (0 < result.width <= MAX_SIDE and 0 < result.height <= MAX_SIDE):
                    raise ValueError("invalid cached media")
            os.utime(path, None)
            return result
        except FileNotFoundError:
            return None
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            path.unlink(missing_ok=True)
            return None

    def put(self, key: str, value: MediaData) -> None:
        if not _KEY.fullmatch(key):
            raise ValueError("invalid media cache key")
        if value.mime not in ("image/jpeg", "image/png") or not (0 < value.width <= MAX_SIDE and 0 < value.height <= MAX_SIDE):
            raise ValueError("invalid media data")
        if len(value.data) > CACHE_BYTES - _HEADER_LIMIT or not value.data:
            raise MediaError(413, "media_too_large", "媒体超过缓存上限")
        header = json.dumps({
            "fetched": time.time(), "size": len(value.data), "mime": value.mime,
            "width": value.width, "height": value.height,
            "sha256": hashlib.sha256(value.data).hexdigest(),
        }, separators=(",", ":")).encode() + b"\n"
        path = self.root / key
        # Temporary names are deliberately not valid cache keys; startup pruning
        # removes abandoned writes. replace() only publishes a complete object.
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.root, prefix=".part-", delete=False) as file:
                name = file.name
                file.write(header)
                file.write(value.data)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, path)
            self._prune(protected=path)
        finally:
            if name is not None:
                Path(name).unlink(missing_ok=True)


def _image_cache_key(url: str) -> str:
    return "image-v1-" + hashlib.sha256(url.encode("utf-8")).hexdigest()


def _wikimedia_thumbnail(raw_url: str) -> str | None:
    """Select a bounded raster preview without changing the source cache identity."""
    parts = urlsplit(raw_url)
    if parts.hostname != "upload.wikimedia.org":
        return None
    match = re.fullmatch(
        r"/wikipedia/([^/]+)/([0-9a-f])/([0-9a-f]{2})/([^/]+)", parts.path,
    )
    if match is None:
        return None
    project, first, second, filename = match.groups()
    # Decode only unreserved escapes for the extension check; keep the raw
    # filename in the URL so %2F cannot become a path separator.
    def unreserved(match: re.Match[str]) -> str:
        char = chr(int(match[1], 16))
        return char if char.isascii() and (char.isalnum() or char in "-._~") else match[0]

    normalized_filename = re.sub(r"%([0-9a-fA-F]{2})", unreserved, filename)
    # Wikimedia rasterizes these originals; the output suffix is part of its URL.
    suffix = ".png" if normalized_filename.lower().endswith(".svg") else (
        ".jpg" if normalized_filename.lower().endswith((".tif", ".tiff")) else ""
    )
    path = f"/wikipedia/{project}/thumb/{first}/{second}/{filename}/1280px-{filename}{suffix}"
    return parts._replace(path=path).geturl()


def _public_address(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        raise MediaError(400, "invalid_media_url", "图片地址无效") from None
    # Mapped addresses are rejected outright; accepting a public embedded IPv4
    # would still let a different transport/address family evade an IPv4 policy.
    if isinstance(ip, ipaddress.IPv6Address) and (
        ip.ipv4_mapped is not None or ip.sixtofour is not None or ip.teredo is not None
        or ip.is_site_local or any(ip in net for net in _TRANSLATION)
    ):
        raise MediaError(400, "unsafe_media_address", "图片地址不可访问")
    if not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        raise MediaError(400, "unsafe_media_address", "图片地址不可访问")
    return ip


def _parse_url(raw: str) -> tuple[URL, str, int]:
    if (not isinstance(raw, str) or len(raw) > 4096 or not raw.isascii()
            or re.search(r"[\x00-\x20\x7f\\#]", raw)):
        raise MediaError(400, "invalid_media_url", "图片地址无效")
    try:
        parts = urlsplit(raw)
        if parts.scheme.lower() not in ("http", "https") or not parts.netloc or parts.username is not None or parts.password is not None:
            raise ValueError("scheme or credentials")
        authority = parts.netloc
        if "@" in authority or "%" in authority or authority.endswith(":"):
            raise ValueError("ambiguous authority")
        host = parts.hostname
        if host is None or host.endswith(".") or host.startswith("."):
            raise ValueError("invalid hostname")
        port = parts.port if parts.port is not None else (443 if parts.scheme.lower() == "https" else 80)
        if port != (443 if parts.scheme.lower() == "https" else 80):
            raise ValueError("nonstandard port")
        if ":" in host:
            if authority.split("]", 1)[0] != f"[{host}" or str(ipaddress.IPv6Address(host)) != host.lower():
                raise ValueError("noncanonical IPv6")
            _public_address(host)
        else:
            if len(host) > 253 or not _HOST.fullmatch(host) or any(label.startswith("-") or label.endswith("-") for label in host.split(".")):
                raise ValueError("invalid DNS name")
            try:
                numeric = ipaddress.ip_address(host)
            except ValueError:
                # Disallow legacy IPv4 shorthand/octal/hex accepted by some DNS
                # and socket APIs; neither layer may reinterpret a host as an IP.
                if all(char.isdigit() or char == "." for char in host) or any(label.lower().startswith("0x") for label in host.split(".")):
                    raise ValueError("ambiguous numeric hostname") from None
            else:
                if str(numeric) != host:
                    raise ValueError("noncanonical IPv4")
                _public_address(host)
        url = URL(raw)
        if url.raw_host != host.lower() or url.port != port:
            raise ValueError("URL parser disagreement")
        return url, host.lower(), port
    except (ValueError, OverflowError):
        raise MediaError(400, "invalid_media_url", "图片地址无效") from None


async def _resolve_addresses(host: str, port: int) -> list[str]:
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except (OSError, UnicodeError):
            raise MediaError(502, "media_unavailable", "图片源站不可用") from None
        if not infos:
            raise MediaError(502, "media_unavailable", "图片源站不可用")
        addresses = []
        for family, _, _, _, sockaddr in infos:
            if family not in (socket.AF_INET, socket.AF_INET6):
                raise MediaError(400, "unsafe_media_address", "图片地址不可访问")
            if family == socket.AF_INET6 and (len(sockaddr) < 4 or sockaddr[3] != 0):
                raise MediaError(400, "unsafe_media_address", "图片地址不可访问")
            address = _public_address(sockaddr[0])
            if address.version != (4 if family == socket.AF_INET else 6):
                raise MediaError(400, "unsafe_media_address", "图片地址不可访问")
            if str(address) not in addresses:
                addresses.append(str(address))
        return addresses
    else:
        return [str(_public_address(str(literal)))]


class _PinnedResolver(AbstractResolver):
    def __init__(self, host: str, addresses: list[str]):
        self.host = host
        self.addresses = addresses

    async def resolve(self, host: str, port: int, family: int = socket.AF_UNSPEC):
        if host != self.host:
            raise OSError("unexpected DNS lookup")
        return [{"hostname": host, "host": address, "port": port,
                 "family": socket.AF_INET6 if ":" in address else socket.AF_INET,
                 "proto": 0, "flags": 0} for address in self.addresses]

    async def close(self):
        pass


class ImageProxy:
    """Fetches validated message URLs, deduplicating up to 32 concurrent jobs.

    Cancellation of the last caller cancels the job. aclose() cancels and joins
    every in-flight download/decoder; no request outlives the proxy.
    """

    def __init__(self, cache: MediaCache):
        self.cache = cache
        self._slots = asyncio.Semaphore(2)
        self._jobs: dict[str, asyncio.Task[MediaData]] = {}
        self._waiters: dict[str, int] = {}
        self._retiring: set[asyncio.Task[MediaData]] = set()
        self._closed = False

    async def get(self, url: str) -> MediaData:
        _parse_url(url)
        if self._closed:
            raise MediaError(503, "media_unavailable", "图片代理已关闭")
        key = _image_cache_key(url)
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        task = self._jobs.get(key)
        if task is None:
            if len(self._jobs) + len(self._retiring) >= 32:
                raise MediaError(429, "media_busy", "图片请求过多")
            task = asyncio.create_task(self._load(url, key))
            self._jobs[key] = task
            self._waiters[key] = 0
        self._waiters[key] += 1
        try:
            return await asyncio.shield(task)
        finally:
            self._waiters[key] -= 1
            if self._waiters[key] == 0:
                self._jobs.pop(key)
                self._waiters.pop(key)
                self._retiring.add(task)
                task.add_done_callback(self._retired)
                if not task.done():
                    task.cancel()
                await asyncio.shield(asyncio.gather(task, return_exceptions=True))

    def _retired(self, task: asyncio.Task[MediaData]) -> None:
        self._retiring.discard(task)
        if not task.cancelled():
            task.exception()

    async def _load(self, url: str, key: str) -> MediaData:
        try:
            async with asyncio.timeout(15):
                async with self._slots:
                    thumbnail = _wikimedia_thumbnail(url)
                    if thumbnail is None:
                        raw = await self._download(url)
                    else:
                        try:
                            raw = await self._download(thumbnail)
                        except MediaError as error:
                            # Unavailable previews (including too-small originals)
                            # may fall back; policy and size failures must not.
                            if error.code != "media_unavailable":
                                raise
                            raw = await self._download(url)
                    media = await _decode(raw)
                    self.cache.put(key, media)
                    return media
        except TimeoutError:
            raise MediaError(504, "media_timeout", "图片获取超时") from None

    async def _download(self, raw_url: str) -> bytes:
        seen = set()
        for redirect_count in range(4):
            url, host, port = _parse_url(raw_url)
            if str(url) in seen:
                raise MediaError(502, "media_redirect", "图片重定向循环")
            seen.add(str(url))
            addresses = await _resolve_addresses(host, port)
            connector = aiohttp.TCPConnector(
                resolver=_PinnedResolver(host, addresses), use_dns_cache=False,
                force_close=True, limit=1,
            )
            timeout = aiohttp.ClientTimeout(connect=3, sock_connect=3, sock_read=5, total=None)
            try:
                async with aiohttp.ClientSession(
                    connector=connector, timeout=timeout, trust_env=False,
                    cookie_jar=aiohttp.DummyCookieJar(), auto_decompress=False,
                    headers={"Accept": "image/jpeg,image/png,image/webp", "Accept-Encoding": "identity",
                             "User-Agent": USER_AGENT},
                ) as session:
                    async with session.get(url, allow_redirects=False) as response:
                        if response.status in (301, 302, 303, 307, 308):
                            if redirect_count == 3:
                                raise MediaError(502, "media_redirect", "图片重定向过多")
                            location = response.headers.get("Location")
                            if not location:
                                raise MediaError(502, "media_redirect", "图片重定向无效")
                            next_url = urljoin(str(url), location)
                            parsed, _, _ = _parse_url(next_url)
                            if url.scheme == "https" and parsed.scheme != "https":
                                raise MediaError(502, "media_redirect", "图片重定向无效")
                            raw_url = next_url
                            continue
                        if response.status != 200:
                            raise MediaError(502, "media_unavailable", "图片源站不可用")
                        if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                            raise MediaError(415, "unsupported_media", "不支持的图片编码")
                        if response.content_length is not None and response.content_length > MAX_BYTES:
                            raise MediaError(413, "media_too_large", "图片超过大小限制")
                        chunks = []
                        size = 0
                        async for chunk in response.content.iter_chunked(64 * 1024):
                            size += len(chunk)
                            if size > MAX_BYTES:
                                raise MediaError(413, "media_too_large", "图片超过大小限制")
                            chunks.append(chunk)
                        return b"".join(chunks)
            except (aiohttp.ClientError, OSError, ValueError):
                raise MediaError(502, "media_unavailable", "图片源站不可用") from None
        raise MediaError(502, "media_redirect", "图片重定向过多")

    async def aclose(self) -> None:
        self._closed = True
        tasks = list(self._jobs.values()) + list(self._retiring)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _decode(raw: bytes) -> MediaData:
    # A process, not a thread: cancellation/timeout can kill the Pillow decoder
    # even if native code never returns. The child emits only bounded sanitized
    # pixels and never returns source metadata or error details.
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "wandrun.gateway.rich_media", "--decode",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, env={},
        )
    except OSError:
        raise MediaError(503, "media_unavailable", "图片处理暂不可用") from None
    try:
        payload, _ = await process.communicate(raw)
    except BaseException:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.wait()
        raise
    if process.returncode != 0 or not payload:
        raise MediaError(415, "unsupported_media", "不支持的图片格式")
    if payload[:1] != b"O":
        code = "media_too_large" if payload == b"Esize" else "unsupported_media"
        raise MediaError(413 if code == "media_too_large" else 415, code, "图片超过大小限制" if code == "media_too_large" else "不支持的图片格式")
    if len(payload) < 11 or len(payload) > MAX_BYTES + 10:
        raise MediaError(413, "media_too_large", "图片超过大小限制")
    width, height, kind = struct.unpack("!IIc", payload[1:10])
    if kind not in (b"J", b"P") or not payload[10:]:
        raise MediaError(415, "unsupported_media", "不支持的图片格式")
    if not (0 < width <= MAX_SIDE and 0 < height <= MAX_SIDE and width * height <= MAX_PIXELS):
        raise MediaError(413, "media_too_large", "图片超过大小限制")
    return MediaData(payload[10:], "image/jpeg" if kind == b"J" else "image/png", width, height)


def _decode_worker() -> None:
    import io
    import warnings
    from PIL import Image, ImageFile, ImageOps

    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    except (ImportError, OSError, ValueError):
        pass  # parent timeout always terminates this child
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            sys.stdout.buffer.write(b"Esize")
            return
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as probe:
                if probe.format not in ("JPEG", "PNG", "WEBP") or getattr(probe, "n_frames", 1) != 1:
                    raise ValueError("unsupported format or animation")
                width, height = probe.size
                if (not 0 < width <= MAX_SIDE or not 0 < height <= MAX_SIDE
                        or width * height > MAX_PIXELS):
                    sys.stdout.buffer.write(b"Esize")
                    return
                fmt = probe.format
                probe.verify()
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != fmt or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("inconsistent image")
                image.load()
                oriented = ImageOps.exif_transpose(image)
                width, height = oriented.size
                if width > MAX_SIDE or height > MAX_SIDE:
                    sys.stdout.buffer.write(b"Esize")
                    return
                alpha = "A" in oriented.getbands() or "transparency" in oriented.info
                clean = oriented.convert("RGBA" if alpha else "RGB")
                # convert() retains info; PNG's writer otherwise implicitly copies
                # ICC/EXIF fields even when save() receives no metadata arguments.
                clean.info.clear()
                output = io.BytesIO()
                if alpha:
                    clean.save(output, format="PNG")
                    kind = b"P"
                else:
                    clean.save(output, format="JPEG", quality=85)
                    kind = b"J"
                body = output.getvalue()
                if len(body) > MAX_BYTES:
                    sys.stdout.buffer.write(b"Esize")
                    return
                sys.stdout.buffer.write(b"O" + struct.pack("!IIc", width, height, kind) + body)
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        sys.stdout.buffer.write(b"Esize")
    except (Exception, Warning):
        sys.stdout.buffer.write(b"Eformat")


if __name__ == "__main__" and sys.argv[1:] == ["--decode"]:
    _decode_worker()
