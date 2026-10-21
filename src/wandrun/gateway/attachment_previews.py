"""Bounded, isolated previews for authenticated local attachment files.

The parent process owns authorization and opens the already-validated file
handle. A short-lived worker receives only that read-only descriptor and
returns sanitized metadata or JPEG bytes; media libraries never run in the
HTTP process.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import mimetypes
import os
import signal
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


THUMBNAIL_WIDTHS = frozenset({240, 480, 960})
PREVIEW_TIMEOUT = 10
MAX_PIXELS = 4096 * 4096
MAX_SIDE = 4096
MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024
CACHE_BYTES = 256 * 1024 * 1024
CACHE_AGE = 30 * 24 * 60 * 60
_CACHE_HEADER_LIMIT = 512
_MAX_WORKER_OUTPUT = 12 * 1024 * 1024


class PreviewUnavailable(RuntimeError):
    """A local file cannot be safely decoded into the requested preview."""

    status = 422
    code = "preview_unavailable"
    message = "附件预览不可用"

    def __init__(self, message: str | None = None):
        super().__init__(message or self.message)


@dataclass(frozen=True)
class PreviewArtifact:
    payload: bytes
    etag: str
    metadata: dict | None = None


@dataclass(frozen=True)
class _Source:
    identity: str
    record: dict
    fd: int
    size: int
    mtime_ns: int
    kind: str


class PreviewCache:
    """Atomic cache shared by preview metadata and JPEG derivatives."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.prune()

    def _entries(self) -> list[tuple[float, int, Path]]:
        now = time.time()
        entries: list[tuple[float, int, Path]] = []
        try:
            children = list(self.root.iterdir())
        except OSError:
            return entries
        for path in children:
            if path.is_dir() or path.is_symlink() or path.suffix not in {".json", ".jpg"}:
                if path.is_file() or path.is_symlink():
                    path.unlink(missing_ok=True)
                continue
            try:
                stat = path.stat()
                with path.open("rb") as file:
                    header = file.readline(_CACHE_HEADER_LIMIT + 1)
                meta = json.loads(header)
                created = meta["created"]
                size = meta["size"]
                if (
                    len(header) > _CACHE_HEADER_LIMIT
                    or type(created) not in (int, float)
                    or not math.isfinite(created)
                    or created > now + 60
                    or now - created >= CACHE_AGE
                    or type(size) is not int
                    or size <= 0
                    or size > CACHE_BYTES
                    or stat.st_size > CACHE_BYTES
                ):
                    path.unlink(missing_ok=True)
                    continue
                entries.append((stat.st_mtime, stat.st_size, path))
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                path.unlink(missing_ok=True)
        return entries

    def prune(self, protected: Path | None = None) -> None:
        entries = self._entries()
        total = sum(size for _, size, _ in entries)
        for _, size, path in sorted(entries):
            if total <= CACHE_BYTES:
                break
            if path != protected:
                path.unlink(missing_ok=True)
                total -= size

    def get(
        self,
        key: str,
        suffix: str,
        validator: Callable[[bytes], bool] | None = None,
    ) -> bytes | None:
        path = self.root / f"{key}{suffix}"
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as file:
                header = file.readline(_CACHE_HEADER_LIMIT + 1)
                if len(header) > _CACHE_HEADER_LIMIT:
                    raise ValueError("cache header")
                meta = json.loads(header)
                size = meta["size"]
                digest = meta["sha256"]
                created = meta["created"]
                if (
                    type(size) is not int
                    or not 0 < size <= CACHE_BYTES
                    or type(created) not in (int, float)
                    or not math.isfinite(created)
                    or created > time.time() + 60
                    or time.time() - created >= CACHE_AGE
                    or type(digest) is not str
                ):
                    raise ValueError("cache metadata")
                payload = file.read(size + 1)
                if len(payload) != size or hashlib.sha256(payload).hexdigest() != digest:
                    raise ValueError("cache digest")
            if validator is not None and not validator(payload):
                raise ValueError("cache payload")
            os.utime(path, None)
            return payload
        except FileNotFoundError:
            return None
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            path.unlink(missing_ok=True)
            return None

    def put(self, key: str, suffix: str, payload: bytes) -> None:
        if not payload or len(payload) > CACHE_BYTES - _CACHE_HEADER_LIMIT:
            raise PreviewUnavailable("附件预览超过缓存上限")
        path = self.root / f"{key}{suffix}"
        header = json.dumps(
            {
                "created": time.time(),
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            },
            separators=(",", ":"),
        ).encode() + b"\n"
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.root, prefix=".part-", delete=False) as file:
                temporary = file.name
                file.write(header)
                file.write(payload)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
            self.prune(protected=path)
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)


