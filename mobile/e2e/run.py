#!/usr/bin/env python3
"""Android + already-running Expo Go/Metro/gateway regression.

Run: python3 mobile/e2e/run.py [group ...] | --list
Optional env: ANDROID_SERIAL, GATEWAY_URL, GATEWAY_TOKEN (default dev), E2E_AGENT_ID,
E2E_ARTIFACTS, E2E_WORKSPACE, EXPO_URL. Requires agent-device 0.21.16.
All groups authenticate API calls with GATEWAY_TOKEN (default dev). Pairing
requires an initial development connection and restores that connection.
Only this run's temporary conversations, Agents, connectors and paired device are cleaned.
Only the system launcher permits reopening Expo Go; any other foreground app stops
phone operations, except DocumentsUI inside upload's explicit selection hook.
"""
import hashlib
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPConnection, HTTPSConnection
from urllib.error import HTTPError
from ipaddress import ip_address
from html import escape
import json
import os
from pathlib import Path
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
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
from urllib.error import HTTPError

import compaction
import rich
import collaboration


ROOT = Path(__file__).resolve().parent
GROUPS = {
    "home": "首页、移出/放回、＋菜单、全部 Agent",
    "drawer": "对话抽屉、新建/切换/返回、重命名、删除当前及非当前对话",
    "collaboration": "真实委派、主进度/预览跳转、接收/发起胶囊抽屉、成员插话与完成后续聊、根删除及浅深色截图",
    "profile": "聊天顶栏、资料页、成员跳转、空成员及记忆页",
    "memory": "独立 Agent 记忆：Markdown 编辑、外部变化、冲突保留草稿、显式重新载入、浅深色截图",
    "schedules": "定时列表/全屏编辑、外部创建同步、到点对话来源与运行记录、删除",
    "agent": "新建、编辑、代码模式默认开启/关闭保存、外部同步、引用阻止删除、解除引用及删除",
    "settings": "设置首页与关于/连接浅深色、单一入口及连接信息、模型/订阅额度/Agent 用量、默认档位、新建表单默认值、Agent 模型档位编辑及恢复",
    "connectors": "连接器列表/编辑/测试、本地参数往返与既有传输保留、Agent 使用量、引用阻止删除、无事件保存、后台删除保留 Agent 草稿",
    "skills": "技能正常/错误项、详情、引用删除冲突及解除、删除事件刷新、默认入口预填未发送、浅深色截图",
    "capabilities": "Agent 系统能力、代码模式草稿取消/保存后未启用/重新启用、工具弹层、内置技能分组/详情/使用者、浅深色截图",
    "files": "真实 Agent 原文件交付：卡片、全局/作用域搜索、预览、来源跳转、删除对话后独立登记与失效状态",
    "upload": "系统文件选择、tus 上传、纯附件发送、我的消息卡片、文件预览及浅深色截图",
    "pdf": "DocumentsUI 上传随机标记 PDF、真实模型直接读取 input_file、回复标记断言及截图",
    "image": "真实 generate_image 生图、Agent 附件卡片、图片预览浅深色截图；额度耗尽明确失败",
    "browser": "真实 browser skill 租约：聊天卡片、观看/接管/输入/交还、资料电脑、设置电脑、左滑关闭",
    "pairing": "管理凭据申请短码、App 手动配对、首页/关于连接、断开与旧令牌 401、恢复开发连接",
    "compaction": "真实多轮模型压缩、系统行、完整摘要、关闭重开一致及浅深色截图",
    "rich": "真实模型富交互 P0/P1/P2、提交只读、图表、公式、媒体、Mermaid 与浅深色预览",
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("groups", nargs="*", help="Groups in execution order; default: all")
parser.add_argument("--list", action="store_true", help="List groups without touching the phone")
options = parser.parse_args()
if options.list:
    for name, coverage in GROUPS.items():
        print(f"{name}: {coverage}")
    sys.exit(0)
unknown = set(options.groups) - GROUPS.keys()
if unknown:
    parser.error("Unknown groups: " + ", ".join(sorted(unknown)))
selected = list(dict.fromkeys(options.groups or GROUPS))

ARTIFACT_DIR = os.environ.get("E2E_ARTIFACTS")
OUT = Path(ARTIFACT_DIR if ARTIFACT_DIR else tempfile.mkdtemp(prefix="wandrun-e2e-")).resolve()
OUT.mkdir(parents=True, exist_ok=True)
GATEWAY = os.environ.get("GATEWAY_URL", "http://127.0.0.1:8765").rstrip("/")
TOKEN = os.environ.get("GATEWAY_TOKEN", "dev")
WORKSPACE = Path(os.environ.get("E2E_WORKSPACE", str(ROOT.parents[1] / "workspace"))).resolve()
EXPO = os.environ.get("EXPO_URL", "exp://127.0.0.1:8081")
PRESERVE_SYSTEM_THEME = os.environ.get("E2E_PRESERVE_SYSTEM_THEME") == "1"
skipped_dark_screenshots = []
SESSION = "wandrun-regression"
# Repeated runs share the same live device session; evidence remains per-run.
STATE = Path(tempfile.gettempdir()) / ("wandrun-device-" + hashlib.sha256(str(ROOT).encode()).hexdigest()[:12])
ADB = ["adb"] + (["-s", os.environ["ANDROID_SERIAL"]] if os.environ.get("ANDROID_SERIAL") else [])
AD = ["agent-device", "--state-dir", str(STATE), "--session", SESSION, "--platform", "android"]
if os.environ.get("ANDROID_SERIAL"):
    AD += ["--serial", os.environ["ANDROID_SERIAL"]]
START = time.monotonic()
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


def ad(*args, timeout=120, redactions=()):
    require_expo()
    return json.loads(command([*AD, *args, "--json"], timeout, redactions=redactions))["data"]


def dismiss_known_dev_overlay():
    """Dismiss only the observed LegendList LogBox warning, preserving evidence first."""
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

    def assert_paired(self):
        if not self.token or not self.device_id:
            raise AssertionError("App exchange was not observed by the private bridge")
        request = Request(GATEWAY + "/connection", headers={"Authorization": "Bearer " + self.token})
        with urlopen(request, timeout=10) as response:
            connection = json.load(response)
        assert connection["device_id"] == self.device_id
        assert connection["pairing_method"] == "manual"
        assert connection["paired_at"]
        return connection

    def assert_revoked(self):
        if not self.token or not self.device_id:
            raise AssertionError("App exchange was not observed by the private bridge")
        request = Request(GATEWAY + "/connection", headers={"Authorization": "Bearer " + self.token})
        try:
            with urlopen(request, timeout=10) as response:
                response.read()
        except HTTPError as exc:
            assert exc.code == 401, "Revoked device token did not receive 401"
        else:
            raise AssertionError("Revoked device token still authorizes /connection")
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


def connector_path(identity):
    return "/connectors/" + quote(identity, safe="")


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

def model_options(model):
    return [item["effort"] for item in model["supported_reasoning_efforts"]
            if item["effort"] != "ultra"]


def model_fixture():
    """Derive two real, valid model/effort combinations without a catalog whitelist."""
    settings = api("/settings")
    models = [model for model in api("/models")["models"] if model_options(model)]
    if not models:
        raise RuntimeError("Model regression needs a nonempty subscription model catalog")
    original = next((model for model in models if model["id"] == settings["default_model"]), models[0])
    original_effort = settings["default_reasoning_effort"] or original["default_reasoning_effort"]
    if original_effort not in model_options(original):
        original_effort = model_options(original)[0]
    default_choice = next(((model, effort) for model in [original, *models]
                           for effort in model_options(model) if effort != original_effort), None)
    if default_choice is None:
        raise RuntimeError("Model regression needs another supported default reasoning effort")
    default_model, default_effort = default_choice
    changed = next(((model, effort) for model in models if model["id"] != original["id"]
                    for effort in model_options(model) if effort != original_effort), None)
    if changed is None:
        raise RuntimeError("Model regression needs a second model with a different reasoning effort")
    model, effort = changed
    identity = create_owned_agent("E2E model " + run_id, model=original["id"],
                                  reasoning_effort=original_effort)
    return settings, {
        "MODEL_AGENT_ID": identity,
        "ORIGINAL_MODEL": original["id"], "ORIGINAL_EFFORT": original_effort,
        "DEFAULT_MODEL": default_model["id"], "DEFAULT_MODEL_NAME": default_model["display_name"],
        "DEFAULT_EFFORT": default_effort,
        "CHANGED_MODEL": model["id"], "CHANGED_EFFORT": effort,
    }


def agent_effort_fixture():
    """The existing Agent flow changes a supported effort, regardless of live catalog."""
    settings = api("/settings")
    models = api("/models")["models"]
    model = next((item for item in models if item["id"] == settings["default_model"]), None)
    if model is None:
        model = next((item for item in models if model_options(item)), None)
    if model is None:
        raise RuntimeError("Agent regression needs a nonempty subscription model catalog")
    current = settings["default_reasoning_effort"] or model["default_reasoning_effort"]
    changed = next((effort for effort in model_options(model) if effort != current), None)
    if changed is None:
        raise RuntimeError("Agent regression needs an alternate supported reasoning effort")
    return changed


def restore_settings(original):
    if original is not None and api("/settings") != original:
        saved = api("/settings", "PUT", original)
        assert saved == original, "Default model restoration failed"
        assert api("/settings") == original, "Restored default model did not persist"


def replied(conversation):
    if conversation["status"] == "working":
        return False
    events = api(conversation_path(conversation["id"]) + "/events?limit=200")["events"]
    return {"message.user", "message.agent"} <= {event["type"] for event in events}


def old_conversation(agent):
    conversations = api("/conversations?agent_id=" + quote(agent["id"], safe=""))["conversations"]
    existing = next((c for c in conversations if replied(c)), None)
    if existing is not None:
        return existing["id"]
    created = api("/conversations", "POST", {"agent_id": agent["id"]})
    identity = created["id"]
    fixtures.append(identity)
    api(conversation_path(identity) + "/messages", "POST", {
        "client_id": "e2e-message-" + uuid4().hex, "text": "只回复好的",
    })
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        events = api(conversation_path(identity) + "/events?limit=200")["events"]
        if any(event["type"] == "message.agent" for event in events):
            # Keep one real baseline, rather than generating another model turn on every run.
            fixtures.remove(identity)
            return identity
        if any(event["type"] == "turn.failed" for event in events):
            raise RuntimeError("Fixture Agent turn failed before replying")
        time.sleep(1)
    raise RuntimeError("Fixture Agent did not reply within 90 seconds")


def file_fixture(env):
    """A real Agent produces one original file through SendMessage; no synthetic file records."""
    name = "E2E files " + run_id
    agent_id = create_owned_agent(name, system_prompt=(
        "You can use local file tools and SendMessage. Follow user instructions exactly. "
        "When asked to deliver a file, create it and send its relative path in SendMessage.attachments to human."))
    conversation = api("/conversations", "POST", {"agent_id": agent_id})
    fixtures.append(conversation["id"])
    filename = f"e2e-delivery-{run_id}.md"
    source = WORKSPACE / "conversations" / conversation["id"] / filename
    env.update({"FILE_AGENT_ID": agent_id, "FILE_CONVERSATION_ID": conversation["id"],
                "FILE_NAME": filename, "FILE_PATH": str(source)})
    api(conversation_path(conversation["id"]) + "/messages", "POST", {
        "client_id": "e2e-file-" + uuid4().hex,
        "text": f"在当前对话工作目录用文件工具创建 {filename}，正文为 '# E2E original {run_id}\\n\\nDelivered from the original file.'。然后用 SendMessage 发给 human，attachments 必须包含相对路径 {filename}。不要只在文字中提文件名。",
    })
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        events = api(conversation_path(conversation["id"]) + "/events?limit=200")["events"]
        attachments = [file for event in events if event["type"] == "message.agent"
                       for file in event["data"].get("attachments", [])]
        if attachments:
            assert len(attachments) == 1 and attachments[0]["name"] == filename, attachments
            file = attachments[0]
            assert source.is_file(), f"Original file missing: {source}"
            assert api("/files/" + quote(file["id"], safe=""))["available"]
            env["FILE_ID"] = file["id"]
            return
        if any(event["type"] == "turn.failed" for event in events):
            raise RuntimeError("File-delivery turn failed before producing an attachment")
        time.sleep(1)
    raise RuntimeError("Agent did not deliver the original file within 240 seconds")


def cleanup_file_fixture(env):
    source = Path(env.get("FILE_PATH", ""))
    if "FILE_PATH" in env and source.exists():
        source.unlink()
    if "FILE_PATH" in env:
        try:
            source.parent.rmdir()
        except OSError:
            pass  # Other content must be retained, never recursively removed.

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
    conversation = api("/conversations", "POST", {"agent_id": identity})
    fixtures.append(conversation["id"])
    env.update({"IMAGE_AGENT_ID": identity, "IMAGE_CONVERSATION_ID": conversation["id"]})


def await_media_reply(env, *, image=False):
    """Wait for a real human-directed reply; retain replies/events as failure evidence."""
    identity = env["IMAGE_CONVERSATION_ID" if image else "UPLOAD_CONVERSATION_ID"]
    deadline = time.monotonic() + (300 if image else 180)
    replies = []
    while True:
        events = api(conversation_path(identity) + "/events?limit=200")["events"]
        replies = [event["data"] for event in events if event["type"] == "message.agent"]
        evidence = json.dumps(replies, ensure_ascii=False)
        (OUT / "model-events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2))
        if image:
            if "image_generation_quota_exhausted" in evidence:
                raise AssertionError("生图额度耗尽（FAIL，不重试；恢复额度后重跑）: " + evidence)
            attachments = [file for reply in replies for file in reply.get("attachments", [])]
            if attachments:
                assert len(attachments) == 1, evidence
                file = attachments[0]
                detail = api("/files/" + quote(file["id"], safe=""))
                assert detail["available"] and detail["media_type"] == "image/png", detail
                assert detail["conversation_id"] == identity, detail
                source = WORKSPACE / "conversations" / identity / file["name"]
                assert source.parent == WORKSPACE / "conversations" / identity, file
                with source.open("rb") as image_file:
                    assert image_file.read(8) == b"\x89PNG\r\n\x1a\n", "Attachment is not a PNG"
                env["IMAGE_FILE_ID"] = file["id"]
                return
        elif any(env["PDF_MARKER"] in reply.get("text", "") for reply in replies):
            return
        failed = any(event["type"] == "turn.failed" for event in events)
        settled = replies and next(
            row for row in api("/conversations")["conversations"] if row["id"] == identity
        )["status"] != "working"
        if failed or settled or time.monotonic() >= deadline:
            kind = "生图未交付 PNG 附件" if image else "PDF 回复不含随机标记 " + env["PDF_MARKER"]
            raise AssertionError(f"{kind}; failed={failed}; Agent 回复原文: {evidence}; events={events!r}")
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

def upload_fixture(env, *, pdf=False):
    """Own both the Android selection source and the uploaded conversation file."""
    identity = create_owned_agent(
        "E2E upload " + run_id,
        system_prompt=(
            # read_file is the path under test: it returns the PDF as a file block that the
            # adapter sends as input_file. Shell or code extraction would bypass that path.
            "Read the attached PDF with the read_file tool. Never use the shell, code, or any "
            "text extraction to inspect it. Reply to human with only the marker you see."
            if pdf else
            "When a user sends a file, reply only 'Received'. Do not create or change any files."
        ),
    )
    conversation = api("/conversations", "POST", {"agent_id": identity})
    fixtures.append(conversation["id"])
    filename = f"e2e-upload-{run_id}." + ("pdf" if pdf else "txt")
    body = f"E2E upload {run_id}\nSelected on the phone and uploaded with tus.\n"
    local = OUT / filename
    if pdf:
        env["PDF_MARKER"] = "WR-" + run_id
        body = marker_pdf(env["PDF_MARKER"])
        local.write_bytes(body)
    else:
        local.write_text(body, encoding="utf-8")
    env.update({
        "UPLOAD_AGENT_ID": identity, "UPLOAD_CONVERSATION_ID": conversation["id"],
        "UPLOAD_NAME": filename, "UPLOAD_BODY": "" if pdf else body,
        "UPLOAD_LOCAL_PATH": str(local),
        "UPLOAD_PROMPT": (
            "Read this PDF with read_file and reply only with its marker. "
            "Do not use shell commands, code, or text extraction."
            if pdf else ""
        ),
        "UPLOAD_DEVICE_PATH": "/sdcard/Download/" + filename,
        "UPLOAD_PATH": str(WORKSPACE / "conversations" / conversation["id"] / filename),
    })
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
    """Serve an isolated editable page on host loopback; record only real browser input."""
    marker = "E2E browser " + run_id

    class Page(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/":
                self.send_error(404)
                return
            body = (
                "<!doctype html><html><head><meta charset='utf-8'><title>"
                + escape(marker)
                + "</title></head><body><h1>"
                + escape(marker)
                + "</h1><label for='e2e-field'>Phone input</label>"
                "<input id='e2e-field' aria-label='Phone input' type='text' autofocus>"
                "<script>const field=document.getElementById('e2e-field');"
                "field.focus();field.addEventListener('input',()=>"
                "fetch('/input',{method:'POST',body:field.value}));</script></body></html>"
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/input":
                self.send_error(404)
                return
            size = int(self.headers.get("Content-Length", "0"))
            if size > 4096:
                self.send_error(413)
                return
            value = self.rfile.read(size).decode("utf-8")
            with server.input_changed:
                server.inputs.append(value)
                server.input_changed.notify_all()
            self.send_response(204)
            self.end_headers()

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
    server.daemon_threads = True
    server.input_changed = threading.Condition()
    server.inputs = []
    server.thread = threading.Thread(target=server.serve_forever, daemon=True)
    server.thread.start()
    env.update({"BROWSER_URL": f"http://127.0.0.1:{server.server_port}/",
                "BROWSER_TITLE": marker, "BROWSER_INPUT": "phone-" + run_id})
    return server


def browser_fixture(env):
    """A real local browser-skilled Agent opens the fixture and requests takeover."""
    if not any(skill["name"] == "browser" for skill in api("/skills")["skills"]):
        raise RuntimeError("Browser regression requires the browser skill in the gateway workspace")
    capacity = api("/computer")["browser"]
    if capacity["slots_limit"] < 1:
        raise RuntimeError("Browser regression requires a configured, running local CDP browser")
    if capacity["slots_used"] >= capacity["slots_limit"]:
        raise RuntimeError("Browser regression requires one free browser slot; existing leases are untouched")
    identity = create_owned_agent("E2E browser " + run_id, skills=["browser"],
                                  system_prompt=(
                                      "Use the browser skill and its task-specific CDP address for web tasks. "
                                      "Never use the shared Chrome CDP address. When the user needs to take over, "
                                      "call request_takeover and leave the page open even after handback. "
                                      "Do not type into the editable field or close the page until asked."))
    conversation = api("/conversations", "POST", {"agent_id": identity})
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


def all_home():
    for agent in api("/agents")["agents"]:
        if not agent["home"]:
            api("/agents/" + quote(agent["id"], safe="") + "/unhide", "POST")
    assert all(a["home"] for a in api("/agents")["agents"]), "Agent restoration failed"


def home():
    # Bounded navigation, not a retry of a failed behavioral assertion.
    for _ in range(6):
        nodes = ad("snapshot", "-i")["nodes"]
        if any(n.get("label") == "设置" and n.get("hittable") for n in nodes):
            return
        ad("back")
        # Back dispatch returns before the native transition. Do not issue a
        # second back against the previous screen's still-visible snapshot.
        ad("wait", "stable")
    raise RuntimeError("Cannot return to home")


def assert_rows(agents):
    for agent in agents:
        selector = 'id=' + json.dumps("agent-row-" + agent["id"], ensure_ascii=False)
        ad("wait", selector, "10000")


def profile_fixture():
    """Own the profile team and its conversations so the computer tab is genuinely empty."""
    member_name = "E2E profile member " + run_id
    parent_name = "E2E profile team " + run_id
    member_id = create_owned_agent(member_name)
    parent_id = create_owned_agent(parent_name, [member_id])
    for identity in (parent_id, member_id):
        conversation = api("/conversations", "POST", {"agent_id": identity})
        fixtures.append(conversation["id"])
    parent = next(agent for agent in api("/agents")["agents"] if agent["id"] == parent_id)
    return {
        "PROFILE_AGENT_ID": parent_id,
        "PROFILE_NAME": parent_name,
        "PROFILE_TITLE": parent["latest_conversation"]["title"],
        "MEMBER_ID": member_id,
        "MEMBER_NAME": member_name,
        "NO_MEMBERS_ID": member_id,
        "NO_MEMBERS_NAME": member_name,
    }


def capture_dark_profiles(profile):
    """Review the same real Agent header and profile states in system dark mode."""
    def press_id(identity):
        ad("wait", 'id=' + json.dumps(identity), "10000")
        ad("press", 'id=' + json.dumps(identity))

    def wait_id(identity):
        ad("wait", 'id=' + json.dumps(identity), "10000")

    press_id("agent-row-" + profile["PROFILE_AGENT_ID"])
    wait_id("chat-agent-name")
    wait_id("chat-conversation-title")
    ad("screenshot", str(OUT / "20-chat-header-dark.png"))
    press_id("chat-agent-profile")
    wait_id("profile-tab-members")
    wait_id("profile-member-" + profile["MEMBER_ID"])
    ad("screenshot", str(OUT / "21-profile-members-dark.png"))
    press_id("profile-tab-computer")
    wait_id("profile-computer-empty")
    ad("screenshot", str(OUT / "22-profile-computer-empty-dark.png"))
    press_id("profile-tab-memory")
    wait_id("profile-memory-modified")
    ad("screenshot", str(OUT / "24-profile-memory-dark.png"))
    press_id("profile-close")
    press_id("chat-agent-profile")
    wait_id("profile-tab-members")
    ad("back")
    wait_id("chat-agent-name")
    home()

    press_id("agent-row-" + profile["NO_MEMBERS_ID"])
    wait_id("chat-agent-name")
    press_id("chat-agent-profile")
    wait_id("profile-empty-members")
    ad("screenshot", str(OUT / "23-profile-empty-members-dark.png"))
    press_id("profile-close")
    home()


def capture_dark_management(agent):
    fixture = api("/conversations", "POST", {"agent_id": agent["id"]})
    fixtures.append(fixture["id"])
    row = 'id=' + json.dumps("conversation-" + fixture["id"])
    ad("press", 'id=' + json.dumps("agent-row-" + agent["id"]))
    ad("wait", 'label="对话列表"', "10000")
    ad("press", 'label="对话列表"')
    ad("wait", row, "10000")
    ad("press", row)
    ad("wait", "absent", 'id="new-conversation"', "10000")
    ad("press", 'label="对话列表"')
    ad("wait", row, "10000")
    ad("longpress", row, "650")
    ad("wait", 'id="conversation-menu-rename"', "10000")
    ad("screenshot", str(OUT / "13-conversation-menu-dark.png"))
    ad("press", 'id="conversation-menu-rename"')
    ad("wait", 'id="conversation-rename-input"', "10000")
    ad("press", 'id="conversation-rename-input"')
    ad("screenshot", str(OUT / "14-conversation-rename-keyboard-dark.png"))
    ad("press", 'id="conversation-rename-cancel"')
    ad("wait", "absent", 'id="conversation-rename-input"', "10000")
    ad("longpress", row, "650")
    ad("wait", 'id="conversation-menu-delete"', "10000")
    ad("press", 'id="conversation-menu-delete"')
    ad("wait", 'label="删除这个对话？"', "10000")
    ad("screenshot", str(OUT / "15-conversation-delete-dark.png"))
    ad("press", 'id="conversation-delete-confirm"')
    ad("wait", 'label="对话列表"', "10000")
    ad("press", 'label="对话列表"')
    ad("wait", "absent", row, "10000")
    remaining = api("/conversations")["conversations"]
    assert not any(c["id"] == fixture["id"] for c in remaining), "Current conversation was not deleted"
    home()


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

def cleanup_connectors():
    connectors = api("/connectors")["connectors"]
    existing = {connector["id"] for connector in connectors}
    unrecorded = [connector["id"] for connector in connectors
                  if connector["name"] in owned_connector_names and connector["id"] not in owned_connectors]
    errors = []
    for identity in [*reversed(owned_connectors), *unrecorded]:
        if identity in existing:
            try:
                api(connector_path(identity), "DELETE")
                existing.remove(identity)
            except Exception as exc:
                errors.append(f"{identity}: {exc}")
    if errors:
        raise RuntimeError("; ".join(errors))

def skills_fixture(env):
    """Own two direct skill directories and a blank default-entry conversation; never replace skills."""
    root = WORKSPACE / ".wandrun" / "skills"
    root.mkdir(exist_ok=True)
    env.update({"SKILL_NAME": "e2e-skill-" + run_id,
                "BROKEN_SKILL_NAME": "e2e-broken-" + run_id,
                "SKILL_AGENT_NAME": "E2E skills " + run_id})
    # Register each directory immediately after exclusive creation, including partial setup failures.
    env["SKILL_DIRS"] = []
    for key in ("SKILL_NAME", "BROKEN_SKILL_NAME"):
        directory = root / env[key]
        directory.mkdir()
        env["SKILL_DIRS"].append(str(directory))
        content = (f"---\nname: {env[key]}\ndescription: E2E skill management fixture\n---\n"
                   f"# Skill fixture\n\nVerified marker: {run_id}\n" if key == "SKILL_NAME"
                   else "# Broken fixture: required YAML header is missing\n")
        (directory / "SKILL.md").write_text(content, encoding="utf-8")
    env["SKILL_AGENT_ID"] = create_owned_agent(env["SKILL_AGENT_NAME"], skills=[env["SKILL_NAME"]])
    snapshot = api("/skills")
    items = {item["name"]: item for item in snapshot["skills"]}
    assert items[env["SKILL_NAME"]]["status"] == "ok", items
    assert items[env["BROKEN_SKILL_NAME"]]["status"] == "error", items
    default = snapshot["default_agent_id"]
    assert default is not None, "Skills import needs a configured default-entry Agent"
    env["SKILL_DEFAULT_AGENT_ID"] = default
    # Make our empty conversation newest, so existing reusable empty conversations/drafts stay untouched.
    conversation = api("/conversations", "POST", {"agent_id": default})
    fixtures.append(conversation["id"])
    env["SKILL_IMPORT_CONVERSATION_ID"] = conversation["id"]


def cleanup_skills(env):
    # Only files made by this group; rmdir refuses unexpected content rather than deleting it.
    for name in env.get("SKILL_DIRS", []):
        directory = Path(name)
        (directory / "SKILL.md").unlink(missing_ok=True)
        if directory.exists():
            directory.rmdir()



def replay_steps(group, env, browser_server=None, pairing=None, source=None):
    """Replay one action at a time; secret inputs exist only in a 0600 transient step."""
    source = source if source is not None else (ROOT / f"{group}.yaml").read_text()
    header, body = source.split("---\n", 1)
    step = []
    one_step = (pairing.tempdir / ("wandrun-pairing-step-" + uuid4().hex + ".yaml")
                if pairing else Path(tempfile.gettempdir()) / ("wandrun-e2e-step-" + uuid4().hex + ".yaml"))

    def execute():
        if not step:
            return
        text = header + "---\n" + "".join(step)
        if PRESERVE_SYSTEM_THEME and "takeScreenshot:" in text:
            if "-dark.png" in text:
                skipped_dark_screenshots.append(text.split("takeScreenshot:", 1)[1].strip().replace("${ARTIFACTS}", str(OUT)))
                step.clear()
                return
            text = text.replace("-light.png", "-system.png")
        redactions = ()
        try:
            if pairing:
                if "${PAIR_CODE}" in text and not pairing.code:
                    raise RuntimeError("Pairing code was not issued")
                redactions = tuple(secret for marker, secret in (
                    ("${PAIR_CODE}", pairing.code), ("${DEV_TOKEN}", TOKEN)) if marker in text)
                text = text.replace("${PAIR_CODE}", json.dumps(pairing.code or "")).replace("${DEV_TOKEN}", json.dumps(TOKEN))
                fd = os.open(one_step, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as stream:
                    stream.write(text)
            else:
                one_step.write_text(text)
            ad("replay", str(one_step), "--maestro", "--timeout", "30000",
               *(part for key, value in env.items() for part in ("--env", key + "=" + str(value))),
               timeout=40, redactions=redactions)
        finally:
            one_step.unlink(missing_ok=True)
        step.clear()

    def wait_api(read_current, matches, *, timeout=15):
        deadline = time.monotonic() + timeout
        while True:
            current = read_current()
            if matches(current) or time.monotonic() >= deadline:
                return current
            time.sleep(0.25)

    for line in body.splitlines(keepends=True):
        if line.startswith("- "):
            execute()
            step.append(line)
        elif line.startswith("# @"):
            execute()
            hook = line.strip()[3:]
            if hook.startswith("collaboration-"):
                collaboration.action(sys.modules[__name__], env, hook.removeprefix("collaboration-"))
                continue
            if hook.startswith("compaction-"):
                compaction.action(sys.modules[__name__], env, hook.removeprefix("compaction-"))
                continue
            if hook.startswith("rich-"):
                rich.action(sys.modules[__name__], env, hook.removeprefix("rich-"))
                continue
            if hook == "known-dev-overlay":
                dismiss_known_dev_overlay()
                continue
            if hook == "tap-outside":
                # Empty area near the top right; Maestro percentage points are not supported by agent-device.
                # A tap right after a theme switch can land during the re-layout and be dropped.
                time.sleep(1)
                size = phone_command([*ADB, "shell", "wm", "size"]).split()[-1]
                width, height = (int(part) for part in size.split("x"))
                phone_command([*ADB, "shell", "input", "tap", str(width * 9 // 10), str(height // 5)])
                time.sleep(0.5)
                continue
            if hook == "select-all":
                # Native Ctrl+A replaces even Chinese names without installing/changing the user's IME.
                phone_command([*ADB, "shell", "input", "keycombination", "113", "29"])
                continue
            if hook == "pairing-original-dev":
                assert_pairing_selection(ad("snapshot", "-i")["nodes"], GATEWAY, "开发连接", current=True)
                env["PAIRING_ORIGINAL_DEV"] = True
                continue
            if hook == "pairing-issue":
                pairing.issue(env["PAIR_DEVICE_NAME"])
                continue
            if hook == "pairing-exchanged":
                connection = pairing.assert_paired()
                env["PAIR_COMPUTER_NAME"] = connection["computer_name"]
                continue
            if hook == "pairing-fixture-current":
                assert_pairing_selection(ad("snapshot", "-i")["nodes"], env["PAIRING_URL"], "手动输入", current=True)
                continue
            if hook == "pairing-fixture-selected":
                assert_pairing_selection(ad("snapshot", "-i")["nodes"], env["PAIRING_URL"], "手动输入", current=False)
                continue
            if hook == "pairing-dev-selected":
                assert_pairing_selection(ad("snapshot", "-i")["nodes"], GATEWAY, "开发连接", current=False)
                continue
            if hook == "pairing-dev-current":
                assert_pairing_selection(ad("snapshot", "-i")["nodes"], GATEWAY, "开发连接", current=True)
                continue
            if hook == "pairing-restore-dev":
                restore_pairing_connection(pairing, env)
                continue
            if hook == "pairing-revoked":
                pairing.assert_revoked()
                continue
            if hook == "pairing-dev-restored":
                assert_pairing_selection(ad("snapshot", "-i")["nodes"], GATEWAY, "开发连接", current=True)
                assert api("/connection")["pairing_method"] == "development"
                env["PAIRING_RESTORED"] = True
                home()
                continue
            if hook == "created-agent":
                deadline = time.monotonic() + 15
                while True:
                    matches = [agent for agent in api("/agents")["agents"] if agent["name"] == env["NEW_NAME"]]
                    if matches or time.monotonic() >= deadline:
                        break
                    time.sleep(0.25)
                assert len(matches) == 1, "Created Agent name is not unique"
                env["NEW_AGENT_ID"] = matches[0]["id"]
                owned_agents.append(matches[0]["id"])
            elif hook == "code-mode-created-on":
                assert api(agent_path(env["NEW_AGENT_ID"]))["code_mode"] is True
            elif hook == "edited-agent":
                deadline = time.monotonic() + 15
                while True:
                    saved = api(agent_path(env["NEW_AGENT_ID"]))
                    if (saved["name"] == env["RENAMED_NAME"]
                            and saved["reasoning_effort"] == env["EDIT_EFFORT"]) or time.monotonic() >= deadline:
                        break
                    time.sleep(0.25)
                assert saved["name"] == env["RENAMED_NAME"], "Agent rename did not persist"
                assert saved["reasoning_effort"] == env["EDIT_EFFORT"], "Agent reasoning change did not persist"
            elif hook == "code-mode-agent-off":
                saved = wait_api(lambda: api(agent_path(env["NEW_AGENT_ID"])),
                                 lambda value: value["code_mode"] is False)
                assert saved["code_mode"] is False, saved
            elif hook == "code-mode-capability-on":
                identity = env["CAPABILITY_AGENT_ID"]
                assert api(agent_path(identity))["code_mode"] is True
                rows = api(agent_path(identity) + "/capabilities")["capabilities"]
                assert next(row for row in rows if row["id"] == "code_mode")["status"] == "enabled", rows
            elif hook in ("code-mode-capability-off", "code-mode-capability-restored"):
                identity = env["CAPABILITY_AGENT_ID"]
                enabled = hook == "code-mode-capability-restored"
                rows = wait_api(lambda: api(agent_path(identity) + "/capabilities")["capabilities"],
                                lambda current: next(row for row in current if row["id"] == "code_mode")["status"]
                                == ("enabled" if enabled else "disabled"))
                assert api(agent_path(identity))["code_mode"] is enabled
                assert next(row for row in rows if row["id"] == "code_mode")["status"] == (
                    "enabled" if enabled else "disabled"), rows
            elif hook == "settings-entry":
                nodes = ad("snapshot", "-i")["nodes"]
                ids = [node.get("id", node.get("identifier")) for node in nodes]
                assert ids.count("settings-about-connection") == 1, "About/connection entry is not unique"
                assert "settings-gateway-connection" not in ids, "Legacy gateway entry remains"
            elif hook == "quota-loaded":
                usage = api("/usage/subscription")["usage"]
                if usage and usage["windows"]:
                    ad("wait", 'id="settings-subscription-window-0"', "10000")
            elif hook == "settings-saved":
                expected = {"default_model": env["DEFAULT_MODEL"],
                            "default_reasoning_effort": env["DEFAULT_EFFORT"]}
                assert api("/settings") == expected, "Saved default model/effort differs from selection"
            elif hook == "new-form-default":
                nodes = ad("snapshot", "-i")["nodes"]
                identity = "editor-reasoning-" + env["DEFAULT_EFFORT"]
                matching = [node for node in nodes
                            if node.get("id", node.get("identifier")) == identity]
                assert len(matching) == 1, "New Agent form has no matching reasoning control"
                state = matching[0].get("state")
                selected = matching[0].get("selected", matching[0].get("checked"))
                if selected is None and isinstance(state, dict):
                    selected = state.get("selected", state.get("checked"))
                assert selected is True or selected == "true" or "已选" in matching[0].get("label", ""), (
                    "New Agent form did not select the saved effort"
                )
            elif hook in ("agent-model-saved", "agent-model-restored"):
                target = ("CHANGED_MODEL", "CHANGED_EFFORT") if hook == "agent-model-saved" else (
                    "ORIGINAL_MODEL", "ORIGINAL_EFFORT")
                deadline = time.monotonic() + 15
                while True:
                    saved = api(agent_path(env["MODEL_AGENT_ID"]))
                    if ((saved["model"], saved["reasoning_effort"]) ==
                            (env[target[0]], env[target[1]])) or time.monotonic() >= deadline:
                        break
                    time.sleep(0.25)
                assert (saved["model"], saved["reasoning_effort"]) == (
                    env[target[0]], env[target[1]]), "Agent model/effort edit did not persist"
            elif hook == "external-rename":
                api(agent_path(env["NEW_AGENT_ID"]), "PATCH", {"name": env["EXTERNAL_NAME"]})
            elif hook == "external-agent":
                env["REMOTE_ID"] = create_owned_agent("E2E remote " + run_id)
            elif hook == "external-delete":
                api(agent_path(env["REMOTE_ID"]), "DELETE")
            elif hook == "blocked-agent":
                target = api(agent_path(env["NEW_AGENT_ID"]))
                assert any(api(agent_path(parent_id))["name"] == env["REFERENCE_NAME"]
                           for parent_id in target["member_of"]), (
                    "Referenced Agent was deleted or lost its member relationship"
                )
            elif hook == "reference-agent":
                reference = create_owned_agent("E2E reference " + run_id, [env["NEW_AGENT_ID"]])
                env["REFERENCE_NAME"] = api(agent_path(reference))["name"]
            elif hook == "connector-created":
                deadline = time.monotonic() + 15
                while True:
                    matches = [item for item in api("/connectors")["connectors"]
                               if item["name"] == env["CONNECTOR_NAME"]]
                    if matches or time.monotonic() >= deadline:
                        break
                    time.sleep(0.25)
                assert len(matches) == 1, "UI-created connector name is not unique"
                env["CONNECTOR_ID"] = matches[0]["id"]
                owned_connectors.append(matches[0]["id"])
                assert matches[0]["url"] == "https://mcp.deepwiki.com/mcp"
                assert matches[0]["used_by"] == []
                assert "transport" not in matches[0], "UI creation must leave transport unspecified"
            elif hook in ("connector-secret-saved", "connector-secret-redacted"):
                detail = wait_api(
                    lambda: api(connector_path(env["CONNECTOR_ID"])),
                    lambda current: current.get("headers", {}).get("X-E2E-Check") is True,
                )
                assert detail.get("headers", {}).get("X-E2E-Check") is True, (
                    "Connector secret header was not saved as a set-but-unreadable value"
                )
                assert env["CONNECTOR_SECRET"] not in json.dumps(detail), "Gateway leaked connector secret"
                if hook == "connector-secret-redacted":
                    nodes = ad("snapshot", "-i")["nodes"]
                    assert env["CONNECTOR_SECRET"] not in json.dumps(nodes, ensure_ascii=False), (
                        "Editor exposed the previously saved secret"
                    )
            elif hook == "connector-tested":
                detail = api(connector_path(env["CONNECTOR_ID"]))
                assert detail["status"] == "connected" and detail["tool_count"] > 0, (
                    "Connector UI test did not expose a positive tool count"
                )
                env["TOOL_COUNT"] = detail["tool_count"]
            elif hook == "connector-selected":
                detail = wait_api(
                    lambda: api(agent_path(env["CONNECTOR_AGENT_ID"])),
                    lambda current: current["mcp_servers"] == [env["CONNECTOR_ID"]],
                )
                assert detail["mcp_servers"] == [env["CONNECTOR_ID"]], "Direct connector selection was not saved"
                assert detail["searchable_mcp_servers"] == [], "Direct connector became searchable"
                users = api(connector_path(env["CONNECTOR_ID"]))["used_by"]
                assert users == [{"id": env["CONNECTOR_AGENT_ID"], "name": env["CONNECTOR_AGENT_NAME"]}], (
                    "Connector usage did not reflect Agent selection"
                )
            elif hook == "connector-blocked":
                detail = api(connector_path(env["CONNECTOR_ID"]))
                assert detail["used_by"], "Blocked connector was deleted or lost its user"
            elif hook == "connector-unselected":
                detail = wait_api(
                    lambda: api(agent_path(env["CONNECTOR_AGENT_ID"])),
                    lambda current: not current["mcp_servers"] and not current["searchable_mcp_servers"],
                )
                assert not detail["mcp_servers"] and not detail["searchable_mcp_servers"], (
                    "Agent retained connector after unselecting"
                )
                assert not api(connector_path(env["CONNECTOR_ID"]))["used_by"], "Connector still reports usage"
            elif hook == "connector-search-disabled":
                identity = "editor-connector-search-" + env["CONNECTOR_ID"]
                nodes = ad("snapshot", "-i")["nodes"]
                matches = [node for node in nodes
                           if node.get("id", node.get("identifier")) == identity]
                assert len(matches) == 1, "Search mode control is missing"
                node = matches[0]
                state = node.get("state") if isinstance(node.get("state"), dict) else {}
                assert (
                    node.get("enabled", state.get("enabled")) in (False, "false")
                    or node.get("disabled", state.get("disabled")) in (True, "true")
                    or node.get("hittable") is False
                ), "Search mode must be disabled when the connector has no description"
            elif hook == "connector-deleted":
                remaining = wait_api(
                    lambda: api("/connectors")["connectors"],
                    lambda current: env["CONNECTOR_ID"] not in {item["id"] for item in current},
                )
                assert env["CONNECTOR_ID"] not in {item["id"] for item in remaining}, (
                    "UI-deleted connector remains"
                )
            elif hook == "external-connector":
                owned_connector_names.add(env["EXTERNAL_CONNECTOR_NAME"])
                result = api("/connectors", "POST", {
                    "client_id": "e2e-connector-" + uuid4().hex,
                    "name": env["EXTERNAL_CONNECTOR_NAME"],
                    "description": "", "url": "https://mcp.deepwiki.com/mcp",
                    "transport": "streamable-http",
                })
                env["EXTERNAL_CONNECTOR_ID"] = result["connector"]["id"]
                owned_connectors.append(env["EXTERNAL_CONNECTOR_ID"])
            elif hook == "local-connector-created":
                matches = wait_api(
                    lambda: [item for item in api("/connectors")["connectors"]
                             if item["name"] == env["LOCAL_CONNECTOR_NAME"]],
                    bool,
                )
                assert len(matches) == 1, "UI-created local connector name is not unique"
                env["LOCAL_CONNECTOR_ID"] = matches[0]["id"]
                owned_connectors.append(env["LOCAL_CONNECTOR_ID"])
                assert matches[0]["command"] == "fixture-mcp"
                assert matches[0]["args"] == [env["LOCAL_ARGUMENT"], ""], (
                    "Local argument boundaries or empty argument were not saved"
                )
                assert matches[0]["used_by"] == [], "Local fixture must not launch a command"
            elif hook == "local-argument-value":
                nodes = ad("snapshot", "-i")["nodes"]
                field = next((node for node in nodes
                              if node.get("id", node.get("identifier")) == "connector-arg-0"), None)
                assert env["LOCAL_ARGUMENT"] in json.dumps(
                    field, ensure_ascii=False
                ), "Local argument was not restored to the editor"
            elif hook == "local-arguments-roundtrip":
                assert api(connector_path(env["LOCAL_CONNECTOR_ID"]))["args"] == [
                    env["LOCAL_ARGUMENT"], "",
                ]
                nodes = ad("snapshot", "-i")["nodes"]
                assert any(node.get("id", node.get("identifier")) == "connector-arg-1"
                           for node in nodes), "Empty local argument was not restored"
            elif hook == "external-transport-preserved":
                detail = wait_api(
                    lambda: api(connector_path(env["EXTERNAL_CONNECTOR_ID"])),
                    lambda current: current["description"] == "Edited without transport",
                )
                assert detail["transport"] == "streamable-http", "Editing overwrote the existing transport"
            elif hook == "external-connector-change":
                changed = api(connector_path(env["EXTERNAL_CONNECTOR_ID"]), "PATCH", {
                    "name": env["EXTERNAL_CONNECTOR_RENAMED"],
                })["connector"]
                assert changed["name"] == env["EXTERNAL_CONNECTOR_RENAMED"]
            elif hook == "external-connector-delete":
                api(connector_path(env["EXTERNAL_CONNECTOR_ID"]), "DELETE")
            elif hook == "background-connector":
                name = "E2E background connector " + run_id
                owned_connector_names.add(name)
                result = api("/connectors", "POST", {
                    "client_id": "e2e-connector-" + uuid4().hex,
                    "name": name, "url": "https://mcp.deepwiki.com/mcp",
                })
                env["BACKGROUND_CONNECTOR_ID"] = result["connector"]["id"]
                owned_connectors.append(env["BACKGROUND_CONNECTOR_ID"])
                selected = api(agent_path(env["CONNECTOR_AGENT_ID"]), "PATCH", {
                    "mcp_servers": [env["BACKGROUND_CONNECTOR_ID"]],
                })
                assert selected["agent"]["mcp_servers"] == [env["BACKGROUND_CONNECTOR_ID"]]
            elif hook == "background-external-unselect":
                changed = api(agent_path(env["CONNECTOR_AGENT_ID"]), "PATCH", {
                    "mcp_servers": [],
                })
                assert changed["event"] is not None
                assert not api(connector_path(env["BACKGROUND_CONNECTOR_ID"]))["used_by"]
                env["NO_EVENT_CURSOR"] = api("/connectors")["as_of_seq"]
            elif hook == "background-no-event-save":
                assert api("/connectors")["as_of_seq"] == env["NO_EVENT_CURSOR"], (
                    "Saving the already-removed relationship unexpectedly emitted an event"
                )
                assert not api(agent_path(env["CONNECTOR_AGENT_ID"]))["mcp_servers"]
            elif hook == "background-reselect":
                selected = api(agent_path(env["CONNECTOR_AGENT_ID"]), "PATCH", {
                    "mcp_servers": [env["BACKGROUND_CONNECTOR_ID"]],
                })
                assert selected["agent"]["mcp_servers"] == [env["BACKGROUND_CONNECTOR_ID"]]
                assert api(connector_path(env["BACKGROUND_CONNECTOR_ID"]))["used_by"] == [{
                    "id": env["CONNECTOR_AGENT_ID"], "name": env["CONNECTOR_AGENT_NAME"],
                }]
            elif hook == "background-external-delete":
                changed = api(agent_path(env["CONNECTOR_AGENT_ID"]), "PATCH", {
                    "mcp_servers": [],
                })
                assert changed["event"] is not None
                deleted = api(connector_path(env["BACKGROUND_CONNECTOR_ID"]), "DELETE")
                assert deleted["event"]["data"]["op"] == "deleted"
            elif hook == "assert-agent-draft":
                nodes = ad("snapshot", "-i")["nodes"]
                description = next((node for node in nodes
                                    if node.get("id", node.get("identifier")) == "editor-description"), None)
                assert description is not None and env["DRAFT_MARKER"] in json.dumps(
                    description, ensure_ascii=False
                ), "Background connector deletion discarded the unsaved Agent draft"
            elif hook == "skill-blocked":
                path = "/skills/" + quote(env["SKILL_NAME"], safe="")
                try:
                    api(path, "DELETE")
                except HTTPError as error:
                    body = json.load(error)
                    assert error.code == 409, body
                    assert body["error"]["details"]["used_by"] == [{
                        "id": env["SKILL_AGENT_ID"], "name": env["SKILL_AGENT_NAME"],
                    }], body
                else:
                    raise AssertionError("Referenced skill was deleted")
                assert api(path)["status"] == "ok"
            elif hook == "skill-unselect":
                api(agent_path(env["SKILL_AGENT_ID"]), "PATCH", {"skills": []})
                assert api("/skills/" + quote(env["SKILL_NAME"], safe=""))["used_by"] == []
            elif hook == "skill-deleted":
                remaining = wait_api(
                    lambda: api("/skills")["skills"],
                    lambda current: env["SKILL_NAME"] not in {item["name"] for item in current},
                )
                assert env["SKILL_NAME"] not in {item["name"] for item in remaining}, (
                    "UI-deleted skill remains"
                )
                assert not (WORKSPACE / ".wandrun" / "skills" / env["SKILL_NAME"]).exists()
            elif hook == "skill-external-delete":
                result = api("/skills/" + quote(env["BROKEN_SKILL_NAME"], safe=""), "DELETE")
                assert result["event"]["data"] == {
                    "kind": "skill", "id": env["BROKEN_SKILL_NAME"], "op": "deleted",
                }, result
            elif hook == "skill-import-draft":
                nodes = ad("snapshot", "-i")["nodes"]
                field = next((node for node in nodes
                              if node.get("id", node.get("identifier")) == "composer-input"), None)
                assert field is not None and "帮我导入这个技能：" in json.dumps(field, ensure_ascii=False), field
                conversation = next(item for item in api("/conversations")["conversations"]
                                    if item["id"] == env["SKILL_IMPORT_CONVERSATION_ID"])
                assert conversation["agent_id"] == env["SKILL_DEFAULT_AGENT_ID"]
                events = api(conversation_path(conversation["id"]) + "/events?limit=200")["events"]
                assert not any(row["type"] in ("message.user", "message.agent") for row in events), events
            elif hook == "skill-clear-draft":
                phone_command([*ADB, "shell", "input", "keycombination", "113", "29"])
                phone_command([*ADB, "shell", "input", "keyevent", "67"])
            elif hook == "memory-ui-saved":
                current = wait_api(
                    lambda: api(agent_path(env["MEMORY_AGENT_ID"]) + "/memory"),
                    lambda snapshot: snapshot["content"] == env["MEMORY_SAVED"],
                )
                assert current["content"] == env["MEMORY_SAVED"] and current["updated_by"] == "user", (
                    "Editor did not save the complete Markdown body"
                )
            elif hook == "memory-external-view":
                current = api(agent_path(env["MEMORY_AGENT_ID"]) + "/memory")
                new_content = env["MEMORY_REMOTE"]
                saved = api(agent_path(env["MEMORY_AGENT_ID"]) + "/memory", "PUT", {
                    "content": new_content, "version": current["version"],
                })
                assert saved["content"] == new_content
            elif hook == "memory-external-file":
                identity = env["MEMORY_AGENT_ID"]
                assert identity in owned_agents, "Only this run's Agent memory may be changed"
                memory_path = WORKSPACE / ".wandrun" / "state" / "memory" / f"{identity}.md"
                assert memory_path.read_text(encoding="utf-8") == env["MEMORY_REMOTE"]
                env["MEMORY_NO_EVENT_CURSOR"] = api("/agents")["as_of_seq"]
                # Bypass managed PUT deliberately: an external file edit emits no event.
                memory_path.write_text(env["MEMORY_FILE_BODY"], encoding="utf-8")
                current = api(agent_path(identity) + "/memory")
                assert current["content"] == env["MEMORY_FILE_BODY"] and current["updated_by"] == "external"
                assert api("/agents")["as_of_seq"] == env["MEMORY_NO_EVENT_CURSOR"]
            elif hook == "memory-unchanged-saved":
                current = api(agent_path(env["MEMORY_AGENT_ID"]) + "/memory")
                assert current["content"] == env["MEMORY_FILE_BODY"] and current["updated_by"] == "external"
                assert api("/agents")["as_of_seq"] == env["MEMORY_NO_EVENT_CURSOR"], (
                    "External edit or unchanged save unexpectedly emitted an event"
                )
            elif hook == "memory-external-conflict":
                current = api(agent_path(env["MEMORY_AGENT_ID"]) + "/memory")
                identity = env["MEMORY_CONVERSATION_ID"]
                api(conversation_path(identity) + "/messages", "POST", {
                    "client_id": "e2e-memory-conflict-" + uuid4().hex,
                    "text": f"记住：本项目发布说明的固定标签是 release-{run_id}。保留其他记忆。",
                })
                wait_api(
                    lambda: next(row for row in api("/conversations")["conversations"] if row["id"] == identity),
                    lambda row: row["status"] != "working",
                    timeout=180,
                )
                changed = api(agent_path(env["MEMORY_AGENT_ID"]) + "/memory")
                assert changed["version"] != current["version"] and changed["updated_by"] == "agent", (
                    "Real Agent did not update memory while the phone draft was open"
                )
            elif hook == "memory-draft-retained":
                nodes = ad("snapshot", "-i")["nodes"]
                field = next((node for node in nodes
                              if node.get("id", node.get("identifier")) == "memory-editor-input"), None)
                assert field is not None and env["MEMORY_DRAFT"] in json.dumps(
                    field, ensure_ascii=False
                ), "Memory conflict/reload discarded the unsaved draft"
            elif hook == "memory-conflict-saved":
                current = wait_api(
                    lambda: api(agent_path(env["MEMORY_AGENT_ID"]) + "/memory"),
                    lambda snapshot: snapshot["content"] == env["MEMORY_DRAFT"],
                )
                assert current["content"] == env["MEMORY_DRAFT"] and current["updated_by"] == "user", (
                    "Explicit reload did not permit saving the retained draft"
                )
            elif hook == "memory-member-link":
                fixture = api("/conversations", "POST", {"agent_id": env["MEMORY_PARENT_ID"]})
                fixtures.append(fixture["id"])
                marker = "memory-" + run_id
                api(conversation_path(fixture["id"]) + "/messages", "POST", {
                    "client_id": "e2e-member-" + uuid4().hex,
                    "text": (
                        f"请委派给 {env['MEMORY_MEMBER_ID']}：用户明确要求长期记住，"
                        f"本项目发布说明的固定标签是 {marker}。请成员保存到它自己的记忆，"
                        "完成后只回复已记住。你自己不要写记忆。"
                    ),
                })
                wait_api(
                    lambda: next(row for row in api("/conversations")["conversations"] if row["id"] == fixture["id"]),
                    lambda row: row["status"] != "working",
                    timeout=180,
                )
                events = api(conversation_path(fixture["id"]) + "/events?limit=200")["events"]
                updates = [row for row in events if row["type"] == "memory.updated"]
                assert updates and all(row["data"]["agent_id"] == env["MEMORY_MEMBER_ID"] for row in updates), (
                    "Delegated memory update must belong to member and source root conversation"
                )
                ad("press", 'id=' + json.dumps("agent-row-" + env["MEMORY_PARENT_ID"]))
                target = "memory-updated-" + str(updates[-1]["seq"])
                ad("wait", 'id=' + json.dumps(target), "10000")
                ad("screenshot", str(OUT / ("11-memory-system-system.png" if PRESERVE_SYSTEM_THEME else "11-memory-system-light.png")))
                if PRESERVE_SYSTEM_THEME:
                    skipped_dark_screenshots.append(str(OUT / "12-memory-system-dark.png"))
                else:
                    set_theme("yes")
                    ad("screenshot", str(OUT / "12-memory-system-dark.png"))
                ad("press", 'id=' + json.dumps(target))
                ad("wait", 'id="profile-memory-content"', "10000")
                nodes = ad("snapshot", "-i")["nodes"]
                assert marker in json.dumps(nodes, ensure_ascii=False), "Memory event opened the wrong Agent's memory"
                if PRESERVE_SYSTEM_THEME:
                    skipped_dark_screenshots.append(str(OUT / "13-member-memory-link-dark.png"))
                else:
                    ad("screenshot", str(OUT / "13-member-memory-link-dark.png"))
                    set_theme("no")
                home()
            elif hook == "schedule-ui-created":
                rows = wait_api(lambda: api(agent_path(env["SCHEDULE_AGENT_ID"]) + "/schedules")["schedules"],
                                lambda items: any(row["name"] == env["SCHEDULE_NAME"] for row in items))
                matches = [row for row in rows if row["name"] == env["SCHEDULE_NAME"]]
                assert len(matches) == 1 and matches[0]["rule"] == {"kind": "daily", "time": "08:00"}
                assert matches[0]["timezone"] == env["SCHEDULE_ZONE"]
                env["SCHEDULE_ID"] = matches[0]["id"]
            elif hook == "schedule-edited":
                row = wait_api(lambda: api("/schedules/" + quote(env["SCHEDULE_ID"], safe="")),
                               lambda item: item["name"] == env["SCHEDULE_EDITED_NAME"])
                assert row["content"] == "Reply edited" and row["rule"] == {"kind": "daily", "time": "08:00"}
            elif hook == "schedule-paused":
                row = wait_api(lambda: api("/schedules/" + quote(env["SCHEDULE_ID"], safe="")),
                               lambda item: not item["enabled"])
                assert row["enabled"] is False and row["next_run_at"] is None
            elif hook == "schedule-reenabled":
                row = wait_api(lambda: api("/schedules/" + quote(env["SCHEDULE_ID"], safe="")),
                               lambda item: item["enabled"])
                assert row["next_run_at"] > time.time()
            elif hook in ("schedule-weekly", "schedule-cron"):
                expected = ({"kind": "weekly", "time": "08:00", "weekdays": [1, 5]}
                            if hook == "schedule-weekly" else {"kind": "cron", "expression": "0 8 * * 1,5"})
                wait_api(lambda: api("/schedules/" + quote(env["SCHEDULE_ID"], safe="")),
                         lambda item: item["rule"] == expected)
            elif hook == "schedule-external-edit":
                api("/schedules/" + quote(env["SCHEDULE_ID"], safe=""), "PATCH",
                    {"name": env["SCHEDULE_REMOTE_NAME"]})
            elif hook == "schedule-draft-retained":
                field = next(node for node in ad("snapshot", "-i")["nodes"]
                             if node.get("id", node.get("identifier")) == "schedule-content")
                assert env["SCHEDULE_DRAFT"] in json.dumps(field, ensure_ascii=False), "SSE discarded schedule draft"
            elif hook == "schedule-draft-saved":
                row = wait_api(lambda: api("/schedules/" + quote(env["SCHEDULE_ID"], safe="")),
                               lambda item: item["content"] == env["SCHEDULE_DRAFT"])
                assert row["name"] == env["SCHEDULE_REMOTE_NAME"], "Saving content overwrote external name edit"
            elif hook == "schedule-agent-created":
                when = (datetime.now(ZoneInfo(env["SCHEDULE_ZONE"])) + timedelta(minutes=2)).replace(second=0, microsecond=0)
                local_at = when.strftime("%Y-%m-%dT%H:%M")
                api(conversation_path(env["SCHEDULE_CHAT_ID"]) + "/messages", "POST", {
                    "client_id": "e2e-agent-schedule-" + uuid4().hex,
                    "text": (
                        "请现在调用 create_schedule 工具为你自己创建定时；不要只回复文字。"
                        f"名称必须精确为 {env['AGENT_SCHEDULE_NAME']}，"
                        f"执行内容为“只回复好的”，规则为单次，local_at 必须精确为 {local_at}，"
                        f"时区为 {env['SCHEDULE_ZONE']}。创建成功后只回复定时 id。"
                    ),
                })
                rows = wait_api(lambda: api(agent_path(env["SCHEDULE_AGENT_ID"]) + "/schedules")["schedules"],
                                lambda items: any(row["name"] == env["AGENT_SCHEDULE_NAME"] for row in items),
                                timeout=180)
                matching = [row for row in rows if row["name"] == env["AGENT_SCHEDULE_NAME"]]
                assert len(matching) == 1 and matching[0]["rule"] == {"kind": "once", "local_at": local_at}
                env["AGENT_SCHEDULE_ID"] = matching[0]["id"]
            elif hook == "schedule-external":
                zone = env["SCHEDULE_ZONE"]
                result = api(agent_path(env["SCHEDULE_AGENT_ID"]) + "/schedules", "POST", {
                    "client_id": "e2e-schedule-" + uuid4().hex,
                    "name": env["EXTERNAL_SCHEDULE_NAME"], "content": "只回复好的",
                    "rule": {"kind": "cron", "expression": "30 6 * * 1-5"}, "enabled": False,
                    "timezone": zone,
                })
                env["EXTERNAL_SCHEDULE_ID"] = result["schedule"]["id"]
            elif hook == "schedule-triggered":
                identity = env["AGENT_SCHEDULE_ID"]
                row = wait_api(lambda: api("/schedules/" + quote(identity, safe="") + "/runs")["runs"],
                               lambda runs: any(run["status"] == "completed" and run["conversation_id"] for run in runs), timeout=240)
                linked = next(run for run in row if run["conversation_id"])
                env["SCHEDULE_RUN_ID"] = linked["id"]
                env["SCHEDULE_CONVERSATION_ID"] = linked["conversation_id"]
                fixtures.append(linked["conversation_id"])
                conversation = next(row for row in api("/conversations")["conversations"]
                                    if row["id"] == linked["conversation_id"])
                assert conversation["source"] == "schedule"
                assert conversation["schedule_origin"]["schedule_id"] == identity
                events = api(conversation_path(linked["conversation_id"]) + "/events")["events"]
                assert {"schedule.triggered", "message.user", "message.agent"} <= {event["type"] for event in events}
                assert any("好的" in str(event["data"]) for event in events if event["type"] == "message.agent")
                assert len(row) == 1 and linked["status"] == "completed"
                home_row = next(item for item in api("/agents")["agents"] if item["id"] == env["SCHEDULE_AGENT_ID"])
                assert home_row["latest_conversation"]["id"] == linked["conversation_id"]
                env["SCHEDULE_TRIGGER_SEQ"] = next(event["seq"] for event in events if event["type"] == "schedule.triggered")
            elif hook in ("schedule-source-header", "schedule-source-drawer"):
                target = ("chat-conversation-title" if hook == "schedule-source-header"
                          else "conversation-" + env["SCHEDULE_CONVERSATION_ID"])
                node = next((node for node in ad("snapshot")["nodes"]
                             if node.get("id", node.get("identifier")) == target), None)
                assert node is not None, f"Source marker node is missing: {target}"
                assert "定时" in json.dumps(node, ensure_ascii=False), "Schedule source marker is missing"
            elif hook == "schedule-deleted":
                rows = wait_api(lambda: api(agent_path(env["SCHEDULE_AGENT_ID"]) + "/schedules")["schedules"],
                                lambda items: env["AGENT_SCHEDULE_ID"] not in {row["id"] for row in items})
                assert env["AGENT_SCHEDULE_ID"] not in {row["id"] for row in rows}
                conversation = next(item for item in api("/conversations")["conversations"]
                                    if item["id"] == env["SCHEDULE_CONVERSATION_ID"])
                assert conversation["source"] == "schedule" and conversation["schedule_origin"]["schedule_id"] == env["AGENT_SCHEDULE_ID"]
            elif hook in ("dark-mode", "light-mode"):
                if not PRESERVE_SYSTEM_THEME:
                    mode = "yes" if hook == "dark-mode" else "no"
                    set_theme(mode)
                    actual = phone_command([*ADB, "shell", "cmd", "uimode", "night"])
                    assert mode in actual, actual
                    time.sleep(1)  # Let native appearance changes settle before the next tap.
            elif hook == "dark-management":
                if PRESERVE_SYSTEM_THEME:
                    skipped_dark_screenshots.extend(str(OUT / name) for name in (
                        "13-conversation-menu-dark.png", "14-conversation-rename-keyboard-dark.png", "15-conversation-delete-dark.png"))
                else:
                    capture_dark_management(agent)
            elif hook == "dark-profiles":
                if PRESERVE_SYSTEM_THEME:
                    skipped_dark_screenshots.extend(str(OUT / name) for name in (
                        "20-chat-header-dark.png", "21-profile-members-dark.png", "22-profile-computer-empty-dark.png",
                        "24-profile-memory-dark.png", "23-profile-empty-members-dark.png"))
                else:
                    capture_dark_profiles(env)
            elif hook == "release-reference":
                reference = owned_agents[-1]
                api(agent_path(reference), "DELETE")
                assert not api(agent_path(env["NEW_AGENT_ID"]))["member_of"]
            elif hook == "file-conversation-deleted":
                api(conversation_path(env["FILE_CONVERSATION_ID"]), "DELETE")
                detail = api("/files/" + quote(env["FILE_ID"], safe=""))
                assert detail["available"] and detail["conversation_id"] is None, detail
                assert Path(env["FILE_PATH"]).is_file(), "Deleting chat removed the original file"
                assert any(row["kind"] == "file" and row["id"] == env["FILE_ID"]
                           for row in api("/search?q=" + quote(env["FILE_NAME"], safe=""))["results"])
            elif hook == "upload-select-document":
                select_upload_document(env)
            elif hook == "pdf-reply":
                await_media_reply(env)
                ad("wait", "label=" + json.dumps(env["PDF_MARKER"]), "10000")
            elif hook == "image-request":
                api(conversation_path(env["IMAGE_CONVERSATION_ID"]) + "/messages", "POST", {
                    "client_id": "e2e-image-" + uuid4().hex,
                    "text": "请调用 generate_image 生成一张白底蓝色圆形的简单图片，并把返回的原文件作为附件发给 human。失败时原样报告错误代码、详情及重置时间，不要重试。",
                })
                await_media_reply(env, image=True)
            elif hook == "upload-message-sent":
                events = wait_api(
                    lambda: api(conversation_path(env["UPLOAD_CONVERSATION_ID"]) + "/events?limit=200")["events"],
                    lambda rows: any(row["type"] == "message.user" for row in rows),
                )
                messages = [row["data"] for row in events if row["type"] == "message.user"]
                assert len(messages) == 1 and messages[0]["text"] == env["UPLOAD_PROMPT"], messages
                attachments = messages[0]["attachments"]
                assert len(attachments) == 1 and attachments[0]["name"] == env["UPLOAD_NAME"], attachments
                env["UPLOAD_FILE_ID"] = attachments[0]["id"]
                assert Path(env["UPLOAD_PATH"]).read_bytes() == Path(env["UPLOAD_LOCAL_PATH"]).read_bytes()
                detail = api("/files/" + quote(env["UPLOAD_FILE_ID"], safe=""))
                assert detail["available"] and detail["conversation_id"] == env["UPLOAD_CONVERSATION_ID"], detail
            elif hook == "file-original-removed":
                Path(env["FILE_PATH"]).unlink()
                detail = api("/files/" + quote(env["FILE_ID"], safe=""))
                assert not detail["available"] and detail["conversation_id"] is None, detail
            elif hook == "browser-taken-over":
                task = wait_api(lambda: api("/browser-tasks/" + quote(env["BROWSER_TASK_ID"], safe="")),
                                lambda current: current["state"] == "human")
                assert task["state"] == "human" and task["current"] == env["BROWSER_PAGE_ID"], task
            elif hook == "browser-input":
                assert browser_server is not None
                with browser_server.input_changed:
                    received = browser_server.input_changed.wait_for(
                        lambda: env["BROWSER_INPUT"] in browser_server.inputs, timeout=20)
                assert received, f"Phone text did not reach fixture page: {browser_server.inputs}"
                task = api("/browser-tasks/" + quote(env["BROWSER_TASK_ID"], safe=""))
                assert task["state"] == "human", task
            elif hook == "browser-handed-back":
                events = wait_api(
                    lambda: api(conversation_path(env["BROWSER_CONVERSATION_ID"]) + "/events?limit=200")["events"],
                    lambda rows: any(row["type"] == "takeover.ended"
                                     and row["data"]["id"] == env["BROWSER_TASK_ID"]
                                     and row["data"]["text"].endswith("已交还") for row in rows),
                )
                matching = [row for row in events if row["type"] == "takeover.ended"
                            and row["data"]["id"] == env["BROWSER_TASK_ID"]
                            and row["data"]["text"].endswith("已交还")]
                assert len(matching) == 1, "Handback did not create one persisted system event"
                env["TAKEOVER_SEQ"] = matching[0]["seq"]
                task = api("/browser-tasks/" + quote(env["BROWSER_TASK_ID"], safe=""))
                assert task["state"] == "agent" and task["pages"], task
            elif hook == "browser-closed":
                task = wait_api(lambda: api("/browser-tasks/" + quote(env["BROWSER_TASK_ID"], safe="")),
                                lambda current: current["state"] == "released")
                assert task["state"] == "released" and not task["pages"], task
                assert not any(item["id"] == task["id"] and item["state"] != "released"
                               for item in api("/browser-tasks")["browser_tasks"])
            else:
                raise RuntimeError("Unknown regression hook: " + hook)
        elif step:
            # Comments directly after a hook belong to no command; only continuation lines are kept.
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
    """Select by the saved computer's exact URL, never by shared display name."""
    target = url.rstrip("/")
    rows = [node.get("id", node.get("identifier")) for node in nodes
            if str(node.get("id", node.get("identifier")) or "").startswith("connection-computer-")
            and str(node.get("label") or "").split(", ")[-1].rstrip("/") == target]
    if len(rows) != 1:
        raise RuntimeError("Cannot identify a unique saved development computer at " + url)
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
                if is_current:
                    home()
                    env["PAIRING_RESTORED"] = True
                    return
                replay_steps("pairing", env, pairing=pairing, source="""appId: host.exp.exponent
---
- tapOn:
    id: connection-switch
""")
            else:
                row = pairing_computer_row(nodes, GATEWAY)
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
- tapOn: 设置
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
- tapOn: 设置
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
    return "SKIP" if results and all(result["status"] == "SKIP" for result in results) else "PASS"


def run_group(group):
    """Own temporary data until cleanup; failure is reported without skipping later groups."""
    global OUT, fixtures, owned_agents, owned_agent_names, owned_connectors, owned_connector_names, run_id, skipped_dark_screenshots
    OUT = run_out / group
    OUT.mkdir()
    started = time.monotonic()
    fixtures, owned_agents, owned_connectors = [], [], []
    skipped_dark_screenshots = []
    run_id = uuid4().hex[:10]
    owned_agent_names = {f"E2E {kind} {run_id}" for kind in ("Agent", "Edited", "Synced")}
    owned_connector_names = {
        f"E2E DeepWiki {run_id}", f"E2E external connector {run_id}",
        f"E2E changed connector {run_id}",
        f"E2E local connector {run_id}",
    }
    error = None
    browser_server = None
    settings_original = None
    pairing = None
    env = {"ARTIFACTS": str(OUT),
           "NEW_NAME": "E2E Agent " + run_id, "RENAMED_NAME": "E2E Edited " + run_id,
           "EXTERNAL_NAME": "E2E Synced " + run_id}
    if agent is not None:
        env.update({"AGENT_ID": agent["id"], "USAGE_AGENT_ID": agent["id"]})
    try:
        require_expo()
        if group == "collaboration":
            collaboration.prepare(sys.modules[__name__], env)
        elif group == "compaction":
            compaction.prepare(sys.modules[__name__], env)
        elif group == "rich":
            rich.prepare(sys.modules[__name__], env)
        elif group == "drawer":
            env["OLD_ID"] = old_conversation(agent)
            fixture = api("/conversations", "POST", {"agent_id": agent["id"]})
            fixtures.append(fixture["id"])
            env["MANAGED_ID"] = fixture["id"]
        elif group == "profile":
            env.update(profile_fixture())
        elif group == "memory":
            name = "E2E memory " + run_id
            env.update({
                "MEMORY_NAME": name,
                "MEMORY_SAVED": "# E2E saved " + run_id,
                "MEMORY_SAVED_TEXT": "E2E saved " + run_id,
                "MEMORY_REMOTE": "## E2E remote " + run_id + "\n\n- Write summaries in Chinese; preserve API names.\n- Deliver Markdown without title emojis.\n\n## Project\n\nUse npm to manage dependencies.",
                "MEMORY_REMOTE_TEXT": "E2E remote " + run_id,
                "MEMORY_FILE_BODY": "E2E external file " + run_id,
                "MEMORY_DRAFT": "Draft-" + run_id,
            })
            env["MEMORY_AGENT_ID"] = create_owned_agent(name)
            fixture = api("/conversations", "POST", {"agent_id": env["MEMORY_AGENT_ID"]})
            fixtures.append(fixture["id"])
            env["MEMORY_CONVERSATION_ID"] = fixture["id"]
            env["MEMORY_MEMBER_ID"] = create_owned_agent("E2E memory member " + run_id)
            env["MEMORY_PARENT_ID"] = create_owned_agent(
                "E2E memory parent " + run_id, [env["MEMORY_MEMBER_ID"]]
            )
        elif group == "schedules":
            identity = create_owned_agent("E2E schedule " + run_id)
            zone = api(agent_path(identity) + "/schedules")["default_timezone"] or "Asia/Shanghai"
            env.update({"SCHEDULE_AGENT_ID": identity, "SCHEDULE_NAME": "E2E daily " + run_id,
                        "SCHEDULE_EDITED_NAME": "E2E edited " + run_id,
                        "SCHEDULE_REMOTE_NAME": "E2E remote " + run_id, "SCHEDULE_DRAFT": "retained draft " + run_id,
                        "AGENT_SCHEDULE_NAME": "E2E agent schedule " + run_id,
                        "EXTERNAL_SCHEDULE_NAME": "E2E external " + run_id, "SCHEDULE_ZONE": zone})
            fixture = api("/conversations", "POST", {"agent_id": identity})
            env["SCHEDULE_CHAT_ID"] = fixture["id"]
            fixtures.append(fixture["id"])
        elif group == "agent":
            env["EDIT_EFFORT"] = agent_effort_fixture()
        elif group == "settings":
            settings_original, model_env = model_fixture()
            env.update(model_env)
        elif group == "connectors":
            env.update({
                "CONNECTOR_NAME": "E2E DeepWiki " + run_id,
                "CONNECTOR_AGENT_NAME": "E2E connector Agent " + run_id,
                "EXTERNAL_CONNECTOR_NAME": "E2E external connector " + run_id,
                "EXTERNAL_CONNECTOR_RENAMED": "E2E changed connector " + run_id,
                "DRAFT_MARKER": "unsaved-" + run_id,
                "LOCAL_CONNECTOR_NAME": "E2E local connector " + run_id,
                "LOCAL_ARGUMENT": "literal with spaces",
            })
            env["CONNECTOR_AGENT_ID"] = create_owned_agent(env["CONNECTOR_AGENT_NAME"])
            env["CONNECTOR_SECRET"] = "e2e-private-" + uuid4().hex
        elif group == "skills":
            skills_fixture(env)
        elif group == "capabilities":
            identity = create_owned_agent("E2E capabilities " + run_id)
            fixture = api("/conversations", "POST", {"agent_id": identity})
            fixtures.append(fixture["id"])
            env.update({"CAPABILITY_AGENT_ID": identity, "CAPABILITY_CHAT_ID": fixture["id"]})
        elif group == "files":
            file_fixture(env)
        elif group in ("upload", "pdf"):
            upload_fixture(env, pdf=group == "pdf")
        elif group == "image":
            image_fixture(env)
        elif group == "browser":
            browser_server = start_browser_fixture(env)
            browser_fixture(env)
        elif group == "pairing":
            if api("/connection")["pairing_method"] != "development":
                raise RuntimeError("Pairing regression requires a configured development token")
            pairing = PairingFixture()
            env.update({"PAIR_DEVICE_NAME": "E2E pairing " + run_id, "DEV_URL": GATEWAY,
                        "PAIRING_URL": pairing.start()})
        (OUT / "fixture.json").write_text(json.dumps(env, ensure_ascii=False, indent=2))
        replay_steps(group, env, browser_server, pairing=pairing)
        if group == "agent":
            assert env["NEW_AGENT_ID"] not in {a["id"] for a in api("/agents")["agents"]}, "Deleted Agent remains"
        if group == "connectors":
            assert env["CONNECTOR_ID"] not in {
                item["id"] for item in api("/connectors")["connectors"]
            }, "Connector deletion did not persist"
        assert all(a["home"] for a in api("/agents")["agents"]), "Flow did not restore home membership"
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        # Foreground guard forbids captures when another application has taken over.
        capture_errors = restore([("failure screenshot", lambda: ad("screenshot", str(OUT / "failure.png")))])
    else:
        capture_errors = []
    finally:
        cleanup_errors = restore([
            ("paired fixture device", pairing.revoke_owned_device if pairing else lambda: None),
            ("development connection", lambda: restore_pairing_connection(pairing, env)
             if pairing else None),
            ("pairing bridge", pairing.close if pairing else lambda: None),
            ("browser leases", lambda: cleanup_browser_tasks(env) if group == "browser" else None),
            ("browser fixture server", lambda: stop_browser_fixture(browser_server) if browser_server else None),
            ("original e2e file", lambda: cleanup_file_fixture(env) if group == "files" else None),
            ("default settings", lambda: restore_settings(settings_original)),
            ("fixture schedules", lambda: cleanup_schedules() if group == "schedules" else None),
            ("fixture conversations", cleanup_conversations),
            ("compaction archive", lambda: compaction.cleanup(sys.modules[__name__], env) if group == "compaction" else None),
            ("upload fixture", lambda: cleanup_upload_fixture(env) if group in ("upload", "pdf") else None),
            ("image fixture", lambda: cleanup_image_fixture(env) if group == "image" else None),
            ("owned Agents", cleanup_agents),
            ("owned connectors", cleanup_connectors),
            ("owned skill directories", lambda: cleanup_skills(env) if group == "skills" else None),
        ])
    if error:
        # Recovery leaves the user's appearance untouched when theme preservation is requested.
        cleanup_errors += restore([
            ("light mode", lambda: set_theme("no")),
            ("home membership", all_home), ("home screen", home),
        ])
    result = {"group": group, "status": "FAIL" if error or cleanup_errors else "PASS",
              "elapsed_seconds": round(time.monotonic() - started, 2), "error": error,
              "cleanup_errors": capture_errors + cleanup_errors,
              "screenshots": [str(p) for p in sorted(OUT.glob("*.png"))],
              "theme_preserved": PRESERVE_SYSTEM_THEME,
              "skipped_dark_screenshots": skipped_dark_screenshots}
    (OUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


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
        all_home()
        agents = api("/agents")["agents"]
        requested = os.environ.get("E2E_AGENT_ID")
        candidates = [a for a in agents if requested is None or a["id"] == requested]
        if not candidates and selected not in (["browser"], ["pairing"]):
            raise RuntimeError("Need at least one Agent")
        agent = (next((a for a in candidates if a.get("latest_conversation")
                       and a["latest_conversation"]["status"] != "working"), candidates[0])
                 if candidates else None)
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
        ("light mode", lambda: set_theme("no")),
        ("home membership", all_home), ("home screen", home),
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
    (OUT / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    LOG.close()
    print(json.dumps(report, ensure_ascii=False, indent=2))

sys.exit(0 if report["status"] != "FAIL" else 1)
