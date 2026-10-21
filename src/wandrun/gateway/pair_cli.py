"""Local pair command. The gateway remains the only writer of device state.

Management requests always go to loopback using the credential file; --url
changes only the address embedded in the QR code for the mobile device.
"""

import argparse
import fcntl
import ipaddress
import json
import os
import socket
import stat
import struct
import sys
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import httpx
import segno

from wandrun.gateway.pairing import CREDENTIAL_FILE


def _workspace_path(given: Path | None) -> Path:
    if given is not None:
        return given
    current = Path.cwd()
    for candidate in (current, current / "workspace"):
        if (candidate / ".wandrun" / "state" / CREDENTIAL_FILE).is_file():
            return candidate
    return current


def _credential(workspace: Path) -> dict:
    path = workspace / ".wandrun" / "state" / CREDENTIAL_FILE
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        mode = os.fstat(stream.fileno())
        if not stat.S_ISREG(mode.st_mode) or stat.S_IMODE(mode.st_mode) != 0o600 or mode.st_uid != os.getuid():
            raise ValueError("管理凭据必须是本用户独占的 0600 普通文件")
        credential = json.load(stream)
    if not isinstance(credential, dict) or not isinstance(credential.get("token"), str) or not credential["token"]:
        raise ValueError("管理凭据格式无效；请重新启动网关")
    host, port = credential.get("host"), credential.get("port")
    if not isinstance(host, str) or type(port) is not int or not 0 < port <= 65535:
        raise ValueError("管理凭据的监听地址无效；请重新启动网关")
    return credential


def _network_addresses() -> list[str]:
    """Enumerate interface addresses, not hostname DNS (often just 127.0.1.1)."""
    addresses = set()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        for _, interface in socket.if_nameindex():
            try:
                packed = fcntl.ioctl(
                    sock.fileno(), 0x8915, struct.pack("256s", interface.encode()[:15]),
                )
                addresses.add(socket.inet_ntoa(packed[20:24]))
            except OSError:  # IPv6-only or down interface
                continue
    try:
        for line in Path("/proc/net/if_inet6").read_text(encoding="ascii").splitlines():
            addresses.add(str(ipaddress.IPv6Address(int(line.split()[0], 16))))
    except OSError:
        pass
    return sorted(
        address for address in addresses
        if not (ip := ipaddress.ip_address(address)).is_loopback
        and not ip.is_link_local and not ip.is_unspecified
    )


def _public_urls(host: str, port: int, explicit: str | None) -> list[str]:
    """Use only the bound IP family unless the user supplies a public URL.

    In particular, asyncio's IPv6 wildcard listener is IPV6_V6ONLY; an IPv4
    interface on the same machine does not make that gateway reachable over IPv4.
    """
    if explicit is not None:
        parsed = urlsplit(explicit)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("--url 必须是无查询参数、片段或凭据的 http(s) 网关地址")
        return [explicit.rstrip("/")]
    if host in ("0.0.0.0", "::"):
        family = ipaddress.ip_address(host).version
        addresses = [
            address for address in _network_addresses()
            if ipaddress.ip_address(address).version == family
        ]
        if not addresses:
            # Offline machines can still pair over adb reverse (IPv4) or IPv6 loopback.
            addresses = ["::1" if host == "::" else "127.0.0.1"]
    else:
        addresses = ["127.0.0.1" if host.lower() == "localhost" else host]
    return [f"http://{f'[{address}]' if ':' in address else address}:{port}" for address in addresses]


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def pair_main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m wandrun.gateway pair")
    parser.add_argument("--workspace", type=Path, help="正在运行的网关使用的 workspace；默认查找当前目录或 ./workspace")
    parser.add_argument("--url", help="手机可访问的网关 URL；仅用于二维码，不用于管理请求")
    parser.add_argument("--name", help="本次配对设备的默认名称")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--list", action="store_true", help="列出设备")
    actions.add_argument("--revoke", metavar="DEVICE_ID", help="撤销一台设备的令牌")
    args = parser.parse_args(argv)
    if args.name is not None and (not args.name.strip() or len(args.name) > 64):
        parser.error("--name 必须为 1～64 个字符")
    try:
        workspace = _workspace_path(args.workspace)
        credential = _credential(workspace)
        bind = credential["host"]
        # Validate the address before consuming an outstanding challenge.
        urls = _public_urls(bind, credential["port"], args.url) if not (args.list or args.revoke) else []
        # The management interface rejects non-loopback clients. Never use --url or proxy
        # environment variables for management; wildcard binds accept localhost too.
        local_host = bind if _is_loopback(bind) and bind.lower() != "localhost" else (
            "::1" if ":" in bind else "127.0.0.1"
        )
        host = f"[{local_host}]" if ":" in local_host else local_host
        admin = f"http://{host}:{credential['port']}"
        with httpx.Client(base_url=admin, timeout=5, trust_env=False, follow_redirects=False,
                          headers={"Authorization": f"Bearer {credential['token']}"}) as client:
            if args.list:
                response = client.get("/admin/devices")
            elif args.revoke:
                response = client.delete(f"/admin/devices/{args.revoke}")
            else:
                response = client.post("/admin/pairing-codes", json={"name": args.name} if args.name else {})
            response.raise_for_status()
            if args.list:
                for device in response.json()["devices"]:
                    print(f"{device['id']}  {device['name']}  {device['paired_at']}  "
                          f"最近使用: {device['last_used_at'] or '无'}  "
                          f"{'已撤销' if device['revoked'] else '已连接'}")
                return
            if args.revoke:
                print("已撤销设备")
                return
            challenge = response.json()
            print(f"配对码：{challenge['code']}（有效期至 {challenge['expires_at']}）")
            print("请在 App 扫描二维码或手动填写以下地址与配对码：")
            for url in urls:
                print(f"  {url}")
            if any(urlsplit(url).scheme == "http" and not _is_loopback(urlsplit(url).hostname)
                   for url in urls):
                print("提示：非回环地址经公网访问必须使用 HTTPS 反向代理或加密隧道。")
            qr = "wandrun://pair?" + urlencode({"url": urls[0], "code": challenge["code"]})
            print("二维码（如有多个地址，可用 --url 选择手机可访问的一项）：")
            segno.make(qr, error="m").terminal(out=sys.stdout, border=4, compact=True)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, httpx.HTTPError) as error:
        # HTTP exception text may include request URL. Management URL has no secrets,
        # but avoid echoing untrusted responses (and arbitrary URLs) in CLI errors.
        if isinstance(error, httpx.HTTPStatusError):
            raise SystemExit(f"管理请求失败（HTTP {error.response.status_code}）；请检查 workspace 与网关是否匹配") from None
        if isinstance(error, httpx.HTTPError):
            raise SystemExit("无法连接本机网关；请检查 workspace 与正在运行的网关") from None
        raise SystemExit(f"配对失败：{error}") from None