class AttachmentPreviewService:
    """Generate and cache local-file previews with two global worker slots."""

    def __init__(self, root: Path):
        self.cache = PreviewCache(root)
        self._slots = asyncio.Semaphore(2)
        self._jobs: dict[tuple[str, str], asyncio.Task[PreviewArtifact]] = {}
        self._cleanup_task: asyncio.Task | None = None
        self._closed = False

    def start(self) -> None:
        """Start periodic cache maintenance when attached to a running gateway."""
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop(), name="attachment-preview-cache")

    async def _cleanup_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(60)
                self.cache.prune()
        except asyncio.CancelledError:
            return

    async def preview(self, identity: str, opener: Callable[[str], tuple[dict, int]]) -> PreviewArtifact:
        return await self._get(identity, opener, "preview", None)

    async def thumbnail(
        self, identity: str, width: int, opener: Callable[[str], tuple[dict, int]]
    ) -> PreviewArtifact:
        if width not in THUMBNAIL_WIDTHS:
            raise ValueError("unsupported thumbnail width")
        return await self._get(identity, opener, f"thumbnail-{width}", width)

    async def _get(
        self,
        identity: str,
        opener: Callable[[str], tuple[dict, int]],
        variant: str,
        width: int | None,
    ) -> PreviewArtifact:
        if self._closed:
            raise PreviewUnavailable("附件预览服务已关闭")
        source = self._open_source(identity, opener)
        suffix = ".json" if width is None else ".jpg"
        key = self._key(identity, source.size, source.mtime_ns, f"{source.kind}:{variant}")
        validator = _valid_metadata_payload if width is None else None
        cached = self.cache.get(key, suffix, validator)
        if cached is not None:
            os.close(source.fd)
            return self._artifact(cached, key, width)
        job_key = (key, variant)
        task = self._jobs.get(job_key)
        if task is None:
            task = asyncio.create_task(
                self._generate(source, key, variant, width),
                name=f"attachment-preview-{variant}",
            )
            self._jobs[job_key] = task
            task.add_done_callback(lambda done, job_key=job_key: self._finished(job_key, done))
        else:
            os.close(source.fd)
        try:
            # A cancelled HTTP waiter must not cancel a shared decoder.
            return await asyncio.shield(task)
        except PreviewUnavailable:
            raise
        except asyncio.CancelledError:
            raise
        except Exception:
            raise PreviewUnavailable() from None

    def _open_source(self, identity: str, opener: Callable[[str], tuple[dict, int]]) -> _Source:
        record, fd = opener(identity)
        try:
            stat = os.fstat(fd)
            if stat.st_size < 0 or stat.st_size > MAX_INPUT_BYTES:
                raise PreviewUnavailable("附件超过预览大小限制")
            kind = _media_kind(record)
            if kind not in {"image", "video", "audio", "pdf"}:
                raise PreviewUnavailable("不支持的附件类型")
            return _Source(identity, record, fd, stat.st_size, stat.st_mtime_ns, kind)
        except BaseException:
            os.close(fd)
            raise

    async def _generate(
        self, source: _Source, key: str, variant: str, width: int | None
    ) -> PreviewArtifact:
        try:
            async with self._slots:
                result = await _run_worker(source, width)
            payload = result["payload"]
            suffix = ".json" if width is None else ".jpg"
            self.cache.put(key, suffix, payload)
            return self._artifact(payload, key, width)
        except PreviewUnavailable:
            raise
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            raise PreviewUnavailable() from None
        finally:
            os.close(source.fd)

    def _finished(self, job_key: tuple[str, str], task: asyncio.Task[PreviewArtifact]) -> None:
        if self._jobs.get(job_key) is task:
            self._jobs.pop(job_key, None)
        if not task.cancelled():
            task.exception()

    @staticmethod
    def _key(identity: str, size: int, mtime_ns: int, variant: str) -> str:
        raw = f"attachment-preview-v1\0{identity}\0{size}\0{mtime_ns}\0{variant}".encode()
        return hashlib.sha256(raw).hexdigest()

    @staticmethod
    def _artifact(payload: bytes, key: str, width: int | None) -> PreviewArtifact:
        if width is None:
            try:
                metadata = json.loads(payload)
            except (ValueError, TypeError, json.JSONDecodeError):
                raise PreviewUnavailable() from None
            if not _valid_metadata(metadata):
                raise PreviewUnavailable()
            return PreviewArtifact(payload, key, metadata)
        return PreviewArtifact(payload, key)

    async def aclose(self) -> None:
        self._closed = True
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            await asyncio.gather(self._cleanup_task, return_exceptions=True)
            self._cleanup_task = None
        tasks = list(self._jobs.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._jobs.clear()

def _valid_metadata_payload(payload: bytes) -> bool:
    try:
        return _valid_metadata(json.loads(payload))
    except (ValueError, TypeError, json.JSONDecodeError):
        return False


def _valid_metadata(value: object) -> bool:
    if not isinstance(value, dict) or set(value) != {
        "kind", "width", "height", "duration_ms", "page_count",
    }:
        return False
    kind = value["kind"]
    if not isinstance(kind, str) or kind not in {"image", "video", "audio", "pdf"}:
        return False
    fields = {name: value[name] for name in ("width", "height", "duration_ms", "page_count")}
    for item in fields.values():
        if item is not None and (type(item) is not int or item < 0):
            return False
    if kind == "audio":
        return fields["width"] is None and fields["height"] is None and fields["page_count"] is None
    if fields["width"] is None or fields["height"] is None:
        return False
    if fields["width"] <= 0 or fields["height"] <= 0:
        return False
    if kind in {"image", "video"} and (
        fields["width"] > MAX_SIDE
        or fields["height"] > MAX_SIDE
        or fields["width"] * fields["height"] > MAX_PIXELS
        or fields["page_count"] is not None
    ):
        return False
    if kind == "image":
        return fields["duration_ms"] is None
    if kind == "video":
        return fields["page_count"] is None
    if kind == "pdf":
        return fields["duration_ms"] is None and (
            type(fields["page_count"]) is int and fields["page_count"] >= 1
        )
    return False

def _media_kind(record: dict) -> str:
    media_type = str(record.get("media_type") or "").split(";", 1)[0].lower()
    if media_type.startswith("image/"):
        return "image"
    if media_type.startswith("video/"):
        return "video"
    if media_type.startswith("audio/"):
        return "audio"
    if media_type == "application/pdf" or str(record.get("name", "")).lower().endswith(".pdf"):
        return "pdf"
    guessed, _ = mimetypes.guess_type(str(record.get("name", "")))
    if guessed == "application/pdf":
        return "pdf"
    return ""


async def _run_worker(source: _Source, width: int | None) -> dict:
    args = [
        sys.executable,
        "-m",
        "wandrun.gateway.attachment_previews",
        "--worker",
        "--fd",
        str(source.fd),
        "--kind",
        source.kind,
    ]
    if width is not None:
        args.extend(("--width", str(width)))
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={},
            pass_fds=(source.fd,),
            start_new_session=True,
        )
    except OSError:
        raise PreviewUnavailable("附件预览处理器不可用") from None
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), PREVIEW_TIMEOUT)
    except TimeoutError:
        if process.returncode is None:
            _kill_process(process.pid)
        await process.wait()
        raise PreviewUnavailable("附件预览处理超时") from None
    except BaseException:
        if process.returncode is None:
            _kill_process(process.pid)
        await process.wait()
        raise
    if process.returncode != 0 or len(stdout) > _MAX_WORKER_OUTPUT:
        raise PreviewUnavailable()
    line, separator, payload = stdout.partition(b"\n")
    if not separator:
        raise PreviewUnavailable()
    try:
        result = json.loads(line)
    except (ValueError, TypeError, json.JSONDecodeError):
        raise PreviewUnavailable() from None
    if result.get("ok") is not True:
        raise PreviewUnavailable()
    body_size = result.get("body_size", 0)
    if type(body_size) is not int or body_size != len(payload) or body_size > _MAX_WORKER_OUTPUT:
        raise PreviewUnavailable()
    if width is None:
        metadata = result.get("metadata")
        if not isinstance(metadata, dict):
            raise PreviewUnavailable()
        return {"payload": json.dumps(metadata, separators=(",", ":")).encode()}
    if not payload or result.get("mime") != "image/jpeg":
        raise PreviewUnavailable()
    return {"payload": payload}


