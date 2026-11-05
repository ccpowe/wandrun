"""ADR-0077 的确定性展示值推导；不访问网络，不改变连接参数。"""

import ipaddress
from pathlib import PurePath
import re
from urllib.parse import urlsplit

from wandrun.config import DISPLAY_NAME_MAX


def _line(value: object, limit: int) -> str:
    return " ".join(value.split())[:limit].strip() if isinstance(value, str) else ""


def _package(value: str, *, fallback: bool = True) -> str:
    original = value
    value = re.sub(r"^@[^/]+/", "", value)
    words = [word for word in re.split(r"[-_.]+", value) if word.lower() not in {"mcp", "server"}]
    return " ".join(word[:1].upper() + word[1:] for word in words if word) or (original if fallback else "")


def _fallback_name(definition: dict) -> str:
    if "url" in definition:
        parts = urlsplit(definition["url"])
        host = parts.hostname or ""
        try:
            ipaddress.ip_address(host)
            local = True
        except ValueError:
            local = host == "localhost"
        if local:
            return _package(parts.path.rstrip("/").rsplit("/", 1)[-1], fallback=False) or "远程连接器"
        while host.startswith(("www.", "mcp.", "api.")):
            host = host.split(".", 1)[1]
        return _package(host.rsplit(".", 1)[0] if "." in host else host) or "远程连接器"
    command = PurePath(definition["command"]).name
    args = list(definition.get("args", []))
    launcher = command in {"npx", "uvx", "bunx"}
    if command in {"pipx", "docker"} and args and args[0] == "run":
        launcher, args = True, args[1:]
    if launcher:
        # Common launcher options consume a value; that value is not a package.
        consumes_value = {"-e", "--env", "-v", "--volume", "--name", "--network", "-p", "--publish", "--index-url", "--python"}
        skip = False
        for arg in args:
            if skip:
                skip = False
            elif arg in consumes_value:
                skip = True
            elif not arg.startswith("-"):
                return _package(arg)
    return command


def _icon(info: dict) -> str | None:
    for icon in info.get("icons") or []:
        source = icon.get("src") if isinstance(icon, dict) else None
        if not isinstance(source, str):
            continue
        try:
            if urlsplit(source).scheme in {"https", "http"}:
                return source
        except ValueError:
            continue
    return None


def derive_metadata(definition: dict, metadata: dict, existing: dict[str, dict]) -> dict:
    """Return a candidate; explicit user fields survive refresh, auto names stay unique."""
    result = dict(definition)
    info = metadata.get("serverInfo") or {}
    if result.get("name_source", "user") == "auto":
        name = _line(info.get("title"), DISPLAY_NAME_MAX)
        if not name and info.get("name"):
            name = _line(_package(info["name"]), DISPLAY_NAME_MAX)
        name = name or _line(_fallback_name(definition), DISPLAY_NAME_MAX)
        names = {item["name"] for identity, item in existing.items() if identity != definition["id"]}
        base, number = name, 2
        while name in names:
            suffix = f" {number}"
            name = base[:DISPLAY_NAME_MAX - len(suffix)].rstrip() + suffix
            number += 1
        result["name"] = name
    if result.get("description_source", "user") == "auto":
        description = _line(info.get("description"), 200)
        if not description and isinstance(metadata.get("instructions"), str):
            paragraph = re.split(r"\n\s*\n", metadata["instructions"].strip(), maxsplit=1)[0]
            description = _line(paragraph, 200)
            ends = list(re.finditer(r"[。！？.!?](?:\s|$)|[。！？]", description))
            if ends:
                description = description[:ends[-1].end()].strip()
        tools = metadata.get("tools") or []
        if not description and tools:
            titles = [_line(tool.get("title") or tool.get("name"), 48) for tool in tools[:3]]
            suffix = " 等" if len(tools) > 3 else ""
            description = _line(f"提供 {len(tools)} 个工具：{'、'.join(titles)}{suffix}", 200)
        result["description"] = description
    result["icon"] = _icon(info)
    return result
