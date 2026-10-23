"""Run actual App renderers with RN Web layout; no device or existing service is used."""

import asyncio
import base64
import io
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

from wandrun.integrations.browser_dev import ChromeDev
from wandrun.runtime.browser_cdp import CDPSocket
from PIL import Image


async def measure(cdp_url, url):
    with urlopen(Request(f"{cdp_url}/json/new?about:blank", method="PUT")) as response:
        target = json.load(response)
    client = CDPSocket(target["webSocketDebuggerUrl"])
    await client.open(proxy=False)
    try:
        # Keep the outer viewport stable while content containers resize. A new
        # browser scrollbar would reset RN Web's emulated fontScale to 1.
        await client.call("Emulation.setDeviceMetricsOverride", {
            "width": 1800, "height": 1200, "deviceScaleFactor": 1, "mobile": False,
        })
        await client.call("Page.navigate", {"url": url})
        async with asyncio.timeout(90):
            while True:
                ready = await client.call("Runtime.evaluate", {"expression": "typeof runLayoutCase === 'function'"})
                if ready["result"].get("value"):
                    break
                await asyncio.sleep(0.05)
        results = []
        for kind, widths, scales in [
            ("metrics", [320, 360, 390, 768, 320], [1]),
            ("labels", [320, 360, 390, 768], [1, 2]),
            ("extreme", [320], [2]),
            ("heading", [320], [1]),
        ]:
            for scale in scales:
                for width in widths:
                    result = await client.call("Runtime.evaluate", {
                        "expression": f"runLayoutCase({json.dumps(kind)}, {width}, {scale})",
                        "awaitPromise": True, "returnByValue": True,
                    }, timeout=20)
                    if "exceptionDetails" in result:
                        raise AssertionError(result["exceptionDetails"])
                    results.append(result["result"]["value"])
        for kind in ("tabs", "tabs-scroll", "source-grid", "source-nested"):
            for width in (328, 380, 640):
                result = await client.call("Runtime.evaluate", {
                    "expression": f"runReviewLayout({json.dumps(kind)}, {width})",
                    "awaitPromise": True, "returnByValue": True,
                }, timeout=20)
                if "exceptionDetails" in result:
                    raise AssertionError(result["exceptionDetails"])
                results.append(result["result"]["value"])
        for kind in ("link-grid", "link-card", "link-stack", "link-mixed", "link-list"):
            for width in (328, 358, 640):
                result = await client.call("Runtime.evaluate", {
                    "expression": f"runLinkLayout({json.dumps(kind)}, {width})",
                    "awaitPromise": True, "returnByValue": True,
                }, timeout=20)
                if "exceptionDetails" in result:
                    raise AssertionError(result["exceptionDetails"])
                results.append(result["result"]["value"])
        for width in (104, 114, 180, 358):
            result = await client.call("Runtime.evaluate", {
                "expression": f"runLinkTitleLayout({width})",
                "awaitPromise": True, "returnByValue": True,
            }, timeout=20)
            if "exceptionDetails" in result:
                raise AssertionError(result["exceptionDetails"])
            results.append(result["result"]["value"])
        result = await client.call("Runtime.evaluate", {
            "expression": "runLinkThumbnailLayout()", "awaitPromise": True, "returnByValue": True,
        }, timeout=20)
        if "exceptionDetails" in result:
            raise AssertionError(result["exceptionDetails"])
        thumbnails = result["result"]["value"]
        capture = await client.call("Page.captureScreenshot", {"format": "png"})
        with Image.open(io.BytesIO(base64.b64decode(capture["data"]))) as screenshot:
            pixels = screenshot.convert("RGBA")
            thumbnails["explicitEdgeColors"] = [list(pixels.getpixel((round(point["x"]), round(point["y"]))))
                                                for point in thumbnails.pop("explicitSamples")]
        results.append(thumbnails)
        for width, lines in [(320, 4), (390, 4), (320, 80)]:
            result = await client.call("Runtime.evaluate", {
                "expression": f"runChatCodeLayout({width}, {lines})",
                "awaitPromise": True, "returnByValue": True,
            }, timeout=20)
            if "exceptionDetails" in result:
                raise AssertionError(result["exceptionDetails"])
            results.append(result["result"]["value"])
        return results
    finally:
        await client.close()


def main():
    if not shutil.which("Xvfb") or not (shutil.which("google-chrome") or Path("/opt/google/chrome/chrome").is_file()):
        print("Chrome/Xvfb unavailable", file=sys.stderr)
        return 77
    # Node's timeout sends SIGTERM; unwind the owned browser/server contexts too.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    mobile = Path(__file__).resolve().parents[2]
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    bundle = f"http://127.0.0.1:{port}/test/fixtures/rich-layout.web.bundle?platform=web&dev=true&hot=false&lazy=false"
    thumbnails = {}
    output = io.BytesIO()
    Image.new("RGB", (128, 128), (200, 40, 40)).save(output, format="PNG")
    thumbnails["/conversations/thumbnails/messages/7/media/1/one/0"] = (output.getvalue(), 128, 128)
    default_icon = (output.getvalue(), 128, 128)
    wide = Image.new("RGB", (300, 100), (40, 200, 40))
    wide.paste((200, 40, 40), (0, 0, 100, 100))
    wide.paste((40, 60, 200), (200, 0, 300, 100))
    output = io.BytesIO()
    wide.save(output, format="PNG")
    thumbnails["/conversations/thumbnails/messages/7/media/1/two/0"] = (output.getvalue(), 300, 100)

    class Page(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/conversations/"):
                path = self.path.removesuffix("/content")
                authorized = self.headers.get("Authorization") == "Bearer thumbnail-test"
                thumbnail = thumbnails.get(path) if authorized else None
                # Metadata denial must win even if subsequent content bytes are available.
                if authorized and self.path == "/conversations/thumbnails/messages/7/media/1/missing/0/content":
                    thumbnail = default_icon
                image = thumbnail[0] if thumbnail else None
                self.send_response(200 if image else 404 if authorized else 401)
                self.send_header("Content-Type", "image/png" if image and self.path.endswith("/content") else "application/json")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(image if image and self.path.endswith("/content") else json.dumps(
                    {"mime": "image/png", "width": thumbnail[1], "height": thumbnail[2]} if thumbnail else
                    {"error": {"code": "favicon_not_found", "message": "Website icon unavailable"}},
                ).encode())
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(f'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="{bundle}"></script>'.encode())

        def log_message(self, *_args):
            pass

    with tempfile.TemporaryFile() as log:
        metro = subprocess.Popen(
            ["npm", "run", "start", "--", "--port", str(port), "--localhost"], cwd=mobile,
            env={**os.environ, "CI": "1", "EXPO_NO_TELEMETRY": "1"},
            stdout=log, stderr=log, start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if metro.poll() is not None:
                    raise RuntimeError("Metro exited before readiness")
                try:
                    with urlopen(f"http://127.0.0.1:{port}/status", timeout=1) as response:
                        if b"packager-status:running" in response.read():
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                raise TimeoutError("Metro readiness")
            server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with ChromeDev() as chrome:
                    print(json.dumps(asyncio.run(measure(chrome.cdp_url, f"http://127.0.0.1:{server.server_port}/")), ensure_ascii=False))
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
        except BaseException:
            log.seek(0)
            print(log.read().decode(errors="replace")[-6000:], file=sys.stderr)
            raise
        finally:
            os.killpg(metro.pid, signal.SIGTERM)
            try:
                metro.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(metro.pid, signal.SIGKILL)
                metro.wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
