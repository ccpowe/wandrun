"""Development-only headed Chrome with an isolated profile and Xvfb display.

Runtime never starts Chrome: configure its local environment's browser.cdp_url to
this launcher's loopback endpoint. The context manager is also a disposable fixture.
"""

from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
import json
import os
import select
import signal
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _x11_environment(display: str, tmpdir: str) -> dict[str, str]:
    """Keep private Xvfb launchers independent of the host GNOME/Wayland session."""
    env = {**os.environ, "DISPLAY": display, "TMPDIR": tmpdir, "XDG_SESSION_TYPE": "x11"}
    for key in ("WAYLAND_DISPLAY", "XDG_CURRENT_DESKTOP", "DESKTOP_SESSION"):
        env.pop(key, None)
    for key in tuple(env):
        if key.startswith("GNOME_"):
            env.pop(key)
    return env


@contextmanager
def _chrome_tempdir():
    """Own Chrome scratch files under TMPDIR, with a short Linux socket path."""
    with tempfile.TemporaryDirectory(prefix="c") as directory:
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            # A short prefix alone cannot bound a long parent TMPDIR. Keep this
            # parent-owned fd alive until Chrome exits; no child fd inheritance
            # or files outside the configured temporary filesystem are needed.
            yield f"/proc/{os.getpid()}/fd/{fd}"
        finally:
            os.close(fd)


class ChromeDev:
    """Own Xvfb and Chrome; close both even when startup only partially succeeds.

    With no profile_dir the Chrome profile is disposable. An explicit profile_dir
    retains logins between launches and must not be shared by running instances.
    """

    def __init__(
        self, *, port: int | None = None, profile_dir: Path | None = None,
        chrome_path: str | None = None,
    ):
        self.port = _free_port() if port is None else port
        self.profile_dir = Path(profile_dir) if profile_dir is not None else None
        self.chrome_path = chrome_path or shutil.which("google-chrome") or "/opt/google/chrome/chrome"
        self.cdp_url = f"http://127.0.0.1:{self.port}"
        self.display: str | None = None
        self._root: tempfile.TemporaryDirectory | None = None
        self._chrome_temp = ExitStack()
        self._xvfb: subprocess.Popen | None = None
        self._chrome: subprocess.Popen | None = None

    def __enter__(self) -> ChromeDev:
        try:
            self._start()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def _start(self) -> None:
        if not Path(self.chrome_path).is_file() and shutil.which(self.chrome_path) is None:
            raise FileNotFoundError(f"Google Chrome 不存在: {self.chrome_path}")
        if shutil.which("Xvfb") is None:
            raise FileNotFoundError("Xvfb 不存在")
        # Never mistake an existing listener's CDP response for our own Chrome.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", self.port))
        # Own the disposable profile and diagnostics separately from Chrome's
        # socket scratch directory, whose path must stay short even under TMPDIR.
        self._root = tempfile.TemporaryDirectory(prefix="c")
        if self.profile_dir is None:
            self.profile_dir = Path(self._root.name) / "profile"
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        read_fd, write_fd = os.pipe()
        try:
            self._xvfb = subprocess.Popen(
                ["Xvfb", "-displayfd", str(write_fd), "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
                pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        finally:
            os.close(write_fd)
        try:
            ready, _, _ = select.select([read_fd], [], [], 10)
            if not ready:
                raise RuntimeError("Xvfb 启动超时")
            display = os.read(read_fd, 32).decode("ascii").strip()
            if not display.isdecimal():
                raise RuntimeError("Xvfb 未能分配显示号")
            self.display = f":{display}"
        finally:
            os.close(read_fd)
        tmpdir = self._chrome_temp.enter_context(_chrome_tempdir())
        env = _x11_environment(self.display, tmpdir)
        stderr_path = Path(self._root.name) / "chrome-stderr.log"
        with stderr_path.open("wb") as stderr:
            self._chrome = subprocess.Popen(
                [self.chrome_path, f"--user-data-dir={self.profile_dir}",
                 f"--remote-debugging-port={self.port}", "--remote-debugging-address=127.0.0.1",
                 "--no-first-run", "--no-default-browser-check", "--no-startup-window",
                 "--window-size=1280,800", "--ozone-platform=x11"],
                env=env, stdout=subprocess.DEVNULL, stderr=stderr, start_new_session=True,
            )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self._chrome.poll() is not None:
                raise RuntimeError(
                    f"Chrome 启动失败，退出码 {self._chrome.returncode}"
                    f"{self._startup_stderr(stderr_path)}"
                )
            try:
                with urlopen(f"{self.cdp_url}/json/version", timeout=0.5) as response:
                    if json.load(response).get("webSocketDebuggerUrl"):
                        return
            except (OSError, URLError, ValueError):
                time.sleep(0.1)
        raise RuntimeError(f"Chrome CDP 启动超时{self._startup_stderr(stderr_path)}")

    @staticmethod
    def _startup_stderr(path: Path) -> str:
        # A file avoids a blocked Chrome on a full pipe; only a bounded tail
        # enters the exception, and the private temporary root owns the file.
        with path.open("rb") as stderr:
            stderr.seek(0, os.SEEK_END)
            stderr.seek(max(0, stderr.tell() - 4096))
            tail = stderr.read(4096).decode("utf-8", errors="replace").strip()
        return f"; Chrome stderr (last 4096 bytes): {tail}" if tail else ""

    def __exit__(self, _type, _value, _traceback) -> None:
        try:
            for process in (self._chrome, self._xvfb):
                if process is None:
                    continue
                # Chrome has renderers: signal the whole group, not just its browser process.
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)
                else:
                    # The leader can exit before renderers; leave no profile users behind.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        finally:
            self._chrome_temp.close()
            if self._root is not None:
                self._root.cleanup()
                self._root = None


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Launch a separate development Chrome on Xvfb")
    parser.add_argument("--port", type=int, default=9222)
    parser.add_argument("--profile-dir", type=Path, help="Persistent Chrome profile (otherwise disposable)")
    args = parser.parse_args(argv)
    def terminate(_signal, _frame):
        raise SystemExit(128 + _signal)

    previous = signal.signal(signal.SIGTERM, terminate)
    try:
        with ChromeDev(port=args.port, profile_dir=args.profile_dir) as chrome:
            print(f"CDP: {chrome.cdp_url}; DISPLAY={chrome.display}; profile={chrome.profile_dir}", flush=True)
            try:
                while chrome._chrome.poll() is None and chrome._xvfb.poll() is None:
                    time.sleep(0.5)
            except KeyboardInterrupt:
                pass
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    main()
