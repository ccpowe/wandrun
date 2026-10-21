"""Resumable uploads: persist offsets and placement intent before exposing files.

The spool remains until a durable, exclusive hard link into the conversation directory
and a committed file row exist. A cross-device copy first goes to a private staging
file beside conversation directories; linking the staged inode publishes only a complete file.
"""

import asyncio
import errno
import hashlib
import os
import re
import shutil
import stat
import time
from pathlib import Path
from uuid import uuid4
from weakref import WeakValueDictionary

from wandrun.gateway.store import GatewayStore
from wandrun.runtime.files import TaskFiles, link_completed_file

DEFAULT_MAX_UPLOAD_SIZE = 1024 ** 3
UPLOAD_LIFETIME = 24 * 60 * 60


class UploadError(ValueError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


class Uploads:
    """Local tus sessions; the module owns locks shared by requests and expiry."""

    def __init__(self, store: GatewayStore, workspace: Path, *, max_size: int = DEFAULT_MAX_UPLOAD_SIZE):
        if max_size < 0:
            raise ValueError("上传上限不能为负数")
        self.store = store
        self.workspace = workspace.resolve()
        self.spool = self.workspace / ".wandrun" / "uploads"
        self.max_size = max_size
        self._locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()

    def session_lock(self, identity: str) -> asyncio.Lock:
        """Hold while reading PATCH bodies and completing a session; expiry skips held locks."""
        return self._locks.setdefault(identity, asyncio.Lock())

    def _source(self, identity: str) -> Path:
        return self.spool / identity

    def get(self, identity: str) -> dict:
        upload = self.store.upload(identity)
        if upload is None or upload["terminating"]:
            raise UploadError(404, "not_found", "上传不存在")
        return upload

    def create(self, conversation_id: str, agent_id: str, filename: str, filetype: str, length: int, metadata: str) -> dict:
        if length > self.max_size:
            raise UploadError(413, "too_large", "文件超过上传上限")
        if not filename or filename in (".", "..", ".wandrun") or "/" in filename or "\\" in filename or any(
            ord(character) < 32 or ord(character) == 127 for character in filename
        ) or len(filename.encode("utf-8")) > 255:
            raise UploadError(400, "invalid_request", "filename 必须是安全的文件名")
        if len(filetype) > 255 or re.fullmatch(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+", filetype) is None:
            raise UploadError(400, "invalid_request", "filetype 必须是 MIME 类型")
        self.spool.mkdir(parents=True, exist_ok=True)
        if self.spool.is_symlink():
            raise OSError("上传暂存目录不能是符号链接")
        target_parent = self.workspace / "conversations"
        if target_parent.is_symlink():
            raise OSError("对话工作目录不能是符号链接")
        target_volume = target_parent if target_parent.exists() else self.workspace
        if min(shutil.disk_usage(self.spool).free, shutil.disk_usage(target_volume).free) < length:
            raise UploadError(507, "insufficient_storage", "磁盘剩余空间不足")
        identity = "u_" + uuid4().hex
        source = self._source(identity)
        with source.open("xb") as stream:
            stream.flush()
            os.fsync(stream.fileno())
        self._sync_dir(self.spool)
        try:
            upload = self.store.create_upload(identity, conversation_id, agent_id, filename, filetype, length, metadata)
        except BaseException:
            source.unlink()
            raise
        if length == 0:
            self.complete(upload)
        return self.get(identity)

    async def advance(self, upload: dict, offset: int, chunks) -> dict:
        """Write at a committed offset; a failed request truncates uncommitted bytes on retry."""
        if upload["completed"]:
            async for chunk in chunks:
                if chunk:
                    raise UploadError(409, "offset_conflict", "上传已经完成")
            return upload
        source = self._source(upload["id"])
        with source.open("r+b") as stream:
            stream.truncate(offset)
            stream.seek(offset)
            async for chunk in chunks:
                if offset + len(chunk) > upload["length"]:
                    stream.truncate(upload["offset"])
                    raise UploadError(413, "too_large", "上传数据超过声明大小")
                view = memoryview(chunk)
                while view:
                    written = stream.write(view)
                    if written is None or written == 0:
                        raise OSError("上传文件写入未完成")
                    view = view[written:]
                offset += len(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        self.store.advance_upload(upload["id"], offset)
        upload = self.get(upload["id"])
        if offset == upload["length"]:
            await self.complete_async(upload)
        return self.get(upload["id"])

    def _stage(self, upload: dict, target_dir: Path) -> Path:
        source = self._source(upload["id"])
        if source.stat().st_size != upload["length"]:
            raise OSError("上传源文件长度与已提交偏移不一致")
        # Cross-device staging must not expose a partial file inside the conversation cwd.
        stage = target_dir.parent / (".upload-" + upload["id"] + ".stage")
        if stage.exists() or stage.is_symlink():
            if stage.is_symlink() or not stage.is_file():
                raise OSError("上传暂存副本不可恢复")
            if stage.stat().st_size == upload["length"]:
                if self._digest(stage) != self._digest(source):
                    raise OSError("上传暂存副本与原件不一致")
                with stage.open("rb") as stream:
                    os.fsync(stream.fileno())
                self._sync_dir(target_dir.parent)
                return stage
            # A crash interrupted the cross-device copy before publishing it.
            stage.unlink()
        try:
            os.link(source, stage)
            self._sync_dir(target_dir.parent)
            return stage
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
        with stage.open("xb") as out, source.open("rb") as incoming:
            shutil.copyfileobj(incoming, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
        self._sync_dir(target_dir.parent)
        return stage

    @staticmethod
    def _digest(path: Path) -> bytes:
        checksum = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                checksum.update(chunk)
        return checksum.digest()

    @staticmethod
    def _sync_dir(directory: Path) -> None:
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _cleanup(self, upload: dict) -> None:
        self._source(upload["id"]).unlink(missing_ok=True)
        stage = self.workspace / "conversations" / (".upload-" + upload["id"] + ".stage")
        stage.unlink(missing_ok=True)

    async def complete_async(self, upload: dict) -> dict:
        """Offload potentially large cross-device staging copies without moving SQLite across threads."""
        directory = self._directory(upload)
        copying = asyncio.create_task(asyncio.to_thread(self._stage, upload, directory))
        try:
            stage = await asyncio.shield(copying)
        except asyncio.CancelledError:
            # The HTTP lock must not release while the copy still writes to its deterministic stage.
            await asyncio.shield(copying)
            raise
        return self.complete(upload, stage=stage)

    def _directory(self, upload: dict) -> Path:
        parent = self.workspace / "conversations"
        directory = TaskFiles.local_conversation_directory(self.workspace, upload["conversation_id"])
        if parent.is_symlink() or directory.is_symlink():
            raise OSError("对话工作目录不能是符号链接")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def complete(self, upload: dict, *, stage: Path | None = None) -> dict:
        """Idempotently publish the same inode then register its stable file id."""
        if upload["completed"]:
            self._cleanup(upload)
            return self.store.file(upload["file_id"])[0]
        if upload["offset"] != upload["length"]:
            raise UploadError(409, "offset_conflict", "上传尚未完成")
        directory = self._directory(upload)
        if stage is None:
            stage = self._stage(upload, directory)
        stem, suffix = os.path.splitext(upload["filename"])
        if len(suffix.encode("utf-8")) > 200:
            while len(suffix.encode("utf-8")) > 200:
                suffix = suffix[:-1]
        preferred = Path(upload["destination"]) if upload["destination"] else None
        index = 0
        while True:
            if preferred is not None:
                destination = preferred
            elif index == 0:
                destination = directory / upload["filename"]
            else:
                marker = f" ({index})"
                budget = 255 - len((marker + suffix).encode("utf-8"))
                short_stem = stem
                while len(short_stem.encode("utf-8")) > budget:
                    short_stem = short_stem[:-1]
                destination = directory / f"{short_stem}{marker}{suffix}"
            if upload["destination"] != str(destination):
                self.store.reserve_upload_destination(upload["id"], str(destination))
                upload = self.get(upload["id"])
            published = link_completed_file(stage, destination)
            if not published:
                left, right = stage.stat(), destination.lstat()
                if not stat.S_ISREG(right.st_mode) or (left.st_dev, left.st_ino) != (right.st_dev, right.st_ino):
                    if preferred is not None:
                        preferred = None
                        index = 1 if destination == directory / upload["filename"] else 0
                    else:
                        index += 1
                    continue
            self._sync_dir(directory)
            record = self.store.finish_upload(upload["id"], str(destination))
            self._cleanup(self.get(upload["id"]))
            return record

    def _published(self, upload: dict) -> bool:
        """Recognize an unregistered destination only by the spool/stage inode that published it."""
        if not upload["destination"]:
            return False
        destination = Path(upload["destination"])
        try:
            placed = destination.lstat()
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(placed.st_mode) or placed.st_size != upload["length"]:
            return False
        source = self._source(upload["id"])
        stage = destination.parent.parent / (".upload-" + upload["id"] + ".stage")
        for candidate in (source, stage):
            try:
                info = candidate.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino) != (placed.st_dev, placed.st_ino):
                continue
            if candidate == stage and source.exists() and self._digest(stage) != self._digest(source):
                raise OSError("已发布文件与上传源文件不一致")
            return True
        return False

    def _finish_termination(self, upload: dict) -> None:
        self._cleanup(upload)
        self.store.remove_upload(upload["id"])

    def terminate(self, identity: str) -> None:
        """Keep already published files, then commit termination before removing any spool data."""
        upload = self.get(identity)
        if not upload["completed"] and upload["offset"] == upload["length"] and self._published(upload):
            self.complete(upload)
            upload = self.get(identity)
        self.store.mark_upload_terminating(identity)
        self._finish_termination(upload)

    def recover(self) -> None:
        """Finish deletion intents first, then publish valid chunks and expire stale unplaced sessions."""
        now = time.time()
        for identity in self.store.terminating_uploads():
            self._finish_termination(self.store.upload(identity))
        for identity in self.store.pending_uploads():
            upload = self.get(identity)
            if upload["created_at"] < now - UPLOAD_LIFETIME and not self._published(upload):
                self.terminate(identity)
            elif upload["offset"] == upload["length"]:
                self.complete(upload)
            else:
                with self._source(identity).open("r+b") as stream:
                    stream.truncate(upload["offset"])
        for identity in self.store.completed_uploads():
            self._cleanup(self.get(identity))

    def expire(self) -> None:
        """Never evict a session while a PATCH is reading its body; published files survive expiry."""
        for identity in self.store.expired_uploads(time.time() - UPLOAD_LIFETIME):
            lock = self._locks.get(identity)
            if lock is None or not lock.locked():
                self.terminate(identity)
