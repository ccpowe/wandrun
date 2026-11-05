#!/usr/bin/env python3
"""Seven Android core chains against one isolated, already-running Expo Go/Metro/gateway.

Run: uv run python mobile/e2e/run.py [group ...] | --list
Required env: ANDROID_SERIAL, E2E_WORKSPACE. Optional: GATEWAY_URL (18785),
GATEWAY_TOKEN (dev), EXPO_URL (8097), E2E_ARTIFACTS, E2E_MANUAL_COMMAND (JSON argv).
Requires agent-device 0.21.16 and fixture_gateway.py for deterministic display content.
Only owned fixture resources are removed. Pairing restores the initial development connection.
The normal foreground guard permits only Expo Go; DocumentsUI has one explicit picker window.
Camera permissions, save/share recipients and the Sources external handoff require timed receipts.
"""
import hashlib
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPConnection, HTTPSConnection
from urllib.error import HTTPError
from ipaddress import ip_address
import json
import os
from pathlib import Path
import subprocess
import sqlite3
from contextlib import closing
import sys
import tempfile
import stat
import time
import threading
from urllib.parse import quote, urlsplit
from uuid import uuid4
from urllib.request import ProxyHandler, Request, build_opener, urlopen

import native_rich
import collaboration
import core
import attachments
import browser_native
import manual_checks
import audio_native


ROOT = Path(__file__).resolve().parent
GROUPS = {
    "chat": "真实聊天、键盘/侧拉/返回、目录短拖拽、委派插话与长摘要滚动",
    "pairing": "真实相机/权限、凭据安装、一次电脑切换、自有令牌撤销与恢复",
    "attachments": "确定性音频拖动/抽屉、系统选 PDF、真实 read_file、原文件交付与人工保存/分享接收",
    "browser": "真实浏览器、Skia 帧、接管触控/输入/横竖布局、交还与关闭",
    "rich": "确定性图表/公式/Mermaid、Sources/Gallery 手势与一次原生主题联动",
    "schedules": "真实工具创建单次定时、真实到点执行、运行记录进入来源对话",
    "image": "真实 generate_image、Agent 附件交付与 App 打开原图",
}



parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("groups", nargs="*", help="Groups in execution order; default: all")
parser.add_argument("--list", action="store_true", help="List groups without touching the phone")
parser.add_argument("--attachment-audio-only", action="store_true",
                    help="Run only the deterministic native audio subflow of attachments; no model or picker.")
options = parser.parse_args()
if options.list:
    for name, coverage in GROUPS.items():
        print(f"{name}: {coverage}")
    sys.exit(0)
unknown = set(options.groups) - GROUPS.keys()
if unknown:
    parser.error("Unknown groups: " + ", ".join(sorted(unknown)))
selected = list(dict.fromkeys(options.groups or GROUPS))
if options.attachment_audio_only and selected != ["attachments"]:
    parser.error("--attachment-audio-only requires exactly the attachments group")
for required in ("ANDROID_SERIAL", "E2E_WORKSPACE"):
    if not os.environ.get(required):
        parser.error(required + " is required; never select a device or reuse a workspace implicitly")

ARTIFACT_DIR = os.environ.get("E2E_ARTIFACTS")
OUT = Path(ARTIFACT_DIR if ARTIFACT_DIR else tempfile.mkdtemp(prefix="wandrun-e2e-")).resolve()
OUT.mkdir(parents=True, exist_ok=True)
GATEWAY = os.environ.get("GATEWAY_URL", "http://127.0.0.1:18785").rstrip("/")
TOKEN = os.environ.get("GATEWAY_TOKEN", "dev")
WORKSPACE = Path(os.environ["E2E_WORKSPACE"]).resolve()
EXPO = os.environ.get("EXPO_URL", "exp://127.0.0.1:8097")
PRESERVE_SYSTEM_THEME = os.environ.get("E2E_PRESERVE_SYSTEM_THEME") == "1"
DISMISS_DEV_WARNINGS = os.environ.get("E2E_DISMISS_DEV_WARNINGS") == "1"
SESSION = "wandrun-regression"
# Repeated runs share the same live device session; evidence remains per-run.
STATE = Path(tempfile.gettempdir()) / ("wandrun-device-" + hashlib.sha256(str(ROOT).encode()).hexdigest()[:12])
ADB = ["adb", "-s", os.environ["ANDROID_SERIAL"]]
AD = ["agent-device", "--state-dir", str(STATE), "--session", SESSION,
      "--platform", "android", "--serial", os.environ["ANDROID_SERIAL"]]
# A coordinator can include service provisioning in the same soft-budget clock.
START = time.monotonic() - max(0, time.time() - float(os.environ.get("E2E_STARTED_AT", time.time())))
LOG = (OUT / "commands.log").open("w")
phone_stopped = False

def set_theme(mode):
    if not PRESERVE_SYSTEM_THEME:
        phone_command([*ADB, "shell", "cmd", "uimode", "night", mode])


def command(args, timeout=120, redactions=()):
    def safe(text):
        for secret in redactions:
            if secret:
                text = text.replace(secret, "[REDACTED]")
        return text

    LOG.write("$ " + safe(" ".join(args)) + "\n")
    LOG.flush()
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    LOG.write(safe(result.stdout + result.stderr) + "\n")
    LOG.flush()
    if result.returncode:
        raise RuntimeError(f"{args[0]} {args[1]} exited {result.returncode}: "
                           + safe(result.stderr or result.stdout))
    return result.stdout

