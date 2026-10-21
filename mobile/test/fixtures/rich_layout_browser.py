"""Run actual App renderers with RN Web layout; no device or existing service is used."""

import asyncio
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

    class Page(BaseHTTPRequestHandler):
        def do_GET(self):
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
