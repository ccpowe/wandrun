"""Immutable per-thread compaction segments in the Agent's execution environment.

Segments are UTF-8 JSONL: a range header followed by bounded message chunks.
For each message, join its ``json`` fields in ``part`` order and parse the resulting
JSON string to recover the full message dump. Inline image/PDF bytes in known
message content blocks are saved separately in ``media/``; arbitrary tool arguments,
artifacts and metadata are never interpreted as media. The checkpoint remains
authoritative: uncommitted files are inert orphans.
"""

import asyncio
import base64
import binascii
from hashlib import sha256
import json
import os
import stat
from pathlib import Path
import posixpath
from uuid import uuid4

from wandrun.integrations.ssh_backend import SSHBackend


_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
               "image/gif": ".gif", "application/pdf": ".pdf"}

def _media_extension(mime: object) -> str | None:
    if not isinstance(mime, str):
        return None
    if mime.startswith("image/"):
        return _EXTENSIONS.get(mime, ".bin")
    return _EXTENSIONS.get(mime)



def _publish_local(path: str, content: bytes) -> None:
    """Publish without following directory or file symlinks, including on conflict."""
    parts = Path(path).parts
    if not parts or parts[0] != "/" or ".." in parts:
        raise ValueError(f"历史留档路径须为不含 .. 的绝对路径：{path}")
    directory_fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in parts[1:-1]:
            if part == ".":
                continue
            try:
                os.mkdir(part, mode=0o700, dir_fd=directory_fd)
            except FileExistsError:
                pass
            child_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                               dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = child_fd

        target = parts[-1]

        def verify_existing() -> None:
            descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                                 dir_fd=directory_fd)
            with os.fdopen(descriptor, "rb") as original:
                if not stat.S_ISREG(os.fstat(original.fileno()).st_mode):
                    raise OSError(f"历史留档不是普通文件：{path}")
                if original.read() != content:
                    raise OSError(f"历史留档存在同名且内容不同的文件：{path}")

        try:
            verify_existing()
            return
        except FileNotFoundError:
            pass
        stage = f".{uuid4().hex}.stage"
        try:
            descriptor = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
                                 0o600, dir_fd=directory_fd)
            with os.fdopen(descriptor, "wb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            try:
                os.link(stage, target, src_dir_fd=directory_fd, dst_dir_fd=directory_fd,
                        follow_symlinks=False)
            except FileExistsError:
                verify_existing()
            else:
                os.fsync(directory_fd)
        finally:
            try:
                os.unlink(stage, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
    finally:
        os.close(directory_fd)


class CompactionArchive:
    """Write only a newly covered raw-message range; no checkpoint mutation.

    The role's Environment determines both the artifact root and backend. SSH writes
    use the same SFTP connection as its file tools, never a host-side mirror.
    """

    def __init__(self, artifacts_root: str, backend):
        self.root = posixpath.join(artifacts_root, "compaction")
        self.backend = backend

    def directory(self, task_id: str) -> str:
        # Do not interpret caller/model text as a path component.
        return posixpath.join(self.root, sha256(task_id.encode()).hexdigest())

    async def _publish(self, path: str, content: bytes) -> None:
        if isinstance(self.backend, SSHBackend):
            await self.backend.apublish_artifact(path, content)
        else:
            await asyncio.to_thread(_publish_local, path, content)

    async def segment(self, task_id: str, messages, start: int, end: int) -> str:
        """Publish one immutable [start,end) segment, including exact tool arguments.

        A repeated range with identical raw messages has the same name. Publication
        errors propagate before the candidate can call the main model or commit.
        """
        if end <= start:
            raise ValueError("没有可新增的历史留档")
        directory = self.directory(task_id)
        media = {}

        def sanitize_block(block):
            if not isinstance(block, dict):
                return block
            kind = block.get("type")
            if not isinstance(kind, str) or kind not in {
                "image", "input_image", "image_url", "file", "input_file",
            }:
                return block
            encoded = block.get("base64")
            mime = block.get("mime_type")
            data_url = None
            if not isinstance(encoded, str):
                image_url = block.get("image_url")
                if isinstance(image_url, dict):
                    image_url = image_url.get("url")
                candidates = (block.get("file_data"), image_url, block.get("url"))
                for candidate in candidates:
                    if isinstance(candidate, str) and candidate.startswith("data:") and ";base64," in candidate:
                        data_url = candidate
                        break
                if data_url:
                    mime, encoded = data_url[5:].split(";base64,", 1)
            extension = _media_extension(mime)
            if extension is None and isinstance(encoded, str) and mime is None:
                extension = ".bin"
            if not isinstance(encoded, str) or extension is None:
                return block
            try:
                payload = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as error:
                raise ValueError("媒体编码无效，无法保存历史留档") from error
            digest = sha256(payload).hexdigest()
            path = posixpath.join(directory, "media", digest + extension)
            media[path] = payload
            origin = block.get("url") or block.get("image_url")
            if isinstance(origin, dict):
                origin = origin.get("url")
            source = {"source_path": origin} if isinstance(origin, str) and not origin.startswith("data:") else {}
            return {"type": kind, "mime_type": mime, "archive_path": path,
                    "sha256": digest, "size": len(payload), **source,
                    **{key: item for key, item in block.items()
                       if key not in {"type", "mime_type", "base64", "image_url", "file_data", "url"}}}

        def sanitize_content(content):
            if isinstance(content, list):
                return [sanitize_block(block) for block in content]
            return content

        def sanitize_message(message):
            record = message.model_dump()
            record["content"] = sanitize_content(record["content"])
            # Codex response items are a known provider message structure. Other
            # additional_kwargs entries are arbitrary JSON and stay untouched.
            extras = record.get("additional_kwargs")
            if isinstance(extras, dict) and isinstance(extras.get("codex_output_items"), list):
                items = []
                for item in extras["codex_output_items"]:
                    if isinstance(item, dict) and item.get("type") == "message":
                        item = {**item, "content": sanitize_content(item.get("content"))}
                    items.append(item)
                record["additional_kwargs"] = {**extras, "codex_output_items": items}
            return record

        records = [sanitize_message(message) for message in messages[start:end]]
        header = {"format": "wandrun-compaction-jsonl-v2", "task_id": task_id,
                  "start_index": start, "end_index": end}
        lines = [json.dumps(header, ensure_ascii=False, sort_keys=True)]
        for message_index, record in enumerate(records, start):
            serialized = json.dumps(record, ensure_ascii=False, sort_keys=True, default=str)
            # A second JSON escaping pass can expand one character by up to 6x;
            # 4096-character chunks remain well below read_file's 80k cap.
            for part, offset in enumerate(range(0, len(serialized), 4096)):
                lines.append(json.dumps({"message_index": message_index, "part": part,
                                         "json": serialized[offset:offset + 4096]},
                                        ensure_ascii=False))
        body = ("\n".join(lines) + "\n").encode("utf-8")
        digest = sha256(body).hexdigest()
        path = posixpath.join(directory, f"segment-{start:08d}-{end:08d}-{digest[:16]}.jsonl")
        for media_path, payload in media.items():
            await self._publish(media_path, payload)
        await self._publish(path, body)
        return path

    async def index(self, task_id: str, paths: list[str]) -> str:
        """Publish the complete committed-chain candidate as an immutable read_file index."""
        directory = self.directory(task_id)
        body = ("# 历史原文切段（按提交顺序；旧值请核对后续更正）\n"
                + "".join(f"{number}. {path}\n" for number, path in enumerate(paths, 1))).encode("utf-8")
        digest = sha256(body).hexdigest()
        path = posixpath.join(directory, f"index-{len(paths):08d}-{digest[:16]}.md")
        await self._publish(path, body)
        return path


    @staticmethod
    def summary_text(summary: str, index_path: str, segment_path: str) -> str:
        """Attach verified history locations outside model-generated prose."""
        return (f"{summary.rstrip()}\n\n[原文留档索引：{index_path}；"
                f"本次新增切段：{segment_path}。用 read_file 设置 limit=1、递增 offset 逐行读取 JSONL，"
                "按 message_index 聚合 part 顺序拼接 json 字段，再解析 JSON 可恢复完整原文；"
                "媒体原字节在对应 archive_path。]\n")
