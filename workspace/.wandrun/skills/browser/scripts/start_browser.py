#!/usr/bin/env python3
"""Start the configured Instabox Chrome, or reuse its ready CDP endpoint.

The runtime alone supplies WANDRUN_BROWSER_PORT and WANDRUN_BROWSER_PROFILE;
without both, Local must keep using its externally managed Chrome. A profile
lock covers discovery, launch and readiness. Successful Chrome processes belong
to the environment, not this command or its task, and are never stopped here.
CLI installation uses existing npm; video dependencies use existing uv in an
isolated venv. Neither path installs system packages or downloads Chrome.
New launches copy the installed browser's default UA, replacing HeadlessChrome
with Chrome. A failed five-second probe warns and retains the default headless UA.
"""

import argparse
import fcntl
from html import unescape
import http.client
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


TEMPLATE_CHROME = Path("/usr/lib/chromium/chromium")
CHROME_COMMANDS = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable")
DEFAULT_TIMEOUT_SECONDS = 10
PROBE_TIMEOUT_SECONDS = 0.5
USER_AGENT_TIMEOUT_SECONDS = 5
AGENT_BROWSER_VERSION = "0.38.1"
CLI_INSTALL_TIMEOUT_SECONDS = 180
CLI_VERSION_TIMEOUT_SECONDS = 5
VIDEO_PACKAGES = ("livekit==1.2.0", "pillow==13.0.0", "websockets==17.4")
VIDEO_CHECK = (
    "from importlib.metadata import version; from livekit import rtc; "
    "from PIL import Image; import websockets; "
    "assert all(version(name) == pinned for name, pinned in "
    + repr([package.split("==") for package in VIDEO_PACKAGES]) + ")"
)


def video_dependencies_ready(python):
    try:
        return subprocess.run(
            [str(python), "-c", VIDEO_CHECK], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=CLI_VERSION_TIMEOUT_SECONDS,
        ).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def ensure_video_publisher():
    """Install a pinned, isolated venv only here; failed installs preserve the old one."""
    root = Path(os.environ.get(
        "WANDRUN_VIDEO_PUBLISHER_DIR", "/data/home/wandrun-browser/video-publisher"))
    if not root.is_absolute():
        raise ValueError("WANDRUN_VIDEO_PUBLISHER_DIR 必须是绝对路径")
    os.umask(0o077)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (root / "install.lock").open("ab") as lock:
        os.fchmod(lock.fileno(), 0o600)
        acquire_start_lock(lock, time.monotonic() + CLI_INSTALL_TIMEOUT_SECONDS)
        python = root / "venv" / "bin" / "python"
        previous = (root / "venv").resolve() if (root / "venv").is_symlink() else None
        link = root / ".venv-next"
        link.unlink(missing_ok=True)
        for abandoned in root.glob(".install-*"):
            if abandoned.resolve() != previous:
                shutil.rmtree(abandoned)
        if video_dependencies_ready(python):
            return {"installed": False, "python": str(python)}
        uv = shutil.which("uv")
        if not uv:
            raise RuntimeError("视频推流依赖安装失败：PATH 中找不到 uv")
        stage = Path(tempfile.mkdtemp(prefix=".install-", dir=root))
        published = False
        try:
            for command in (
                [uv, "venv", "--python", sys.executable, str(stage)],
                [uv, "pip", "install", "--python", str(stage / "bin/python"), *VIDEO_PACKAGES],
            ):
                result = subprocess.run(
                    command, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                    timeout=CLI_INSTALL_TIMEOUT_SECONDS,
                )
                if result.returncode:
                    raise RuntimeError("视频推流依赖安装失败（退出码 %s）：%s" % (
                        result.returncode, (result.stderr or result.stdout).strip()))
            if not video_dependencies_ready(stage / "bin/python"):
                raise RuntimeError("视频推流依赖安装后导入 / 固定版本校验失败")
            link.symlink_to(stage.name)
            link.replace(root / "venv")
            published = True
            if previous is not None and previous.parent == root and previous.name.startswith(".install-"):
                shutil.rmtree(previous)
            return {"installed": True, "python": str(python)}
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("视频推流依赖安装超时（请检查网络 / Python registry）") from error
        finally:
            link.unlink(missing_ok=True)
            if not published:
                shutil.rmtree(stage)


def cli_version_matches(executable):
    try:
        result = subprocess.run(
            [str(executable), "--version"], stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=CLI_VERSION_TIMEOUT_SECONDS,
        )
        return result.returncode == 0 and result.stdout.strip() == (
            "agent-browser " + AGENT_BROWSER_VERSION)
    except (OSError, subprocess.TimeoutExpired):
        return False