def _kill_process(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _worker_limits() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (PREVIEW_TIMEOUT, PREVIEW_TIMEOUT))
    except (ImportError, OSError, ValueError):
        pass


def _worker_main(fd: int, kind: str, width: int | None) -> None:
    _worker_limits()
    try:
        path = f"/proc/self/fd/{fd}"
        metadata: dict
        body = b""
        if kind == "image":
            metadata, body = _worker_image(path, width)
        elif kind == "video":
            metadata, body = _worker_video(path, width)
        elif kind == "audio":
            metadata, body = _worker_audio(path)
            if width is not None:
                raise ValueError("audio thumbnail")
        elif kind == "pdf":
            metadata, body = _worker_pdf(path, width)
        else:
            raise ValueError("media kind")
        result = {"ok": True, "metadata": metadata, "body_size": len(body)}
        if body:
            result["mime"] = "image/jpeg"
        sys.stdout.buffer.write(json.dumps(result, separators=(",", ":")).encode() + b"\n" + body)
    except BaseException:
        sys.stdout.buffer.write(b'{"ok":false}\n')


def _check_dimensions(width: int, height: int) -> None:
    if not (0 < width <= MAX_SIDE and 0 < height <= MAX_SIDE and width * height <= MAX_PIXELS):
        raise ValueError("pixel limit")


