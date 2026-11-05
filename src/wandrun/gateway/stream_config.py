"""Startup-only browser stream configuration; no remote I/O or secret logging."""

from dataclasses import dataclass, fields
import math
from pathlib import Path
import stat
import tomllib
from urllib.parse import urlsplit

import yaml


@dataclass(frozen=True)
class VideoConfig:
    url: str
    api_url: str
    key_file: Path
    codec: str = "h264"
    max_kbps: int = 1500
    jpeg_quality: int = 95
    idle_resend_fps: int = 10
    capture_fps: int = 24
    idle_capture_fps: int = 10
    idle_after_s: float = 10
    watch_limit: int = 2
    start_timeout_s: float = 15
    publisher_idle_s: float = 10
    token_ttl_s: float = 600
    api_timeout_s: float = 5


@dataclass(frozen=True)
class InputConfig:
    window: int = 16
    reply_timeout_s: float = 5
    held_idle_release_s: float = 10


@dataclass(frozen=True)
class StreamConfig:
    video: VideoConfig | None = None
    input: InputConfig = InputConfig()


def read_keys(path):
    """LiveKit key_file YAML is a nonempty API-key → secret mapping."""
    path = Path(path).expanduser()
    if stat.S_IMODE(path.stat().st_mode) & 0o177:
        raise ValueError("stream.video.key_file 权限不得宽于 0600")
    try:
        with path.open() as handle:
            keys = yaml.safe_load(handle)
    except yaml.YAMLError:
        raise ValueError("stream.video.key_file YAML 格式非法") from None
    if (
        not isinstance(keys, dict)
        or not keys
        or not all(
            isinstance(k, str) and k and isinstance(v, str) and v
            for k, v in keys.items()
        )
    ):
        raise ValueError("stream.video.key_file 必须是 API key 到 secret 的 YAML 映射")
    return next(iter(keys.items()))


def _table(value, allowed, label):
    if not isinstance(value, dict) or value.keys() - set(allowed):
        raise ValueError(f"{label} 包含未知字段或不是表")
    return dict(value)


def _positive(value, label, *, integer=False):
    if (
        type(value) not in (int, float)
        or not math.isfinite(value)
        or value <= 0
        or integer
        and type(value) is not int
    ):
        raise ValueError(f"{label} 必须是正有限{'整数' if integer else '数'}")


def load_stream_config(path=None):
    if path is None:
        return StreamConfig()
    with Path(path).open("rb") as handle:
        root = _table(tomllib.load(handle), ("stream",), "配置")
    stream = _table(
        root.get("stream", {}), (f.name for f in fields(StreamConfig)), "stream"
    )
    input_values = _table(
        stream.get("input", {}), (f.name for f in fields(InputConfig)), "stream.input"
    )
    inputs = InputConfig(**input_values)
    for field in fields(inputs):
        _positive(
            getattr(inputs, field.name),
            "stream.input." + field.name,
            integer=field.name == "window",
        )
    if inputs.window > 32:
        raise ValueError("stream.input.window 不得大于 32")
    video = None
    if "video" in stream:
        values = _table(
            stream["video"], (f.name for f in fields(VideoConfig)), "stream.video"
        )
        if not {"url", "api_url", "key_file"} <= values.keys():
            raise ValueError("stream.video 缺少 url/api_url/key_file")
        if not all(
            isinstance(values[name], str) for name in ("url", "api_url", "key_file")
        ):
            raise ValueError("stream.video 地址与密钥路径必须是字符串")
        values["key_file"] = Path(values["key_file"]).expanduser()
        video = VideoConfig(**values)
        url, api_url = urlsplit(video.url), urlsplit(video.api_url)
        if (
            url.scheme != "wss"
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("stream.video.url 必须是 wss 地址")
        if (
            api_url.scheme != "http"
            or api_url.hostname not in ("localhost", "127.0.0.1", "::1")
            or api_url.username
            or api_url.password
            or api_url.query
            or api_url.fragment
        ):
            raise ValueError("stream.video.api_url 必须是回环 http 地址")
        if video.codec not in ("h264", "vp8"):
            raise ValueError("stream.video.codec 非法")
        integers = {
            "max_kbps",
            "jpeg_quality",
            "idle_resend_fps",
            "capture_fps",
            "idle_capture_fps",
            "watch_limit",
        }
        for field in fields(video):
            if field.name not in ("url", "api_url", "key_file", "codec"):
                _positive(
                    getattr(video, field.name),
                    "stream.video." + field.name,
                    integer=field.name in integers,
                )
        if video.jpeg_quality > 100:
            raise ValueError("stream.video.jpeg_quality 不得大于 100")
        read_keys(video.key_file)
    return StreamConfig(video=video, input=inputs)