def ensure_agent_browser():
    """Publish a validated npm install atomically; serialize all environment users.

    Only the bin symlink changes at publication. Failed installs leave the previous
    CLI intact; interrupted installs are reclaimed under the lock on the next run.
    npm lifecycle scripts are disabled: the bundled JS launcher handles native
    binary permissions, without postinstall's fallback GitHub download.
    """
    root = Path(os.environ.get(
        "WANDRUN_BROWSER_CLI_DIR", "/data/home/wandrun-browser/agent-browser"))
    if not root.is_absolute():
        raise ValueError("WANDRUN_BROWSER_CLI_DIR 必须是绝对路径")
    os.umask(0o077)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (root / "install.lock").open("ab") as lock:
        os.fchmod(lock.fileno(), 0o600)
        deadline = time.monotonic() + CLI_INSTALL_TIMEOUT_SECONDS
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("等待 agent-browser 安装锁超时") from None
                time.sleep(0.1)
        previous = (root / "bin").resolve().parent if (root / "bin").is_symlink() else None
        link = root / ".bin-next"
        # A killed installer cannot run finally. Never reclaim the published CLI.
        link.unlink(missing_ok=True)
        for abandoned in root.glob(".install-*"):
            if abandoned.resolve() != previous:
                shutil.rmtree(abandoned)
        executable = root / "bin" / "agent-browser"
        if cli_version_matches(executable):
            return {"installed": False, "executable": str(executable)}
        on_path = shutil.which("agent-browser")
        if on_path and cli_version_matches(on_path):
            return {"installed": False, "executable": on_path}
        npm = shutil.which("npm")
        if not npm:
            raise RuntimeError("agent-browser 安装失败：PATH 中找不到 npm")
        stage = Path(tempfile.mkdtemp(prefix=".install-", dir=root))
        published = False
        try:
            try:
                result = subprocess.run(
                    [npm, "install", "--global", "--prefix", str(stage),
                     "--ignore-scripts", "--no-audit", "--no-fund",
                     "agent-browser@" + AGENT_BROWSER_VERSION],
                    stdin=subprocess.DEVNULL, capture_output=True, text=True,
                    timeout=CLI_INSTALL_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("agent-browser npm 安装超时（请检查网络 / npm registry）") from error
            if result.returncode:
                raise RuntimeError("agent-browser npm 安装失败（退出码 %s）：%s" % (
                    result.returncode, (result.stderr or result.stdout).strip()))
            if not cli_version_matches(stage / "bin" / "agent-browser"):
                raise RuntimeError("agent-browser 安装后 --version 校验失败，要求 " + AGENT_BROWSER_VERSION)
            link.symlink_to(stage.name + "/bin")
            link.replace(root / "bin")
            published = True
            if previous is not None and previous.parent == root and previous.name.startswith(".install-"):
                shutil.rmtree(previous)
            return {"installed": True, "executable": str(executable)}
        finally:
            link.unlink(missing_ok=True)
            if not published:
                shutil.rmtree(stage)


def browser_configuration():
    port = os.environ.get("WANDRUN_BROWSER_PORT", "").strip()
    profile = os.environ.get("WANDRUN_BROWSER_PROFILE", "").strip()
    if not port or not profile:
        raise ValueError(
            "未注入 WANDRUN_BROWSER_PORT / WANDRUN_BROWSER_PROFILE；"
            "仅已配置浏览器的 Instabox 环境允许启动，Local 使用外部 Chrome，拒绝启动"
        )
    if not port.isascii() or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError("WANDRUN_BROWSER_PORT 必须是 1–65535 的固定端口")
    path = Path(profile)
    if not path.is_absolute():
        raise ValueError("WANDRUN_BROWSER_PROFILE 必须是配置提供的短绝对路径")
    return int(port), path


def find_chrome():
    if TEMPLATE_CHROME.is_file() and os.access(TEMPLATE_CHROME, os.X_OK):
        return str(TEMPLATE_CHROME)
    for command in CHROME_COMMANDS:
        executable = shutil.which(command)
        if executable:
            return executable
    raise RuntimeError(
        "找不到 Chrome：依次检查 /usr/lib/chromium/chromium 和 PATH 中的 "
        + "、".join(CHROME_COMMANDS)
    )


def cdp_ready(port, timeout):
    """Require Chrome discovery metadata, not merely an open TCP/HTTP port."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        # A direct loopback connection cannot inherit HTTP proxy settings.
        connection.request("GET", "/json/version")
        response = connection.getresponse()
        if response.status != 200:
            return False
        metadata = json.loads(response.read(65536))
        if not isinstance(metadata, dict):
            return False
        browser = metadata.get("Browser")
        protocol = metadata.get("Protocol-Version")
        websocket = metadata.get("webSocketDebuggerUrl")
        if (not isinstance(browser, str)
                or not browser.startswith(("Chrome/", "HeadlessChrome/", "Chromium/"))
                or not isinstance(protocol, str) or not protocol
                or not isinstance(websocket, str)):
            return False
        address = urlsplit(websocket)
        return (address.scheme == "ws" and address.hostname in ("127.0.0.1", "localhost", "::1")
                and address.port == port and address.username is None and address.password is None
                and address.path.startswith("/devtools/browser/")
                and bool(address.path.removeprefix("/devtools/browser/")))
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def acquire_start_lock(lock, deadline):
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("等待其他 Chrome 启动命令释放文件锁超时") from None
            time.sleep(min(0.1, remaining))


def stop_failed_launch(process):
    """Only reap this unsuccessful launch; never stop a reused, ready Chrome."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=1)


def chrome_user_agent(executable):
    """Read this browser's default UA; on failure warn and leave it unchanged."""
    try:
        # A disposable profile avoids touching the managed browser's state/lock.
        # Reading the actual UA preserves platform and reduction rules on upgrades.
        with tempfile.TemporaryDirectory(prefix="wandrun-chrome-ua-") as profile:
            process = subprocess.Popen(
                [executable, "--headless=new", "--disable-dev-shm-usage",
                 "--no-first-run", "--no-default-browser-check",
                 "--user-data-dir=%s" % profile, "--dump-dom",
                 "data:text/html,<body><script>"
                 "document.body.textContent=navigator.userAgent</script>"],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                start_new_session=True, close_fds=True, text=True, encoding="utf-8",
            )
            try:
                output, _ = process.communicate(timeout=USER_AGENT_TIMEOUT_SECONDS)
                if process.returncode:
                    raise RuntimeError("探测进程退出码 %s" % process.returncode)
            finally:
                stop_failed_launch(process)
        match = re.search(r"<body>(Mozilla/[^<\r\n]+)</body>", output)
        if not match:
            raise ValueError("探测结果缺少浏览器默认 UA")
        return unescape(match.group(1)).replace("HeadlessChrome", "Chrome")
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print("Chrome User-Agent 派生失败，继续使用默认 headless UA：%s" % error,
              file=sys.stderr)
        return None


def start_browser(port, profile, timeout):
    log_path = profile / "chrome.log"
    try:
        # Restrict both newly created parents and Chrome's later profile files.
        os.umask(0o077)
        profile.mkdir(mode=0o700, parents=True, exist_ok=True)
        profile.chmod(0o700)
        with (profile / "start.lock").open("ab") as lock, log_path.open("ab") as log:
            os.fchmod(lock.fileno(), 0o600)
            os.fchmod(log.fileno(), 0o600)
            try:
                acquire_start_lock(lock, time.monotonic() + timeout)
                if cdp_ready(port, min(PROBE_TIMEOUT_SECONDS, timeout)):
                    return {"already_running": True}
                executable = find_chrome()
                user_agent = chrome_user_agent(executable)
                command = [
                    executable, "--headless=new", "--disable-dev-shm-usage",
                    "--no-first-run", "--no-default-browser-check",
                    "--remote-debugging-address=127.0.0.1",
                    "--remote-debugging-port=%s" % port,
                    "--user-data-dir=%s" % profile, "--window-size=1000,800",
                ]
                if user_agent is not None:
                    command.append("--user-agent=%s" % user_agent)
                process = subprocess.Popen(
                    command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                    start_new_session=True, close_fds=True,
                )
                deadline = time.monotonic() + timeout
                try:
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise TimeoutError("Chrome CDP 就绪等待超时")
                        if cdp_ready(port, min(PROBE_TIMEOUT_SECONDS, remaining)):
                            return {"already_running": False, "pid": process.pid}
                        exit_code = process.poll()
                        if exit_code is not None:
                            raise RuntimeError("Chrome 提前退出，退出码 %s" % exit_code)
                        time.sleep(min(0.1, max(0, deadline - time.monotonic())))
                except (OSError, RuntimeError):
                    stop_failed_launch(process)
                    raise
            except (OSError, RuntimeError) as error:
                log.write(("\nwandrun: %s\n" % error).encode("utf-8"))
                raise
    except (OSError, RuntimeError) as error:
        raise RuntimeError("%s；私有日志：%s" % (error, log_path)) from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS,
                        help="分别限制启动锁与 CDP 就绪等待的秒数；另有最多 5 秒的 UA 探测（默认 10）")
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout 必须是有限正数")
    try:
        port, profile = browser_configuration()
        cli = ensure_agent_browser()
        video = ensure_video_publisher()
        report = start_browser(port, profile, args.timeout)
        report["agent_browser"] = cli
        report["video_publisher"] = video
    except (OSError, RuntimeError, ValueError) as error:
        print("浏览器准备失败：%s" % error, file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
