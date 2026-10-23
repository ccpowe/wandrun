"""Image fetch security boundaries exercised against local HTTP and TLS peers."""

import asyncio
import io
import os
import socket
import ssl
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import aiohttp.connector
from aiohttp import web
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from PIL import Image, PngImagePlugin

from wandrun.gateway import rich_media
from wandrun.gateway.rich_media import ImageProxy, MediaCache, MediaData, MediaError


def image_bytes(fmt="PNG", *, size=(12, 8), alpha=False, metadata=False):
    image = Image.new("RGBA" if alpha else "RGB", size, (255, 30, 45, 140) if alpha else (255, 30, 45))
    output = io.BytesIO()
    options = {}
    if metadata and fmt == "PNG":
        info = PngImagePlugin.PngInfo()
        info.add_text("Comment", "SECRET-METADATA")
        options["pnginfo"] = info
        options["icc_profile"] = b"SECRET-METADATA"
        exif = Image.Exif()
        exif[0x010E] = "SECRET-METADATA"
        options["exif"] = exif
    if metadata and fmt == "JPEG":
        exif = Image.Exif()
        exif[0x010E] = "SECRET-METADATA"
        options["exif"] = exif
    image.save(output, format=fmt, **options)
    return output.getvalue()


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = MediaCache(self.root)
        self.value = MediaData(b"x" * 300, "image/png", 3, 2)

    def test_startup_expiry_and_corrupt_or_abandoned_objects(self):
        with patch.object(rich_media.time, "time", return_value=1_000_000):
            self.cache.put("image-v1-old", self.value)
        (self.root / ".part-abandoned").write_bytes(b"unpublished")
        (self.root / "image-v1-corrupt").write_bytes(b"{broken\npartial")
        with patch.object(rich_media.time, "time", return_value=1_000_000 + rich_media.CACHE_AGE):
            cache = MediaCache(self.root)
            self.assertIsNone(cache.get("image-v1-old"))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_shared_size_budget_and_lru(self):
        with patch.object(rich_media, "CACHE_BYTES", 1050):
            self.cache.put("image-v1-a", self.value)
            self.cache.put("favicon-v1-b", self.value)
            # Deliberate access order, not creation time, controls the eviction.
            old = time.time() - 100
            os.utime(self.root / "image-v1-a", (old, old))
            self.assertEqual(self.cache.get("image-v1-a"), self.value)
            self.cache.put("image-v1-c", self.value)
            self.assertEqual(self.cache.get("image-v1-a"), self.value)
            self.assertIsNone(self.cache.get("favicon-v1-b"))
            self.assertEqual(self.cache.get("image-v1-c"), self.value)
            self.assertLessEqual(sum(path.stat().st_size for path in self.root.iterdir()), 1050)

    def test_incomplete_or_tampered_data_is_not_returned(self):
        self.cache.put("image-v1-a", self.value)
        path = self.root / "image-v1-a"
        with path.open("ab") as file:
            file.write(b"tamper")
        self.assertIsNone(self.cache.get("image-v1-a"))
        self.assertFalse(path.exists())

    def test_favicon_failure_namespace_and_integrity(self):
        key = rich_media._favicon_cache_key("example.test")
        failure = MediaError(404, "favicon_not_found", "网站没有可用图标")
        with self.assertRaises(ValueError):
            self.cache.put_failure("image-v1-old", failure)
        self.cache.put_failure(key, failure)
        with self.assertRaises(MediaError) as cached:
            self.cache.get(key)
        self.assertEqual(cached.exception.code, "favicon_not_found")
        self.cache._publish(key, {
            "fetched": time.time(), "error": failure.code, "status": 502,
        }, b"")
        self.assertIsNone(self.cache.get(key))


class ImageProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache_root = Path(self.temp.name) / "cache"
        self.proxy = ImageProxy(MediaCache(self.cache_root))
        self.handlers = {}
        self.hits = []
        self.dns_calls = []
        self.connections = []
        self.answers = ["8.8.8.8"]
        self.rebind_after_first = False
        self.release = asyncio.Event()
        self.started = asyncio.Event()
        app = web.Application()
        app.router.add_get("/{name:.*}", self.dispatch)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        self.port = self.site._server.sockets[0].getsockname()[1]
        private_key = ec.generate_private_key(ec.SECP256R1())
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "www.google.com")])
        now = datetime.now(timezone.utc)
        certificate = (x509.CertificateBuilder()
                       .subject_name(subject).issuer_name(subject)
                       .public_key(private_key.public_key())
                       .serial_number(x509.random_serial_number())
                       .not_valid_before(now - timedelta(days=1))
                       .not_valid_after(now + timedelta(days=1))
                       .sign(private_key, hashes.SHA256()))
        cert_path = Path(self.temp.name) / "peer.crt"
        key_path = Path(self.temp.name) / "peer.key"
        cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(private_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption()))
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert_path, key_path)
        self.tls_site = web.TCPSite(self.runner, "127.0.0.1", 0, ssl_context=context)
        await self.tls_site.start()
        self.tls_port = self.tls_site._server.sockets[0].getsockname()[1]
        # The local TLS peer is self-signed; only certificate verification is
        # disabled in tests, after production DNS/public-address validation.
        connector = aiohttp.TCPConnector
        self.tls_patch = patch.object(rich_media.aiohttp, "TCPConnector",
                                      side_effect=lambda **kw: connector(ssl=False, **kw))
        self.tls_patch.start()
        self.addCleanup(self.tls_patch.stop)
        self.loop = asyncio.get_running_loop()
        self.original_connect = aiohttp.connector.aiohappyeyeballs.start_connection
        self.dns_patch = patch.object(self.loop, "getaddrinfo", self.fake_dns)
        self.connect_patch = patch("aiohttp.connector.aiohappyeyeballs.start_connection", self.reroute_socket)
        self.dns_patch.start()
        self.connect_patch.start()
        self.addCleanup(self.dns_patch.stop)
        self.addCleanup(self.connect_patch.stop)

    async def asyncTearDown(self):
        self.release.set()
        await self.proxy.aclose()
        await self.runner.cleanup()

    def url(self, name="picture.jpg", host="example.test"):
        return f"http://{host}/{name}"

    async def dispatch(self, request):
        name = request.match_info["name"]
        self.assertEqual(request.headers.get("User-Agent"), rich_media.USER_AGENT)
        self.hits.append((name, request.headers.get("Host"), request.headers.get("Cookie")))
        return await self.handlers[name](request)

    async def fake_dns(self, host, port, *, type):
        self.dns_calls.append((host, port, type))
        answers = ["127.0.0.1"] if self.rebind_after_first and len(self.dns_calls) > 1 else self.answers
        return [(socket.AF_INET6 if ":" in ip else socket.AF_INET,
                 socket.SOCK_STREAM, socket.IPPROTO_TCP, "",
                 (ip, port, 0, 0) if ":" in ip else (ip, port)) for ip in answers]

    async def reroute_socket(self, *args, **kwargs):
        addresses = kwargs["addr_infos"]
        self.connections.extend(info[4][0] for info in addresses)
        # Only the test transport is diverted to localhost. Production receives
        # exactly the original pinned, policy-checked address list.
        port = self.tls_port if addresses[0][4][1] == 443 else self.port
        kwargs["addr_infos"] = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "",
                                 ("127.0.0.1", port))]
        return await self.original_connect(*args, **kwargs)

    async def assert_error(self, url, code):
        with self.assertRaises(MediaError) as failure:
            await self.proxy.get(url)
        self.assertEqual(failure.exception.code, code)
        self.assertNotIn(url, str(failure.exception))

    async def test_wikimedia_preview_and_original_cache_identity(self):
        original = "wikipedia/commons/2/23/Hall_%282024%29.jpg"
        thumbnail = "wikipedia/commons/thumb/2/23/Hall_(2024).jpg/1280px-Hall_(2024).jpg"

        async def picture(request):
            self.assertEqual(request.query["source"], "message")
            return web.Response(body=image_bytes("JPEG", size=(1280, 853)))

        self.handlers[thumbnail] = picture
        url = self.url(original, "upload.wikimedia.org") + "?source=message"
        result = await self.proxy.get(url)
        self.assertEqual((result.mime, result.width, result.height), ("image/jpeg", 1280, 853))
        self.assertEqual(await self.proxy.get(url), result)
        self.assertEqual([hit[0] for hit in self.hits], [thumbnail])
        self.assertEqual([path.name for path in self.proxy.cache.root.iterdir()],
                         [rich_media._image_cache_key(url)])

    async def test_wikimedia_unavailable_preview_falls_back_with_limits(self):
        for status, oversized in ((400, False), (404, False), (503, True)):
            with self.subTest(status=status):
                original = f"wikipedia/commons/a/ab/Small{status}.jpg"
                thumbnail = f"wikipedia/commons/thumb/a/ab/Small{status}.jpg/1280px-Small{status}.jpg"

                async def unavailable(request):
                    return web.Response(status=status)

                async def picture(request):
                    return web.Response(body=image_bytes(size=(8193, 1) if oversized else (12, 8)))

                self.handlers.update({thumbnail: unavailable, original: picture})
                url = self.url(original, "upload.wikimedia.org")
                if oversized:
                    await self.assert_error(url, "media_too_large")
                else:
                    result = await self.proxy.get(url)
                    self.assertEqual((result.width, result.height), (12, 8))
                self.assertEqual([hit[0] for hit in self.hits[-2:]], [thumbnail, original])

    async def test_existing_thumbnail_and_other_host_are_not_rewritten(self):
        paths = (
            ("upload.wikimedia.org", "wikipedia/commons/thumb/a/ab/X.jpg/640px-X.jpg"),
            ("example.test", "wikipedia/commons/a/ab/X.jpg"),
        )
        async def picture(request):
            return web.Response(body=image_bytes())

        for host, path in paths:
            self.handlers[path] = picture
            result = await self.proxy.get(self.url(path, host))
            self.assertEqual((result.width, result.height), (12, 8))
        self.assertEqual([(hit[1], hit[0]) for hit in self.hits], list(paths))

    async def test_wikimedia_svg_preview_is_rasterized(self):
        path = "wikipedia/commons/thumb/a/ab/X.svg/1280px-X.svg.png"

        async def picture(request):
            return web.Response(body=image_bytes(alpha=True), content_type="image/png")

        self.handlers[path] = picture
        urls = [
            self.url(f"wikipedia/commons/a/ab/{filename}", "upload.wikimedia.org")
            for filename in ("X.svg", "X%2Esvg", "X.s%76g")
        ]
        for url in urls:
            with self.subTest(url=url):
                result = await self.proxy.get(url)
                self.assertEqual((result.mime, result.width, result.height), ("image/png", 12, 8))
                self.assertEqual(await self.proxy.get(url), result)
        self.assertEqual([hit[0] for hit in self.hits], [path] * len(urls))
        self.assertEqual(
            {entry.name for entry in self.proxy.cache.root.iterdir()},
            {rich_media._image_cache_key(url) for url in urls},
        )

    def test_wikimedia_thumbnail_keeps_reserved_escapes_in_one_segment(self):
        url = self.url("wikipedia/commons/a/ab/A%2FB%2Esvg", "upload.wikimedia.org")
        self.assertEqual(
            rich_media._wikimedia_thumbnail(url),
            self.url(
                "wikipedia/commons/thumb/a/ab/A%2FB%2Esvg/1280px-A%2FB%2Esvg.png",
                "upload.wikimedia.org",
            ),
        )

    async def test_wikimedia_preview_redirect_revalidates_dns_without_fallback(self):
        path = "wikipedia/commons/thumb/a/ab/X.jpg/1280px-X.jpg"

        async def redirect(request):
            return web.Response(status=302, headers={"Location": self.url("destination")})

        self.handlers[path] = redirect
        self.rebind_after_first = True
        await self.assert_error(
            self.url("wikipedia/commons/a/ab/X.jpg", "upload.wikimedia.org"),
            "unsafe_media_address",
        )
        self.assertEqual([hit[0] for hit in self.hits], [path])
        self.assertEqual(self.connections, ["8.8.8.8"])
        self.assertEqual([call[0] for call in self.dns_calls],
                         ["upload.wikimedia.org", "example.test"])

    async def test_wikimedia_fallback_revalidates_dns(self):
        path = "wikipedia/commons/thumb/a/ab/X.jpg/1280px-X.jpg"

        async def unavailable(request):
            return web.Response(status=404)

        self.handlers[path] = unavailable
        self.rebind_after_first = True
        await self.assert_error(
            self.url("wikipedia/commons/a/ab/X.jpg", "upload.wikimedia.org"),
            "unsafe_media_address",
        )
        self.assertEqual([hit[0] for hit in self.hits], [path])
        self.assertEqual(self.connections, ["8.8.8.8"])

    def test_shared_redirect_validator_blocks_downgrade_credentials_and_controls(self):
        current, _, _ = rich_media._parse_url("https://example.test/page")
        for location in ("http://example.test/unsafe", "//user:pass@example.test/image",
                         "file:///etc/passwd", "/safe\nHost:localhost",
                         "http://127.0.0.1/private"):
            with self.subTest(location=location), self.assertRaises(MediaError):
                rich_media._redirect_target(current, location)
        self.assertEqual(rich_media._redirect_target(current, "/safe"),
                         "https://example.test/safe")

    async def test_literal_and_ambiguous_host_rejected_before_connection(self):
        for url in (
            "http://127.0.0.1/a", "http://10.0.0.1/a", "http://[::1]/a",
            "http://[::ffff:8.8.8.8]/a", "http://[64:ff9b::7f00:1]/a",
            "http://100.64.0.1/a", "http://224.0.0.1/a", "http://127.1/a",
            "http://2130706433/a", "http://0x7f000001/a", "http://user:pw@example.test/a",
            "http://example.test:8080/a", "http://example.test:0/a",
            "http://example.test\\@8.8.8.8/a", "http://example.test/a#fragment",
            "http://[fe80::1%25eth0]/a", "file:///etc/passwd",
        ):
            with self.subTest(url=url):
                with self.assertRaises(MediaError):
                    await self.proxy.get(url)
        self.assertEqual(self.connections, [])
        self.assertEqual(self.dns_calls, [])

    async def test_all_dns_answers_fail_closed_including_mapped_address(self):
        for addresses in (["8.8.8.8", "10.0.0.2"], ["::ffff:8.8.8.8"],
                          ["64:ff9b::808:808"], ["100.64.1.1"]):
            with self.subTest(addresses=addresses):
                self.answers = addresses
                await self.assert_error(self.url(), "unsafe_media_address")
        self.assertEqual(self.connections, [])

    async def test_rebinding_cannot_trigger_second_dns_lookup_and_host_is_preserved(self):
        async def picture(request):
            return web.Response(body=image_bytes("PNG"), content_type="text/html",
                                headers={"Set-Cookie": "secret=cookie"})

        self.handlers["fake.jpg"] = picture
        self.rebind_after_first = True
        url = self.url("fake.jpg") + "?signature=DO-NOT-LEAK"
        result = await self.proxy.get(url)
        self.assertEqual((result.width, result.height), (12, 8))
        self.assertEqual(result.mime, "image/jpeg")  # opaque pixels re-encoded, not a .jpg guess
        self.assertEqual(self.connections, ["8.8.8.8"])
        self.assertEqual(self.dns_calls, [("example.test", 80, socket.SOCK_STREAM)])
        self.assertEqual(self.hits, [("fake.jpg", "example.test", None)])
        self.answers = ["127.0.0.1"]
        self.assertEqual(await self.proxy.get(url), result)  # cached, no new DNS
        self.assertEqual(len(self.dns_calls), 1)
        self.assertEqual([path.name for path in self.proxy.cache.root.iterdir()],
                         [rich_media._image_cache_key(url)])
        self.assertNotIn("DO-NOT-LEAK", next(self.proxy.cache.root.iterdir()).name)

    async def test_redirect_revalidates_target_and_never_connects_private(self):
        async def redirect(request):
            return web.Response(status=302, headers={"Location": "http://127.0.0.1/private"})

        self.handlers["redirect"] = redirect
        await self.assert_error(self.url("redirect"), "unsafe_media_address")
        self.assertEqual(self.connections, ["8.8.8.8"])
        self.assertEqual(len(self.hits), 1)

    async def test_redirect_limit_and_cookie_isolation(self):
        for i in range(4):
            async def redirect(request, destination=(i + 1) % 4):
                self.assertIsNone(request.headers.get("Cookie"))
                return web.Response(status=302, headers={
                    "Location": f"/hop{destination}", "Set-Cookie": "unsafe=secret",
                })
            self.handlers[f"hop{i}"] = redirect
        await self.assert_error(self.url("hop0"), "media_redirect")
        self.assertEqual(len(self.hits), 4)
        self.assertEqual(len(self.dns_calls), 4)

    async def test_stream_limit_and_slow_trickle_use_total_deadline(self):
        async def declared(request):
            return web.Response(body=b"x" * 2048)

        async def streaming(request):
            response = web.StreamResponse()
            await response.prepare(request)
            await response.write(b"x" * 1000)
            await response.write(b"x" * 1100)
            return response

        async def slow(request):
            response = web.StreamResponse()
            await response.prepare(request)
            self.started.set()
            await self.release.wait()
            return response

        self.handlers.update(declared=declared, streaming=streaming, slow=slow)
        with patch.object(rich_media, "MAX_BYTES", 2000):
            await self.assert_error(self.url("declared"), "media_too_large")
            await self.assert_error(self.url("streaming"), "media_too_large")
        real_timeout = asyncio.timeout
        with patch.object(rich_media.asyncio, "timeout", side_effect=lambda seconds: real_timeout(0.1 if seconds == 15 else seconds)):
            await self.assert_error(self.url("slow"), "media_timeout")
        self.assertTrue(self.started.is_set())
        self.release.set()

    async def test_ico_rejected_for_explicit_images(self):
        async def icon(request):
            return web.Response(body=image_bytes("ICO", size=(32, 32)))

        self.handlers["icon"] = icon
        await self.assert_error(self.url("icon"), "unsupported_media")


    async def test_animation_html_svg_and_oversize_dimensions_rejected(self):
        frame = Image.new("RGB", (12, 8), "red")
        second = Image.new("RGB", (12, 8), "blue")
        animation = io.BytesIO()
        frame.save(animation, format="WEBP", save_all=True, append_images=[second], duration=100)
        samples = {
            "html": b"<html><img src=secret></html>",
            "svg": b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            "animated": animation.getvalue(),
            "huge": image_bytes(size=(8193, 1)),
        }
        for name, body in samples.items():
            async def reply(request, payload=body):
                return web.Response(body=payload, content_type="image/png")
            self.handlers[name] = reply
            await self.assert_error(self.url(name), "media_too_large" if name == "huge" else "unsupported_media")
        self.assertEqual(list(self.cache_root.iterdir()), [])

    async def test_metadata_stripped_and_alpha_preserved(self):
        samples = {
            "jpeg": image_bytes("JPEG", metadata=True),
            "png": image_bytes("PNG", alpha=True, metadata=True),
            "webp": image_bytes("WEBP"),
        }
        for name, body in samples.items():
            async def reply(request, payload=body):
                return web.Response(body=payload, content_type="application/octet-stream")
            self.handlers[name] = reply
            result = await self.proxy.get(self.url(name))
            self.assertNotIn(b"SECRET-METADATA", result.data)
            with Image.open(io.BytesIO(result.data)) as cleaned:
                self.assertNotIn("exif", cleaned.info)
                self.assertNotIn("Comment", cleaned.info)
                self.assertNotIn("icc_profile", cleaned.info)
                self.assertEqual(cleaned.size, (12, 8))
                self.assertEqual(cleaned.format, "PNG" if name == "png" else "JPEG")
                if name == "png":
                    self.assertEqual(cleaned.mode, "RGBA")

    async def test_distinct_downloads_use_only_two_active_slots(self):
        two_started = asyncio.Event()

        async def pending(request):
            if len(self.hits) == 2:
                two_started.set()
            await self.release.wait()
            return web.Response(body=image_bytes())

        for name in ("one", "two", "three"):
            self.handlers[name] = pending
        tasks = [asyncio.create_task(self.proxy.get(self.url(name)))
                 for name in ("one", "two", "three")]
        try:
            await asyncio.wait_for(two_started.wait(), 2)
            self.assertEqual(len(self.hits), 2)
        finally:
            self.release.set()
            await asyncio.gather(*tasks)
        self.assertEqual(len(self.hits), 3)

    async def test_concurrent_same_url_collapses_and_close_cancels_holders(self):
        async def pending(request):
            self.started.set()
            await self.release.wait()
            return web.Response(body=image_bytes())

        self.handlers["pending"] = pending
        first = asyncio.create_task(self.proxy.get(self.url("pending")))
        second = asyncio.create_task(self.proxy.get(self.url("pending")))
        await asyncio.wait_for(self.started.wait(), 2)
        self.assertEqual(len(self.hits), 1)
        await self.proxy.aclose()
        for task in (first, second):
            with self.assertRaises(asyncio.CancelledError):
                await task
        await self.assert_error(self.url("pending"), "media_unavailable")
        self.assertEqual(self.proxy._jobs, {})

    async def assert_favicon_error(self, url, code):
        with self.assertRaises(MediaError) as failure:
            await self.proxy.get_favicon(url)
        self.assertEqual(failure.exception.code, code)
        self.assertNotIn(url, str(failure.exception))

    async def test_favicon_host_only_google_request_and_shared_cache(self):
        async def icon(request):
            self.assertEqual(request.headers["Host"], "www.google.com")
            self.assertEqual(request.path, "/s2/favicons")
            self.assertEqual(dict(request.query), {"domain": "sub.example.org", "sz": "128"})
            self.assertNotIn("SECRET", request.raw_path)
            return web.Response(body=image_bytes("PNG", metadata=True))

        self.handlers["s2/favicons"] = icon
        first = "https://Us%65r:Pass@SuB.Example.Org:8443/private/SECRET?q=SECRET#SECRET"
        result = await self.proxy.get_favicon(first)
        self.assertEqual((result.width, result.height), (12, 8))
        self.assertNotIn(b"SECRET-METADATA", result.data)
        self.assertEqual(await self.proxy.get_favicon("http://sub.example.org/other"), result)
        self.assertEqual(await self.proxy.get_favicon("https://SUB.EXAMPLE.ORG./other"), result)
        self.assertEqual(self.dns_calls, [("www.google.com", 443, socket.SOCK_STREAM)])
        self.assertEqual([hit[0] for hit in self.hits], ["s2/favicons"])
        self.assertEqual([path.name for path in self.proxy.cache.root.iterdir()],
                         [rich_media._favicon_cache_key("sub.example.org")])

    async def test_idna_and_query_injection_cannot_escape_domain_parameter(self):
        async def icon(request):
            self.assertEqual(dict(request.query),
                             {"domain": "xn--bcher-kva.example", "sz": "128"})
            return web.Response(body=image_bytes())

        self.handlers["s2/favicons"] = icon
        await self.proxy.get_favicon("https://BÜCHER.example:8080/path?domain=attacker&sz=1")
        self.assertEqual(len(self.hits), 1)
        self.assertEqual([call[0] for call in self.dns_calls], ["www.google.com"])

    def test_idna2008_keeps_distinct_hostname_identity(self):
        self.assertEqual(rich_media._favicon_host("https://faß.de/path?private=value"),
                         "xn--fa-hia.de")
        self.assertEqual(rich_media._favicon_host("https://fass.de/path"), "fass.de")

    async def test_source_ip_literals_are_data_not_destinations(self):
        observed = []

        async def icon(request):
            observed.append(dict(request.query))
            return web.Response(body=image_bytes())

        self.handlers["s2/favicons"] = icon
        for source, host in (("http://127.0.0.1:8765/private", "127.0.0.1"),
                             ("https://[::1]:8443/private", "::1")):
            await self.proxy.get_favicon(source)
            self.assertEqual(observed[-1], {"domain": host, "sz": "128"})
        self.assertEqual([call[0] for call in self.dns_calls],
                         ["www.google.com", "www.google.com"])

    async def test_favicon_404_image_body_never_decoded_and_failure_expires(self):
        async def missing(request):
            return web.Response(status=404, body=image_bytes(), content_type="image/png")

        self.handlers["s2/favicons"] = missing
        with patch.object(rich_media, "_decode", side_effect=AssertionError("404 decoded")):
            await self.assert_favicon_error("https://example.org/one", "favicon_not_found")
            await self.assert_favicon_error("http://example.org/other", "favicon_not_found")
            self.assertEqual(len(self.hits), 1)
            now = time.time()
            with patch.object(rich_media.time, "time", return_value=now + rich_media.FAILURE_AGE + 1):
                await self.assert_favicon_error("https://example.org/next", "favicon_not_found")
        self.assertEqual(len(self.hits), 2)

    async def test_favicon_success_persists_30_days_and_failure_categories_cache(self):
        async def icon(request):
            return web.Response(body=image_bytes())

        self.handlers["s2/favicons"] = icon
        result = await self.proxy.get_favicon("https://example.org")
        await self.proxy.aclose()
        self.proxy = ImageProxy(MediaCache(self.cache_root))
        self.assertEqual(await self.proxy.get_favicon("https://example.org/again"), result)
        self.assertEqual(len(self.hits), 1)
        now = time.time()
        with patch.object(rich_media.time, "time", return_value=now + rich_media.CACHE_AGE + 1):
            await self.proxy.get_favicon("https://example.org/new")
        self.assertEqual(len(self.hits), 2)

        async def unavailable(request):
            return web.Response(status=503)

        self.handlers["s2/favicons"] = unavailable
        await self.assert_favicon_error("https://failure.example", "media_unavailable")
        await self.assert_favicon_error("https://failure.example/else", "media_unavailable")
        self.assertEqual(len(self.hits), 3)

    async def test_favicon_ico_is_cached_failure(self):
        async def unsupported(request):
            return web.Response(body=image_bytes("ICO", size=(32, 32)),
                                content_type="image/x-icon")

        self.handlers["s2/favicons"] = unsupported
        await self.assert_favicon_error("https://icons.example", "unsupported_media")
        await self.assert_favicon_error("http://icons.example/other", "unsupported_media")
        self.assertEqual(len(self.hits), 1)

    async def test_favicon_redirect_limit_is_four_real_sends(self):
        async def redirect(request):
            hop = int(request.path.rsplit("/", 1)[-1]) if request.path.startswith("/hop/") else 0
            return web.Response(status=302, headers={"Location": f"/hop/{hop + 1}"})

        self.handlers["s2/favicons"] = redirect
        for hop in range(1, 4):
            self.handlers[f"hop/{hop}"] = redirect
        await self.assert_favicon_error("https://redirect.example", "media_redirect")
        self.assertEqual([hit[0] for hit in self.hits],
                         ["s2/favicons", "hop/1", "hop/2", "hop/3"])

    async def test_favicon_redirect_to_gstatic_revalidates_and_rejects_private(self):
        async def redirect(request):
            return web.Response(status=302, headers={
                "Location": "https://favicon.gstatic.com/icon.png"})

        async def icon(request):
            return web.Response(body=image_bytes())

        self.handlers.update({"s2/favicons": redirect, "icon.png": icon})
        result = await self.proxy.get_favicon("https://example.org")
        self.assertEqual(result.width, 12)
        self.assertEqual([call[0] for call in self.dns_calls],
                         ["www.google.com", "favicon.gstatic.com"])
        self.assertEqual(self.connections, ["8.8.8.8", "8.8.8.8"])

        async def private_redirect(request):
            return web.Response(status=302, headers={"Location": "https://127.0.0.1/private"})

        self.handlers["s2/favicons"] = private_redirect
        await self.assert_favicon_error("https://other.example", "unsafe_media_address")
        self.assertEqual([hit[0] for hit in self.hits],
                         ["s2/favicons", "icon.png", "s2/favicons"])

    async def test_favicon_singleflight_and_cancelled_job_is_not_cached(self):
        async def pending(request):
            self.started.set()
            await self.release.wait()
            return web.Response(body=image_bytes())

        self.handlers["s2/favicons"] = pending
        first = asyncio.create_task(self.proxy.get_favicon("https://same.example/one"))
        second = asyncio.create_task(self.proxy.get_favicon("http://same.example/two"))
        await asyncio.wait_for(self.started.wait(), 2)
        self.assertEqual(len(self.hits), 1)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.release.set()
        self.assertEqual((await second).width, 12)
        self.started.clear()
        self.release.clear()
        third = asyncio.create_task(self.proxy.get_favicon("https://cancel.example"))
        await asyncio.wait_for(self.started.wait(), 2)
        third.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await third
        self.assertIsNone(self.proxy.cache.get(rich_media._favicon_cache_key("cancel.example")))

    async def test_favicon_rejects_ambiguous_hosts_without_source_dns(self):
        for url in ("file:///etc/passwd", "https://example.com:bad/",
                    "https://example..com/", "https://exa%6dple.com/",
                    "https://foo@bar@baz.example/"):
            with self.subTest(url=url):
                await self.assert_favicon_error(url, "invalid_media_url")
        self.assertEqual(self.dns_calls, [])

    async def test_decoder_process_is_killed_on_cancellation(self):
        original = asyncio.create_subprocess_exec
        children = []
        started = asyncio.Event()

        async def inert_decoder(*args, **kwargs):
            child = await original(sys.executable, "-c", "import time; time.sleep(30)",
                                   stdin=kwargs["stdin"], stdout=kwargs["stdout"], stderr=kwargs["stderr"])
            children.append(child)
            started.set()
            return child

        with patch.object(rich_media.asyncio, "create_subprocess_exec", inert_decoder):
            task = asyncio.create_task(rich_media._decode(b"tiny"))
            await asyncio.wait_for(started.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertIsNotNone(children[0].returncode)