def _scaled_size(width: int, height: int, target: int) -> tuple[int, int]:
    scale = min(1.0, target / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


def _worker_image(path: str, target: int | None) -> tuple[dict, bytes]:
    import io
    from PIL import Image, ImageFile, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    with Image.open(path) as probe:
        if probe.format not in {"JPEG", "PNG", "WEBP"} or getattr(probe, "n_frames", 1) != 1:
            raise ValueError("image format")
        width, height = probe.size
        _check_dimensions(width, height)
        probe.verify()
    if target is None:
        return {"kind": "image", "width": width, "height": height, "duration_ms": None, "page_count": None}, b""
    with Image.open(path) as image:
        image.load()
        image = ImageOps.exif_transpose(image)
        width, height = image.size
        _check_dimensions(width, height)
        output_size = _scaled_size(width, height, target)
        image = image.convert("RGB")
        if image.size != output_size:
            image = image.resize(output_size, Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=85, optimize=True)
        body = output.getvalue()
    if not body or len(body) > _MAX_WORKER_OUTPUT:
        raise ValueError("thumbnail size")
    return {"kind": "image", "width": width, "height": height, "duration_ms": None, "page_count": None}, body


def _av_duration_ms(stream, container) -> int | None:
    duration = None
    if stream.duration is not None and stream.time_base is not None:
        duration = float(stream.duration * stream.time_base)
    elif container.duration is not None:
        duration = float(container.duration / 1_000_000)
    if duration is None or duration < 0:
        return None
    return max(0, round(duration * 1000))


def _worker_video(path: str, target: int | None) -> tuple[dict, bytes]:
    import io
    import av
    from PIL import Image

    with av.open(path, mode="r") as container:
        stream = next((item for item in container.streams if item.type == "video"), None)
        if stream is None:
            raise ValueError("no video stream")
        width, height = int(stream.width), int(stream.height)
        _check_dimensions(width, height)
        duration_ms = _av_duration_ms(stream, container)
        metadata = {"kind": "video", "width": width, "height": height, "duration_ms": duration_ms, "page_count": None}
        if target is None:
            return metadata, b""
        target_seconds = min(1.0, (duration_ms or 0) / 1000)
        if target_seconds > 0:
            container.seek(int(target_seconds / float(stream.time_base)), stream=stream, backward=True)
        frame = next(container.decode(video=stream.index), None)
        if frame is None:
            raise ValueError("no video frame")
        image = frame.to_image().convert("RGB")
        output_size = _scaled_size(image.width, image.height, target)
        if image.size != output_size:
            image = image.resize(output_size, Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=85, optimize=True)
        body = output.getvalue()
    if not body or len(body) > _MAX_WORKER_OUTPUT:
        raise ValueError("thumbnail size")
    return metadata, body


def _worker_audio(path: str) -> tuple[dict, bytes]:
    import av

    with av.open(path, mode="r") as container:
        stream = next((item for item in container.streams if item.type == "audio"), None)
        if stream is None:
            raise ValueError("no audio stream")
        duration_ms = _av_duration_ms(stream, container)
    return {"kind": "audio", "width": None, "height": None, "duration_ms": duration_ms, "page_count": None}, b""


def _worker_pdf(path: str, target: int | None) -> tuple[dict, bytes]:
    import io
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(path)
    try:
        page_count = len(document)
        if page_count < 1:
            raise ValueError("empty pdf")
        page = document[0]
        try:
            page_width, page_height = page.get_size()
            width, height = max(1, round(page_width)), max(1, round(page_height))
            metadata = {"kind": "pdf", "width": width, "height": height, "duration_ms": None, "page_count": page_count}
            if target is None:
                return metadata, b""
            scale = min(1.0, target / max(page_width, page_height), MAX_SIDE / max(page_width, page_height))
            bitmap = page.render(scale=scale, rev_byteorder=True)
            image = bitmap.to_pil().convert("RGB")
            _check_dimensions(image.width, image.height)
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=85, optimize=True)
            body = output.getvalue()
        finally:
            page.close()
    finally:
        document.close()
    if not body or len(body) > _MAX_WORKER_OUTPUT:
        raise ValueError("thumbnail size")
    return metadata, body


if __name__ == "__main__" and "--worker" in sys.argv:
    try:
        fd = int(sys.argv[sys.argv.index("--fd") + 1])
        kind = sys.argv[sys.argv.index("--kind") + 1]
        width = int(sys.argv[sys.argv.index("--width") + 1]) if "--width" in sys.argv else None
        _worker_main(fd, kind, width)
    except BaseException:
        sys.stdout.buffer.write(b'{"ok":false}\n')