def prepare_reverse():
    """Keep configured phone-to-host endpoints reachable without touching running services."""
    ports = (urlsplit(GATEWAY).port or (443 if GATEWAY.startswith("https:") else 80),
             urlsplit(EXPO).port or 8081)
    report = {"status": "FAIL", "required": {f"tcp:{port}": f"tcp:{port}" for port in ports},
              "repaired": []}
    try:
        before = command([*ADB, "reverse", "--list"], timeout=15)
        report["before"] = before.splitlines()
        mappings = {parts[-2]: parts[-1] for line in before.splitlines()
                    if len(parts := line.split()) >= 2}
        for remote, local in report["required"].items():
            if mappings.get(remote) != local:
                command([*ADB, "reverse", remote, local], timeout=15)
                report["repaired"].append(remote)
        after = command([*ADB, "reverse", "--list"], timeout=15)
        report["after"] = after.splitlines()
        mappings = {parts[-2]: parts[-1] for line in after.splitlines()
                    if len(parts := line.split()) >= 2}
        missing = [f"{remote} -> {local}" for remote, local in report["required"].items()
                   if mappings.get(remote) != local]
        if missing:
            raise RuntimeError("adb reverse missing after recovery: " + ", ".join(missing))
        report["status"] = "PASS"
    except Exception as exc:
        report["error"] = str(exc)
        raise
    finally:
        (run_out / "reverse.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report

def require_expo():
    global phone_stopped
    if phone_stopped:
        raise RuntimeError("Phone operations stopped after losing Expo Go foreground")
    windows = command([*ADB, "shell", "dumpsys", "window"], timeout=15)
    focus = next((line for line in windows.splitlines() if "mCurrentFocus=" in line), "")
    if "com.miui.home/" in focus:
        command([*ADB, "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW",
                 "-d", EXPO, "host.exp.exponent"], timeout=30)
        windows = command([*ADB, "shell", "dumpsys", "window"], timeout=15)
        focus = next((line for line in windows.splitlines() if "mCurrentFocus=" in line), "")
    if "host.exp.exponent/" not in focus:
        phone_stopped = True
        raise RuntimeError("Expo Go is not the focused window; refusing phone operation")


def phone_command(args, timeout=120):
    require_expo()
    return command(args, timeout)


def dismiss_e2e_warning_overlay():
    """Explicit e2e-only UI policy; console warnings/log capture remain untouched."""
    for _ in range(4):
        snapshot = json.loads(command([*AD, "snapshot", "-i", "--json"]))["data"]
        if not any("React Native warning/error overlay detected" in str(item)
                   for item in snapshot.get("warnings", [])):
            return
        labels = [str(node.get("label") or node.get("text") or "") for node in snapshot["nodes"]]
        evidence = OUT / ("dev-warning-overlay-" + uuid4().hex)
        evidence.with_suffix(".json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2))
        command([*AD, "screenshot", str(evidence.with_suffix(".png")), "--json"])
        if any(label in ("Console Error", "Render Error") or label.startswith(
                ("TypeError:", "ReferenceError:", "SyntaxError:", "Invariant Violation:")) for label in labels):
            raise RuntimeError("Development error overlay is not a warning; see " + str(evidence))
        warning = any("Console Warning" == label or any(marker in label for marker in (
            "InteractionManager has been deprecated", "LegendList", "[legend-list]", "[browser-stream]",
        )) for label in labels)
        if not warning:
            raise RuntimeError("Unclassified development overlay; preserve it for review: " + str(evidence))
        LOG.write("E2E-only warning screen dismissed; console retained; evidence: " + str(evidence) + "\n")
        LOG.flush()
        command([*AD, "react-native", "dismiss-overlay", "--json"])
    raise RuntimeError("Development warning overlay did not clear after four observed dismissals")


def ad(*args, timeout=120, redactions=()):
    require_expo()
    if DISMISS_DEV_WARNINGS and args[0] not in ("snapshot", "screenshot"):
        dismiss_e2e_warning_overlay()
    return json.loads(command([*AD, *args, "--json"], timeout, redactions=redactions))["data"]


def dismiss_known_dev_overlay():
    """Dismiss only the observed LegendList LogBox warning, preserving evidence first."""
    if globals().get("DISMISS_DEV_WARNINGS"):
        dismiss_e2e_warning_overlay()
        return
    marker = "[legend-list] No unused container available"
    for _ in range(8):
        nodes = ad("snapshot")["nodes"]
        labels = [str(node.get("label") or node.get("text") or "") for node in nodes]
        expanded = any(label == "Dismiss" for label in labels)
        if expanded:
            # Other warnings/errors can have the same controls; never dismiss them.
            titles = [index for index, label in enumerate(labels) if label == "Console Warning"]
            if any(label == "Console Error" for label in labels) or not titles:
                return
            message = next((label for label in labels[titles[-1] + 1:] if label), "")
            if not message.startswith(marker):
                return
            controls = [node for node in nodes if node.get("label") == "Dismiss" and node.get("hittable")]
            if len(controls) != 1:
                raise RuntimeError("Known LegendList warning has no unique Dismiss control")
            close = controls[0]
            variant = "expanded"
        else:
            warnings = [node for node in nodes if node.get("hittable")
                        and marker in str(node.get("label") or "")]
            if not warnings:
                return
            if len(warnings) != 1:
                raise RuntimeError("Known LegendList warning banner is ambiguous")
            warning = warnings[0]
            controls = [node for node in nodes if node.get("parentIndex") == warning["index"]
                        and node.get("hittable") and not node.get("label")]
            if len(controls) != 1:
                raise RuntimeError("Known LegendList warning close control is ambiguous")
            close = controls[0]
            variant = "collapsed"
        evidence = OUT / ("known-dev-overlay-" + uuid4().hex + ".png")
        ad("screenshot", str(evidence))
        LOG.write(f"Observed visible {variant} LegendList warning; evidence: {evidence}\n")
        LOG.flush()
        ad("press", "@" + close["ref"])
        ad("wait", "stable")
    raise RuntimeError("Known LegendList warning remained after eight explicit dismissals")


def api(path, method="GET", data=None):
    request = Request(
        GATEWAY + path, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    with urlopen(request, timeout=10) as response:
        return json.load(response)

class PairingFixture:
    """Own one device and a loopback-only bridge that observes its exchange response.

    The gateway never reveals a device token again. A short-lived bridge is the only
    way to assert the *actual App-issued* token gets 401 after disconnect without
    adding a token-read endpoint or inspecting secure storage. It neither persists
    the response nor prints requests, credentials, pairing codes or tokens.
    """

    def __init__(self):
        if not os.environ.get("TMPDIR"):
            raise RuntimeError("Pairing regression requires TMPDIR for private transient steps")
        self.tempdir = Path(os.environ["TMPDIR"])
        credential = WORKSPACE / ".wandrun" / "state" / "management.json"
        if stat.S_IMODE(credential.stat().st_mode) & 0o077:
            raise RuntimeError("Gateway management credential is not private")
        details = json.loads(credential.read_text())
        bind_host = details["host"]
        try:
            local_bind = ip_address(bind_host).is_loopback
        except ValueError:
            local_bind = False
        loopback = bind_host if local_bind else "::1" if ":" in bind_host else "127.0.0.1"
        self.admin_url = f"http://[{loopback}]:{int(details['port'])}" if ":" in loopback else (
            f"http://{loopback}:{int(details['port'])}")
        self.management_token = details["token"]
        self.admin_opener = build_opener(ProxyHandler({}))
        self.token = None
        self.device_id = None
        self.code = None
        self.issued_name = None
        self.previous_devices = set()
        self.server = None
        self.thread = None
        self.reverse_port = None

    def admin(self, path, method="GET", data=None):
        request = Request(
            self.admin_url + path, method=method,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Authorization": "Bearer " + self.management_token,
                     "Content-Type": "application/json"},
        )
        with self.admin_opener.open(request, timeout=10) as response:
            return json.load(response) if response.status != 204 else None

    def start(self):
        target = urlsplit(GATEWAY)
        fixture = self

        class Bridge(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *args):
                pass

            def do_GET(self):
                self.forward()

            def do_POST(self):
                self.forward()

            def do_DELETE(self):
                self.forward()

            def forward(self):
                upstream = (HTTPSConnection if target.scheme == "https" else HTTPConnection)(
                    target.hostname, target.port, timeout=30)
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    body = self.rfile.read(size) if size else None
                    headers = {key: value for key, value in self.headers.items()
                               if key.lower() not in ("host", "connection", "content-length",
                                                      "transfer-encoding")}
                    headers["Connection"] = "close"
                    upstream.request(self.command, (target.path.rstrip("/") + self.path),
                                     body=body, headers=headers)
                    response = upstream.getresponse()
                    streaming = response.getheader("Content-Type", "").startswith("text/event-stream")
                    if self.command == "POST" and self.path == "/pairing/exchange" and response.status == 200:
                        payload = response.read()
                        issued = json.loads(payload)
                        fixture.token = issued["token"]
                        fixture.device_id = issued["device_id"]
                    elif not streaming:
                        payload = response.read()
                    self.send_response(response.status)
                    for key, value in response.getheaders():
                        if key.lower() not in ("connection", "transfer-encoding", "keep-alive"):
                            self.send_header(key, value)
                    self.end_headers()
                    if streaming:
                        while chunk := response.read1(65536):
                            self.wfile.write(chunk)
                            self.wfile.flush()
                    else:
                        self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception:
                    # No exception detail: HTTP internals may contain an Authorization header.
                    try:
                        self.send_error(502, "Gateway bridge unavailable")
                    except OSError:
                        pass
                finally:
                    upstream.close()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Bridge)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        port = self.server.server_port
        self.reverse_port = port
        phone_command([*ADB, "reverse", f"tcp:{port}", f"tcp:{port}"], timeout=15)
        return f"http://127.0.0.1:{port}"

    def issue(self, name):
        # The gateway permits one outstanding challenge; issuance invalidates any
        # earlier unredeemed code. Run this group against an isolated gateway.
        self.previous_devices = {item["id"] for item in self.admin("/admin/devices")["devices"]}
        self.issued_name = name
        self.code = self.admin("/admin/pairing-codes", "POST", {"name": name})["code"]

    def assert_paired(self, method):
        if not self.token or not self.device_id:
            raise AssertionError("App exchange was not observed by the private bridge")
        request = Request(GATEWAY + "/connection", headers={"Authorization": "Bearer " + self.token})
        with urlopen(request, timeout=10) as response:
            connection = json.load(response)
        assert connection["device_id"] == self.device_id
        assert connection["pairing_method"] == method
        assert connection["paired_at"]
        return connection

    def assert_revoked(self):
        if not self.token or not self.device_id:
            raise AssertionError("App exchange was not observed by the private bridge")
        request = Request(GATEWAY + "/connection", headers={"Authorization": "Bearer " + self.token})
        deadline = time.monotonic() + 10
        while True:
            try:
                with urlopen(request, timeout=max(0.1, deadline - time.monotonic())) as response:
                    response.read()
            except HTTPError as exc:
                assert exc.code == 401, f"Remote revocation check returned {exc.code}, not 401"
                break
            if time.monotonic() >= deadline:
                raise AssertionError("Local disconnect finished, but the old token still authorizes after 10 seconds")
            time.sleep(max(0, min(0.25, deadline - time.monotonic())))
        devices = self.admin("/admin/devices")["devices"]
        assert any(item["id"] == self.device_id and item["revoked"] for item in devices), (
            "Fixture device was not marked revoked")

    def revoke_owned_device(self):
        if not self.issued_name:
            return
        devices = self.admin("/admin/devices")["devices"]
        # If exchange committed but its response was lost, the one-use challenge's
        # unique device name and pre-issue snapshot still identify only this fixture.
        owned = ([self.device_id] if self.device_id else
                 [item["id"] for item in devices if item["id"] not in self.previous_devices
                  and item["name"] == self.issued_name])
        for item in devices:
            if item["id"] in owned and not item["revoked"]:
                self.admin("/admin/devices/" + quote(item["id"], safe=""), "DELETE")

    def close(self):
        try:
            if self.reverse_port is not None:
                command([*ADB, "reverse", "--remove", f"tcp:{self.reverse_port}"], timeout=15)
        finally:
            if self.server:
                self.server.shutdown()
                self.server.server_close()
                self.thread.join(timeout=5)


def agent_path(identity):
    return "/agents/" + quote(identity, safe="")


def conversation_path(identity):
    return "/conversations/" + quote(identity, safe="")


def create_owned_agent(name, workers=(), **fields):
    # Creation can commit even when its response cannot be read.
    owned_agent_names.add(name)
    response = api("/agents", "POST", {
        "client_id": "e2e-agent-" + uuid4().hex,
        "name": name, "description": "E2E regression fixture",
        "system_prompt": "Follow the user's request.", "workers": list(workers), **fields,
    })
    identity = response["agent"]["id"]
    owned_agents.append(identity)
    return identity


def image_fixture(env):
    """Use an isolated local Agent; require failures to retain the tool's error code."""
    identity = create_owned_agent(
        "E2E image " + run_id,
        system_prompt=(
            "Use generate_image exactly once when asked for an image, then send its returned "
            "path as an attachment to human. Never synthesize an image with code or other tools. "
            "If it fails, immediately send the exact error code, detail and resets_at to human; "
            "do not retry or substitute another image."
        ),
    )
    conversation = api("/conversations", "POST", {"client_id": uuid4().hex, "agent_id": identity})
    fixtures.append(conversation["id"])
    env.update({"IMAGE_AGENT_ID": identity, "IMAGE_CONVERSATION_ID": conversation["id"]})


def await_media_reply(env):
    """Require an actual generated PNG; preserve upstream failure/limit evidence without retry."""
    identity = env["IMAGE_CONVERSATION_ID"]
    deadline = time.monotonic() + 300
    while True:
        events = api(conversation_path(identity) + "/events?limit=200")["events"]
        replies = [event["data"] for event in events if event["type"] == "message.agent"]
        evidence = json.dumps(replies, ensure_ascii=False)
        (OUT / "model-events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2))
        if "image_generation_quota_exhausted" in evidence:
            raise AssertionError("生图额度耗尽（FAIL，不重试）: " + evidence)
        files = [file for reply in replies for file in reply.get("attachments", [])]
        if files:
            assert len(files) == 1, evidence
            file = files[0]
            detail = api("/files/" + quote(file["id"], safe=""))
            assert detail["available"] and detail["media_type"] == "image/png", detail
            assert detail["conversation_id"] == identity, detail
            source = WORKSPACE / "conversations" / identity / file["name"]
            assert source.parent == WORKSPACE / "conversations" / identity, file
            with source.open("rb") as content:
                assert content.read(8) == b"\x89PNG\r\n\x1a\n", "Attachment is not a PNG"
            env.update(IMAGE_FILE_ID=file["id"], IMAGE_FILE_NAME=file["name"])
            return
        failed = any(event["type"] == "turn.failed" for event in events)
        settled = replies and next(row for row in api("/conversations")["conversations"] if row["id"] == identity)["status"] != "working"
        if failed or settled or time.monotonic() >= deadline:
            raise AssertionError(f"生图未交付 PNG 附件; failed={failed}; Agent 回复原文: {evidence}; events={events!r}")
        time.sleep(1)



def cleanup_image_fixture(env):
    """After stopping the owned conversation, remove generated PNGs even if never delivered."""
    identity = env.get("IMAGE_CONVERSATION_ID")
    if identity is None:
        return
    assert identity in fixtures
    assert identity not in {item["id"] for item in api("/conversations")["conversations"]}, (
        "Conversation must stop before image cleanup"
    )
    directory = WORKSPACE / "conversations" / identity
    if not directory.exists():
        return
    assert not directory.is_symlink(), directory
    # generate_image owns generated.png and its collision suffixes. Never recurse or
    # remove arbitrary Agent output; unexpected content causes an explicit failure.
    sources = [path for path in directory.iterdir()
               if path.name == "generated.png" or (
                   path.name.startswith("generated (") and path.name.endswith(").png")
                   and path.name[len("generated ("):-len(").png")].isdigit())]
    with closing(sqlite3.connect(WORKSPACE / ".wandrun" / "state" / "gateway.sqlite")) as db, db:
        for source in sources:
            db.execute("DELETE FROM files WHERE path=?", (str(source),))
            source.unlink()
    directory.rmdir()


def marker_pdf(marker):
    """Build a single-page ASCII PDF with byte-accurate xref offsets; no PDF dependency."""
    stream = f"BT /F1 24 Tf 72 720 Td ({marker}) Tj ET\n".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream",
    ]
    body = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(body))
        body.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(body)
    body.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets[1:]:
        body.extend(f"{offset:010d} 00000 n \n".encode())
    body.extend(f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(body)

def upload_fixture(env):
    """Own one PDF source; its independently random answer is never present in a prompt/name."""
    identity = create_owned_agent("E2E attachments " + run_id, code_mode=False,
        system_prompt="Read the user's attached PDF with read_file and follow the original-file delivery request.")
    root = api("/conversations", "POST", {"client_id": uuid4().hex, "agent_id": identity})["id"]
    fixtures.append(root)
    filename = f"e2e-upload-{run_id}.pdf"
    local = OUT / filename
    marker = "WR-" + uuid4().hex
    local.write_bytes(marker_pdf(marker))
    env.update(UPLOAD_AGENT_ID=identity, UPLOAD_CONVERSATION_ID=root, UPLOAD_NAME=filename,
               PDF_MARKER=marker, UPLOAD_LOCAL_PATH=str(local),
               UPLOAD_DEVICE_PATH="/sdcard/Download/" + filename,
               UPLOAD_PATH=str(WORKSPACE / "conversations" / root / filename))
    phone_command([*ADB, "push", str(local), env["UPLOAD_DEVICE_PATH"]])



def select_upload_document(env):
    """Permit only the system DocumentsUI during this explicit file-picking step.

    The ordinary foreground guard stays strict. No launcher recovery, gestures in
    arbitrary apps, coordinates, or synthetic picker result replaces file selection.
    """
    allowed = ("com.google.android.documentsui/", "com.android.documentsui/")
    deadline = time.monotonic() + 10
    while True:
        windows = command([*ADB, "shell", "dumpsys", "window"], timeout=15)
        focus = next((line for line in windows.splitlines() if "mCurrentFocus=" in line), "")
        if any(package in focus for package in allowed):
            break
        if time.monotonic() >= deadline or (
            "host.exp.exponent/" not in focus and "mCurrentFocus=null" not in focus
        ):
            raise RuntimeError("System document picker did not open: " + focus)
        time.sleep(0.1)

    def picker_command(*args):
        global phone_stopped
        windows = command([*ADB, "shell", "dumpsys", "window"], timeout=15)
        focus = next((line for line in windows.splitlines() if "mCurrentFocus=" in line), "")
        if not any(package in focus for package in allowed):
            phone_stopped = True
            raise RuntimeError("Expected system document picker; refusing phone operation: " + focus)
        return json.loads(command([*AD, *args, "--json"], timeout=30))["data"]

    def press_label(labels, identifier=None):
        deadline = time.monotonic() + 10
        while True:
            nodes = picker_command("snapshot", "-i")["nodes"]
            for node in nodes:
                label = node.get("label", node.get("text", ""))
                if label in labels and (identifier is None or node.get("identifier") == identifier):
                    picker_command("press", "@" + node["ref"])
                    return
            if time.monotonic() >= deadline:
                raise RuntimeError("Document picker has no expected semantic target: " + repr(labels))
            time.sleep(0.1)

    # ACTION_GET_CONTENT may show Recents. Choose Downloads explicitly so the
    # fixture does not depend on MediaStore indexing or a previously selected folder.
    downloads = ("Downloads", "下载", "下载内容")
    # The picker reopens in the last folder; navigate only when Downloads is not already open.
    current = [node.get("label", node.get("text", "")) for node in picker_command("snapshot", "-i")["nodes"]
               if node.get("identifier") == "com.google.android.documentsui:id/breadcrumb_text"]
    if not (current and current[-1] in downloads):
        press_label(("Show roots", "Show navigation drawer", "显示根目录", "显示所有位置"))
        # The current-folder breadcrumb can have the same localized label as the root.
        press_label(downloads, identifier="android:id/title")
    picker_command("wait", "label=" + json.dumps(env["UPLOAD_NAME"]), "10000")
    picker_command("press", "label=" + json.dumps(env["UPLOAD_NAME"]))
    deadline = time.monotonic() + 10
    while True:
        windows = command([*ADB, "shell", "dumpsys", "window"], timeout=15)
        focus = next((line for line in windows.splitlines() if "mCurrentFocus=" in line), "")
        if "host.exp.exponent/" in focus:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Document selection did not return to Expo Go")
        time.sleep(0.1)
    require_expo()


def cleanup_upload_fixture(env):
    """Remove only this fixture's artifacts, after its conversation has stopped.

    Production deliberately has no file-delete API. The local-only runner removes
    its exact owned registry rows as well as bytes; it never resets shared state.
    """
    if "UPLOAD_CONVERSATION_ID" not in env:
        return
    source = Path(env["UPLOAD_PATH"])
    identity = env["UPLOAD_CONVERSATION_ID"]
    assert identity in fixtures and source.name in {
        f"e2e-upload-{run_id}.txt", f"e2e-upload-{run_id}.pdf",
    }
    existing = {item["id"] for item in api("/conversations")["conversations"]}
    assert identity not in existing, "Conversation must stop before upload cleanup"
    with closing(sqlite3.connect(WORKSPACE / ".wandrun" / "state" / "gateway.sqlite")) as db, db:
        pending = db.execute(
            "SELECT id FROM uploads WHERE conversation_id=? AND filename=?",
            (identity, source.name),
        ).fetchall()
        for (upload_id,) in pending:
            # Serialize with PATCH/finalization through the real endpoint before touching
            # fixture-only records. Deleting a conversation does not own upload I/O.
            request = Request(
                GATEWAY + "/uploads/" + quote(upload_id, safe=""), method="DELETE",
                headers={"Authorization": "Bearer " + TOKEN, "Tus-Resumable": "1.0.0"},
            )
            with urlopen(request, timeout=30) as response:
                assert response.status == 204
        db.execute(
            "DELETE FROM files WHERE path=? AND source='user_upload'",
            (str(source),),
        )
    for (upload_id,) in pending:
        (WORKSPACE / ".wandrun" / "uploads" / upload_id).unlink(missing_ok=True)
        (WORKSPACE / "conversations" / f".upload-{upload_id}.stage").unlink(missing_ok=True)
    source.unlink(missing_ok=True)
    if source.parent.exists():
        source.parent.rmdir()  # Unexpected contents are an explicit cleanup failure.
    command([*ADB, "shell", "rm", "-f", env["UPLOAD_DEVICE_PATH"]], timeout=15)
    Path(env["UPLOAD_LOCAL_PATH"]).unlink(missing_ok=True)



def start_browser_fixture(env):
    return browser_native.start_fixture(env, run_id)


def browser_fixture(env):
    """A real local browser-skilled Agent opens the fixture and requests takeover."""
    if not any(skill["name"] == "browser" for skill in api("/skills")["skills"]):
        raise RuntimeError("Browser regression requires the browser skill in the gateway workspace")
    environments = api("/computer")["environments"]
    local = environments[0] if environments else None  # Phase one only assembles Local browsers.
    if local is None:
        raise RuntimeError("Browser regression requires a configured, running local CDP browser")
    capacity = local["capacity"]
    if capacity["pages_used"] >= capacity["pages_limit"]:
        raise RuntimeError("Browser regression requires one free environment page; existing leases are untouched")
    identity = create_owned_agent("E2E browser " + run_id, skills=["browser"],
                                  system_prompt=(
                                      "Use the browser skill and its task-specific CDP address for web tasks. "
                                      "Never use the shared Chrome CDP address. When the user needs to take over, "
                                      "call request_takeover and leave the page open even after handback. "
                                      "Do not type into the editable field or close the page until asked."))
    conversation = api("/conversations", "POST", {"client_id": uuid4().hex, "agent_id": identity})
    fixtures.append(conversation["id"])
    env.update({"BROWSER_AGENT_ID": identity, "BROWSER_CONVERSATION_ID": conversation["id"]})
    api(conversation_path(conversation["id"]) + "/messages", "POST", {
        "client_id": "e2e-browser-" + uuid4().hex,
        "text": (
            f"请实际用 browser skill 的 agent-browser 打开本机测试页 {env['BROWSER_URL']}，"
            f"核对页面标题 {env['BROWSER_TITLE']} 和可编辑的 Phone input。"
            "然后调用 request_takeover，说明请用户在输入框输入测试文本；"
            "不要替用户输入，不要关闭页面或租约。即使交还后也保留页面供用户查看，"
            "等用户明确说可以关闭才关闭。"
        ),
    })
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        tasks = api("/browser-tasks?agent_id=" + quote(identity, safe=""))["browser_tasks"]
        matching = [(task, page) for task in tasks if task["root_id"] == conversation["id"]
                    for page in task["pages"] if page["url"].rstrip("/") == env["BROWSER_URL"].rstrip("/")]
        requested = [(task, page) for task, page in matching if task["state"] == "requested"]
        if requested:
            task, page = requested[0]
            assert task["entry_agent_id"] == identity and task["requested_reason"], task
            env.update({"BROWSER_TASK_ID": task["id"], "BROWSER_PAGE_ID": page["id"]})
            return
        events = api(conversation_path(conversation["id"]) + "/events?limit=200")["events"]
        if any(event["type"] == "turn.failed" for event in events):
            raise RuntimeError("Browser-skilled Agent failed before opening and requesting takeover")
        time.sleep(0.5)
    raise RuntimeError("Real Agent did not open the fixture and request takeover within 240 seconds")


def stop_browser_fixture(server):
    server.shutdown()
    server.server_close()
    server.thread.join(timeout=5)
    assert not server.thread.is_alive(), "Browser fixture HTTP server did not stop"


def chat_entry():
    """Return through real navigation; await each screen's exit before issuing another Back."""
    for _ in range(12):
        ad("wait", "stable")
        nodes = ad("snapshot", "-i")["nodes"]
        if any((node.get("id") or node.get("identifier")) == "agents-back" and node.get("hittable") for node in nodes):
            ad("press", 'id="agents-back"', "--settle")
            ad("wait", "absent", 'id="agent-list-screen"', "10000")
            continue
        if any(node.get("label") == "关闭对话列表" and node.get("hittable") for node in nodes):
            ad("back")
            ad("wait", "absent", 'label="关闭对话列表"', "10000")
            continue
        if (any((node.get("id") or node.get("identifier")) == "composer-input" and node.get("hittable")
                for node in nodes)
                and any((node.get("id") or node.get("identifier")) == "chat-open-drawer" and node.get("hittable") for node in nodes)):
            ad("wait", "stable")
            ad("wait", 'id="chat-open-drawer"', "10000")
            return
        ad("back")
        ad("wait", "stable")
    raise RuntimeError("Cannot return to chat entry")


def home():
    """Open the Agent management directory through the drawer; rows open profiles."""
    nodes = ad("snapshot", "-i")["nodes"]
    if any((node.get("id") or node.get("identifier")) == "agents-add" and node.get("hittable") for node in nodes):
        return
    chat_entry()
    ad("press", 'id="chat-open-drawer"', "--settle")
    ad("wait", 'id="drawer-agents"', "10000")
    ad("press", 'id="drawer-agents"', "--settle")
    ad("wait", "absent", 'label="关闭对话列表"', "10000")
    ad("wait", 'id="agent-list-screen"', "10000")


def open_new_chat(identity):
    """Choose through /chat draft chips or the all-Agents grid, never through the management list."""
    chat_entry()
    nodes = ad("snapshot", "-i")["nodes"]
    if not any((node.get("id") or node.get("identifier")) == "new-chat-agent-chips" for node in nodes):
        ad("press", 'id="chat-new-conversation"', "--settle")
    ad("wait", 'id="new-chat-agent-chips"', "10000")
    nodes = ad("snapshot", "-i")["nodes"]
    if any((node.get("id") or node.get("identifier")) == "new-chat-agent-all" for node in nodes):
        ad("press", 'id="new-chat-agent-all"', "--settle")
        replay_steps("chat", {}, source=f"""appId: host.exp.exponent
---
- scrollUntilVisible:
    element:
      id: new-chat-agent-grid-{identity}
    direction: DOWN
- tapOn:
    id: new-chat-agent-grid-{identity}
""")
    else:
        ad("press", 'id=' + json.dumps("new-chat-agent-" + identity), "--settle")
    ad("wait", 'id="composer-input"', "10000")
    ad("wait", 'id=' + json.dumps("new-chat-agent-" + identity), "10000")


def open_settings():
    chat_entry()
    ad("press", 'id="chat-open-drawer"', "--settle")
    ad("wait", 'id="drawer-settings"', "10000")
    ad("press", 'id="drawer-settings"', "--settle")
    ad("wait", "absent", 'label="关闭对话列表"', "10000")
    ad("wait", 'id="settings-models"', "10000")


def open_agent_profile():
    """The name area opens profile; the child counter is a separate control."""
    ad("wait", 'id="chat-agent-profile"', "10000")
    ad("press", 'id="chat-agent-profile"', "--settle")
    ad("wait", 'id="profile-name"', "10000")


def dismiss_keyboard():
    """Back dismisses this IME, but must not navigate when no keyboard is visible."""
    if ad("keyboard", "status")["visible"]:
        ad("back", "--system")
        ad("wait", "stable")


def open_root(identity):
    """Persisted fixture content belongs to a root; select it in the drawer, never via an Agent row."""
    chat_entry()
    ad("press", 'id="chat-open-drawer"', "--settle")
    row = "conversation-" + identity
    replay_steps("home", {}, source=f"""appId: host.exp.exponent
---
- scrollUntilVisible:
    element:
      id: {row}
    direction: DOWN
- tapOn:
    id: {row}
""")
    ad("wait", "absent", 'label="关闭对话列表"', "10000")
    ad("wait", 'id="composer-input"', "10000")


def assert_rows(agents):
    for agent in agents:
        selector = 'id=' + json.dumps("agent-row-" + agent["id"], ensure_ascii=False)
        ad("wait", selector, "10000")


def cleanup_conversations():
    existing = {conversation["id"] for conversation in api("/conversations")["conversations"]}
    errors = []
    for identity in fixtures:
        if identity in existing:
            try:
                api(conversation_path(identity), "DELETE")
            except Exception as exc:
                errors.append(f"{identity}: {exc}")
    if errors:
        raise RuntimeError("; ".join(errors))

def cleanup_schedules():
    """Stop future fixture triggers before collecting every conversation they created."""
    for identity in owned_agents:
        for schedule in api(agent_path(identity) + "/schedules")["schedules"]:
            api("/schedules/" + quote(schedule["id"], safe=""), "DELETE")
    for conversation in api("/conversations")["conversations"]:
        if conversation["agent_id"] in owned_agents and conversation["id"] not in fixtures:
            fixtures.append(conversation["id"])



def cleanup_agents():
    agents = api("/agents")["agents"]
    existing = {agent["id"] for agent in agents}
    # UI creates/renames and API requests register names before a response can be lost.
    unrecorded = [agent["id"] for agent in agents
                  if agent["name"] in owned_agent_names and agent["id"] not in owned_agents]
    errors = []
    for identity in [*reversed(owned_agents), *unrecorded]:
        if identity in existing:
            try:
                api(agent_path(identity), "DELETE")
                existing.remove(identity)
            except Exception as exc:
                errors.append(f"{identity}: {exc}")
    if errors:
        raise RuntimeError("; ".join(errors))
    # Deletion responses precede the phone's SSE render; don't tap a shifting row
    # when the next group starts on the home screen.
    for identity in [*owned_agents, *unrecorded]:
        ad("wait", "absent", 'id=' + json.dumps("agent-row-" + identity), "10000")


def replay_steps(group, env, browser_server=None, pairing=None, source=None):
    """Run semantic YAML actions; only retained native-chain hooks can execute."""
    source = source if source is not None else (ROOT / f"{group}.yaml").read_text()
    header, body = source.split("---\n", 1)
    step = []

    def execute():
        if not step:
            return
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", prefix="wandrun-e2e-", delete=False) as stream:
            stream.write(header + "---\n" + "".join(step))
            path = Path(stream.name)
        try:
            ad("replay", str(path), "--maestro", "--timeout", "30000",
               *(part for key, value in env.items() for part in ("--env", key + "=" + str(value))), timeout=40)
        finally:
            path.unlink(missing_ok=True)
        step.clear()

    for line in body.splitlines(keepends=True):
        if line.startswith("- "):
            execute()
            step.append(line)
        elif line.startswith("# @"):
            execute()
            hook = line.strip()[3:]
            runner = sys.modules[__name__]
            if hook.startswith("phase "):
                begin_phase(hook.removeprefix("phase "))
            elif hook.startswith("core-"):
                core.action(runner, env, hook.removeprefix("core-"))
            elif hook.startswith("collaboration-"):
                collaboration.action(runner, env, hook.removeprefix("collaboration-"))
            elif hook.startswith("attachments-"):
                attachments.action(runner, env, hook.removeprefix("attachments-"))
            elif hook.startswith("audio-"):
                audio_native.action(runner, env, hook.removeprefix("audio-"))
            elif hook.startswith("rich-"):
                native_rich.action(runner, env, hook.removeprefix("rich-"))
            elif hook.startswith("browser-native-"):
                browser_native.action(runner, env, hook.removeprefix("browser-native-"), browser_server)
            elif hook.startswith("schedule-"):
                core.schedule_action(runner, env, hook.removeprefix("schedule-"))
            elif hook.startswith("manual "):
                name = hook.removeprefix("manual ")
                if name == "attachment-save-share":
                    instructions = attachments.MANUAL_SAVE_SHARE.replace("<run_id>", run_id).replace("<DELIVERY_NAME>", env["DELIVERY_NAME"]).replace("<PDF_MARKER>", env["PDF_MARKER"])
                elif name == "rich-source-external-link":
                    instructions = native_rich.manual_instructions(name, env)
                else:
                    raise RuntimeError("Unknown manual check: " + name)
                manual_checks.check(runner, name, instructions)
                require_expo()
            elif hook == "home":
                home()
            elif hook == "open-settings":
                open_settings()
            elif hook == "open-agent-profile":
                open_agent_profile()
            elif hook == "dismiss-keyboard":
                dismiss_keyboard()
            elif hook == "known-dev-overlay":
                dismiss_known_dev_overlay()
            elif hook.startswith("open-new-chat "):
                open_new_chat(env[hook.removeprefix("open-new-chat ")])
            elif hook.startswith("open-root "):
                open_root(env[hook.removeprefix("open-root ")])
            elif hook == "tap-outside":
                # A blank-chat attachment overlay has no semantic outside target.
                # Retain the current screenshot and geometry before the coordinate fallback.
                ad("snapshot", "-i")
                ad("screenshot", str(OUT / "attachment-menu-before-outside.png"))
                size = phone_command([*ADB, "shell", "wm", "size"]).split()[-1]
                width, height = map(int, size.split("x"))
                ad("press", str(width * 9 // 10), str(height // 5), "--settle")
            elif hook == "pairing-original-dev":
                nodes = ad("snapshot", "-i")["nodes"]
                assert_pairing_selection(nodes, GATEWAY, "开发连接", current=True)
                env["PAIRING_DEV_ROW"] = pairing_computer_row(nodes, GATEWAY)
                env["PAIRING_ORIGINAL_DEV"] = True
            elif hook == "pairing-camera":
                manual_checks.pairing_camera(runner, pairing, env)
            elif hook == "pairing-exchanged":
                pairing.assert_paired("qr")
            elif hook == "pairing-fixture-current":
                nodes = ad("snapshot", "-i")["nodes"]
                assert_pairing_selection(nodes, env["PAIRING_URL"], "扫码", current=True)
                env["PAIRING_FIXTURE_ROW"] = pairing_computer_row(nodes, env["PAIRING_URL"])
            elif hook == "pairing-fixture-selected":
                assert_pairing_selection(ad("snapshot", "-i")["nodes"], env["PAIRING_URL"], "扫码", current=False)
            elif hook == "pairing-dev-current":
                assert_pairing_selection(ad("snapshot", "-i")["nodes"], GATEWAY, "开发连接", current=True)
            elif hook == "pairing-local-disconnected":
                ad("wait", "absent", 'id=' + json.dumps(env["PAIRING_FIXTURE_ROW"]), "10000")
                assert_pairing_selection(ad("snapshot", "-i")["nodes"], GATEWAY, "开发连接", current=True)
            elif hook == "pairing-revoked":
                pairing.assert_revoked()
            elif hook == "pairing-restore-dev":
                restore_pairing_connection(pairing, env)
            elif hook in ("dark-mode", "light-mode"):
                if not PRESERVE_SYSTEM_THEME:
                    mode = "yes" if hook == "dark-mode" else "no"
                    set_theme(mode)
                    assert mode in phone_command([*ADB, "shell", "cmd", "uimode", "night"])
            elif hook == "image-request":
                api(conversation_path(env["IMAGE_CONVERSATION_ID"]) + "/messages", "POST", {
                    "client_id": "e2e-image-" + uuid4().hex,
                    "text": "请调用 generate_image 生成一张白底蓝色圆形的简单图片，把返回原文件作为附件发给 human。失败原样报告代码、详情和重置时间，不重试。",
                })
                await_media_reply(env)
            else:
                raise RuntimeError("Unknown native-chain hook: " + hook)
        elif line.startswith("  "):
            step.append(line)
    execute()



def restore(actions):
    """Attempt all independent cleanup actions; never hide a cleanup failure."""
    errors = []
    for label, action in actions:
        try:
            action()
        except Exception as exc:
            errors.append(f"{label}: {exc}")
    return errors


def cleanup_browser_tasks(env):
    if "BROWSER_CONVERSATION_ID" not in env:
        return
    for task in api("/browser-tasks")["browser_tasks"]:
        if task["root_id"] == env["BROWSER_CONVERSATION_ID"] and task["state"] != "released":
            api("/browser-tasks/" + quote(task["id"], safe=""), "DELETE")


def pairing_selected(nodes):
    """Read the selected computer, not a similarly named row elsewhere in the list."""
    def value(identity):
        matches = [node for node in nodes if node.get("id", node.get("identifier")) == identity]
        if len(matches) != 1:
            raise RuntimeError("Cannot read selected computer " + identity)
        return str(matches[0].get("text") or matches[0].get("label") or matches[0].get("value") or "")

    ids = {node.get("id", node.get("identifier")) for node in nodes}
    return value("connection-address").rstrip("/"), value("connection-method"), "connection-switch" not in ids


def assert_pairing_selection(nodes, url, method, *, current):
    address, shown_method, is_current = pairing_selected(nodes)
    if (address, is_current) != (url.rstrip("/"), current) or method not in shown_method:
        raise AssertionError(f"Expected {'current' if current else 'selected'} {method} at {url}, "
                             f"found {shown_method} at {address} (current={is_current})")


def pairing_computer_row(nodes, url):
    """Capture the current development computer by exact URL and current marker before switching."""
    target = url.rstrip("/")
    rows = [node.get("id", node.get("identifier")) for node in nodes
            if str(node.get("id", node.get("identifier")) or "").startswith("connection-computer-")
            and str(node.get("label") or "").split(", ")[-1].rstrip("/") == target
            and "当前" in str(node.get("label") or "").split(", ")]
    if len(rows) != 1:
        raise RuntimeError("Cannot identify a unique current development computer at " + url)
    return rows[0]


def restore_pairing_connection(pairing, env):
    """Restore only the original development URL; never disconnect an unrelated saved computer."""
    if not env.get("PAIRING_ORIGINAL_DEV") or env.get("PAIRING_RESTORED"):
        return
    ad("open", EXPO, "--foreground")
    for _ in range(12):
        nodes = ad("snapshot", "-i")["nodes"]
        ids = {node.get("id", node.get("identifier")) for node in nodes}
        if "connection-cancel" in ids:
            replay_steps("pairing", env, pairing=pairing, source="""appId: host.exp.exponent
---
- tapOn:
    id: connection-cancel
""")
        elif "pairing-back" in ids:
            replay_steps("pairing", env, pairing=pairing, source="""appId: host.exp.exponent
---
- tapOn:
    id: pairing-back
""")
        elif "pairing-close" in ids:
            replay_steps("pairing", env, pairing=pairing, source="""appId: host.exp.exponent
---
- tapOn:
    id: pairing-close
""")
        elif "connection-method" in ids:
            address, method, is_current = pairing_selected(nodes)
            if address == GATEWAY and "开发连接" in method:
                if not is_current:
                    replay_steps("pairing", env, pairing=pairing, source="""appId: host.exp.exponent
---
- tapOn:
    id: connection-switch
""")
                    ad("wait", 'id="composer-input"', "10000")
                home()
                env["PAIRING_RESTORED"] = True
                return
            else:
                row = env["PAIRING_DEV_ROW"]
                replay_steps("pairing", env, pairing=pairing, source=f"""appId: host.exp.exponent
---
- tapOn:
    id: {json.dumps(row)}
""")
        elif "settings-about-connection" in ids:
            replay_steps("pairing", env, pairing=pairing, source="""appId: host.exp.exponent
---
- tapOn:
    id: settings-about-connection
""")
        elif any(node.get("label") == "设置" and node.get("hittable") for node in nodes):
            replay_steps("pairing", env, pairing=pairing, source="""appId: host.exp.exponent
---
# @open-settings
""")
        else:
            ad("back")
            ad("wait", "stable")
    raise RuntimeError("Could not restore original development computer at " + GATEWAY)

def pairing_skip_reason(nodes):
    """Classify the App's displayed connection; absence/unknown UI is a failure, not a skip."""
    if any(node.get("id", node.get("identifier")) == "pairing-title" for node in nodes):
        method = "未连接"
    else:
        matching = [node for node in nodes
                    if node.get("id", node.get("identifier")) == "connection-method"]
        if len(matching) != 1:
            raise RuntimeError("Cannot read the App connection method")
        text = str(matching[0].get("text") or matching[0].get("label") or matching[0].get("value") or "")
        method = next((name for name in ("开发连接", "扫码", "手动输入") if name in text), None)
        if method is None:
            raise RuntimeError("Unrecognized App connection method")
    if method == "开发连接":
        return None
    return f"pairing 组需要 App 使用开发连接（当前：{method}）；为避免影响用户设备，已跳过"


def pairing_preflight():
    """Read the App's connection before creating a bridge or touching pairing credentials."""
    nodes = ad("snapshot", "-i")["nodes"]
    if any(node.get("id", node.get("identifier")) == "pairing-title" for node in nodes):
        return pairing_skip_reason(nodes)
    home()
    replay_steps("pairing", {}, source="""appId: host.exp.exponent
---
# @open-settings
- tapOn:
    id: settings-about-connection
""")
    ad("wait", 'id="connection-method"', "10000")
    nodes = ad("snapshot", "-i")["nodes"]
    reason = pairing_skip_reason(nodes)
    if reason is None:
        assert_pairing_selection(nodes, GATEWAY, "开发连接", current=True)
        home()
    return reason


def pairing_guard_result(status, message, elapsed_seconds):
    """Record a pre-fixture decision without running group cleanup on an unrelated device."""
    directory = run_out / "pairing"
    directory.mkdir(exist_ok=True)
    result = {"group": "pairing", "status": status, "elapsed_seconds": round(elapsed_seconds, 2),
              "error": message if status == "FAIL" else None,
              "reason": message if status == "SKIP" else None,
              "cleanup_errors": [], "screenshots": []}
    (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def pairing_gate():
    """Decide whether pairing may start; UI uncertainty is a failure, not permission."""
    started = time.monotonic()
    try:
        reason = pairing_preflight()
    except Exception as exc:
        return pairing_guard_result("FAIL", f"{type(exc).__name__}: {exc}", time.monotonic() - started)
    return pairing_guard_result("SKIP", reason, time.monotonic() - started) if reason else None


def run_pairing_if_development(run):
    """Do not enter the pairing group or its cleanup unless the App displays development."""
    decision = pairing_gate()
    return decision if decision is not None else run()


def overall_status(results, error=None, cleanup_errors=()):
    """Only a complete skip is SKIP; any real failure dominates other group outcomes."""
    if error or cleanup_errors or any(result["status"] == "FAIL" for result in results):
        return "FAIL"
    if any(result["status"] == "PARTIAL" for result in results):
        return "PARTIAL"
    return "SKIP" if results and all(result["status"] == "SKIP" for result in results) else "PASS"



phase_times = {}
phase_name = None
phase_started = None


def begin_phase(name):
    global phase_name, phase_started
    now = time.monotonic()
    if phase_name is not None:
        phase_times[phase_name] = phase_times.get(phase_name, 0) + now - phase_started
    phase_name, phase_started = name, now
    if name is not None:
        print(json.dumps({"event": "phase", "phase": name}), flush=True)


def run_group(group):
    """Own fixture lifetimes; a failed group is reported without skipping later groups."""
    global OUT, fixtures, owned_agents, owned_agent_names, run_id, manual_results
    global phase_times, phase_name, phase_started
    phase_times, phase_name, phase_started = {}, None, None
    begin_phase("prepare")
    OUT = run_out / group
    OUT.mkdir()
    started = time.monotonic()
    fixtures, owned_agents, manual_results = [], [], []
    owned_agent_names = set()
    run_id = uuid4().hex[:10]
    browser_server = None
    pairing = None
    error = None
    env = {"ARTIFACTS": str(OUT)}
    runner = sys.modules[__name__]
    try:
        require_expo()
        if group == "chat":
            core.prepare_chat(runner, env)
        elif group == "pairing":
            if api("/connection")["pairing_method"] != "development":
                raise RuntimeError("Pairing requires this run's development connection")
            pairing = PairingFixture()
            env.update(PAIR_DEVICE_NAME="E2E pairing " + run_id, DEV_URL=GATEWAY, PAIRING_URL=pairing.start())
        elif group == "attachments":
            audio_native.prepare(runner, env)
            if not options.attachment_audio_only:
                attachments.prepare(runner, env)
        elif group == "browser":
            browser_server = start_browser_fixture(env)
            begin_phase("browser-model")
            browser_fixture(env)
        elif group == "rich":
            native_rich.prepare(runner, env)
        elif group == "schedules":
            core.prepare_schedule(runner, env)
        elif group == "image":
            image_fixture(env)
        (OUT / "fixture.json").write_text(json.dumps(env, ensure_ascii=False, indent=2))
        begin_phase("navigation")
        home()
        if group == "attachments":
            replay_steps(group, env, source=(ROOT / "attachments-audio.yaml").read_text())
        if not (group == "attachments" and options.attachment_audio_only):
            replay_steps(group, env, browser_server, pairing=pairing)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        capture_errors = restore([("failure screenshot", lambda: ad("screenshot", str(OUT / "failure.png")))])
    else:
        capture_errors = []
    finally:
        begin_phase("cleanup")
        cleanup_errors = restore([
            ("paired fixture device", pairing.revoke_owned_device if pairing else lambda: None),
            ("development connection", lambda: restore_pairing_connection(pairing, env) if pairing else None),
            ("pairing bridge", pairing.close if pairing else lambda: None),
            ("browser leases", lambda: cleanup_browser_tasks(env) if group == "browser" else None),
            ("browser fixture server", lambda: stop_browser_fixture(browser_server) if browser_server else None),
            ("fixture schedules", lambda: cleanup_schedules() if group == "schedules" else None),
            ("fixture conversations", cleanup_conversations),
            ("audio fixture", lambda: audio_native.cleanup(runner, env) if group == "attachments" else None),
            ("delivered original file", lambda: attachments.cleanup(runner, env) if group == "attachments" else None),
            ("uploaded fixture", lambda: cleanup_upload_fixture(env) if group == "attachments" else None),
            ("image fixture", lambda: cleanup_image_fixture(env) if group == "image" else None),
            ("owned Agents", cleanup_agents),
        ])
    if error:
        begin_phase("recovery")
        cleanup_errors += restore([("Agent directory", home)])
    begin_phase(None)
    status = ("FAIL" if error or cleanup_errors else
              "PARTIAL" if any(item["status"] == "PARTIAL" for item in manual_results) else "PASS")
    result = {"group": group, "status": status,
              "elapsed_seconds": round(time.monotonic() - started, 2), "error": error,
              "phase_seconds": {name: round(seconds, 2) for name, seconds in phase_times.items()},
              "manual_checks": manual_results,
              "cleanup_errors": capture_errors + cleanup_errors,
              "screenshots": [str(path) for path in sorted(OUT.glob("*.png"))]}
    if options.attachment_audio_only:
        result["subflow"] = "audio-native-only"
    (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result



def budget_notice(minutes):
    notice = {"event": "budget", "minutes": minutes, "phase": phase_name,
              "elapsed_seconds": round(time.monotonic() - START, 2),
              "status": "soft-limit" if minutes == 20 else "report-required"}
    (run_out / f"budget-{minutes}m.json").write_text(json.dumps(notice, ensure_ascii=False, indent=2))
    print(json.dumps(notice, ensure_ascii=False), flush=True)
    reporter = os.environ.get("E2E_BUDGET_COMMAND")
    if minutes == 24 and reporter:
        try:
            sent = subprocess.run([*json.loads(reporter), "--body", json.dumps(notice, ensure_ascii=False)],
                                  capture_output=True, text=True, timeout=30)
            if sent.returncode:
                notice["report_error"] = sent.stderr or sent.stdout
        except (OSError, subprocess.SubprocessError) as error:
            notice["report_error"] = str(error)
        (run_out / f"budget-{minutes}m.json").write_text(json.dumps(notice, ensure_ascii=False, indent=2))


budget_timers = [threading.Timer(max(0, minutes * 60 - (time.monotonic() - START)),
                                budget_notice, args=(minutes,)) for minutes in (20, 24)]
for budget_timer in budget_timers:
    budget_timer.daemon = True
    budget_timer.start()


run_out = OUT
results = []
error = None
shared_setup_started = False
try:
    # Pairing alone must inspect the App before shared setup changes reverse mappings,
    # Agent membership, theme, or screen state on someone else's paired device.
    if selected == ["pairing"]:
        require_expo()
        decision = pairing_gate()
        if decision is not None:
            results.append(decision)
    if not results:
        shared_setup_started = True
        prepare_reverse()
        require_expo()
        original_theme = phone_command([*ADB, "shell", "cmd", "uimode", "night"]).split()[-1]
        agents = api("/agents")["agents"]
        set_theme("no")
        ad("open", EXPO, "--foreground")
        home()
        assert_rows(agents)
        setup_seconds = round(time.monotonic() - START, 2)
        for group in selected:
            if results and results[-1]["group"] == "pairing" and results[-1]["status"] != "PASS":
                home()  # Another selected group still expects its usual home starting point.
            if group == "pairing" and selected != ["pairing"]:
                results.append(run_pairing_if_development(lambda: run_group(group)))
            else:
                results.append(run_group(group))
except Exception as exc:
    error = f"{type(exc).__name__}: {exc}"
    for group in selected[len(results):]:
        results.append({"group": group, "status": "FAIL", "elapsed_seconds": 0,
                        "error": "Shared prerequisite failed: " + error,
                        "cleanup_errors": [], "screenshots": []})
finally:
    OUT = run_out
    cleanup_started = time.monotonic()
    cleanup_errors = restore([
        ("original theme", lambda: set_theme(globals().get("original_theme", "no"))),
        ("Agent directory", home),
        ("restored screenshot", lambda: ad("screenshot", str(OUT / "home-restored.png"))),
    ]) if shared_setup_started else []
    total_status = overall_status(results, error, cleanup_errors)
    report = {"status": total_status,
              "elapsed_seconds": round(time.monotonic() - START, 2),
              "setup_seconds": locals().get("setup_seconds"),
              "cleanup_seconds": round(time.monotonic() - cleanup_started, 2),
              "error": error, "cleanup_errors": cleanup_errors, "groups": results,
              "reverse": json.loads((OUT / "reverse.json").read_text()) if (OUT / "reverse.json").exists() else None,
              "artifacts": str(OUT), "restored_screenshot": str(OUT / "home-restored.png") if shared_setup_started else None,
              "theme_preserved": PRESERVE_SYSTEM_THEME}
    report["budget"] = ("report-required" if report["elapsed_seconds"] >= 1440 else
                        "over-soft" if report["elapsed_seconds"] >= 1200 else "within-soft")
    for timer in globals().get("budget_timers", []):
        timer.cancel()
    (OUT / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    LOG.close()
    print(json.dumps(report, ensure_ascii=False, indent=2))

sys.exit(0 if report["status"] in ("PASS", "SKIP") else 1)
