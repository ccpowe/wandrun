"""Bounded, verified file snapshots over an owner's ready SSH connection.

Transfers use held, no-follow descriptors rather than an SFTP check/open race.
Only complete, verified inodes receive exclusive public names, never replacing existing files.
The file registry remains the gateway's existing registry, not this transport.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import stat
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from wandrun.integrations.shell_backend import CleanupUnconfirmedError

from wandrun.integrations.ssh_backend import remote_script

CHUNK_SIZE = 1024 * 1024
TRANSFER_CLEANUP_LIMIT = 10.0

# The remote programs are fixed gateway code; every supplied path stays an argv value.
_SAFE_OPEN = r'''
import hashlib, json, os, pathlib, stat, sys
CHUNK = 1024 * 1024
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

def directory(path, create=False):
    parts = pathlib.PurePosixPath(path).parts
    if not parts or parts[0] != '/' or any(p in ('.', '..', '.wandrun') for p in parts[1:]):
        raise ValueError('invalid directory')
    fd = os.open('/', FLAGS)
    try:
        for part in parts[1:]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise

def version(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def check_directory(fd, path):
    other = directory(path)
    try:
        a, b = os.fstat(fd), os.fstat(other)
        if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
            raise ValueError('directory replaced')
    finally:
        os.close(other)

def emit(value):
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=True).encode() + b'\n')
    sys.stdout.buffer.flush()
'''

_DOWNLOAD = _SAFE_OPEN + r'''
root, requested, maximum = sys.argv[1:]
maximum = int(maximum)
relative = pathlib.PurePosixPath(requested).relative_to(pathlib.PurePosixPath(root))
if not relative.parts or any(p in ('.', '..', '.wandrun') or (p.startswith('.wandrun-') and p.endswith('.stage')) for p in relative.parts):
    raise ValueError('invalid source')
control = (pathlib.Path(root) / '.wandrun').resolve(strict=False)
if pathlib.Path(requested).is_relative_to(control):
    raise ValueError('control source is not allowed')
parent = directory(str(pathlib.PurePosixPath(root) / relative.parent))
try:
    fd = os.open(relative.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
finally:
    os.close(parent)
try:
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or not before.st_nlink:
        raise ValueError('source is not a regular file')
    if maximum >= 0 and before.st_size > maximum:
        emit(dict(error='too_large', maximum=maximum))
        raise ValueError('source exceeds size limit')
    emit(dict(name=relative.name, size=before.st_size))
    digest = hashlib.sha256()
    remaining = before.st_size
    while remaining:
        chunk = os.read(fd, min(CHUNK, remaining))
        if not chunk:
            raise ValueError('source truncated')
        digest.update(chunk)
        sys.stdout.buffer.write(chunk)
        remaining -= len(chunk)
    if os.read(fd, 1) or version(before) != version(os.fstat(fd)):
        raise ValueError('source changed')
    emit(dict(sha256=digest.hexdigest()))
finally:
    os.close(fd)
'''

_UPLOAD = _SAFE_OPEN + r'''
root, identity, filename, expected, stage = sys.argv[1:]
expected = int(expected)
if expected < 0 or not (identity == 'output' or identity.startswith('f_') and identity[2:].isalnum()) or not filename or filename in ('.', '..', '.wandrun') or '/' in filename or '\\' in filename or (filename.startswith('.wandrun-') and filename.endswith('.stage')):
    raise ValueError('invalid upload')
if not stage.startswith('.wandrun-') or not stage.endswith('.stage') or '/' in stage or '\\' in stage:
    raise ValueError('invalid stage')
parent = None
try:
    parent = directory(root, create=True)
    fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
except BaseException:
    if parent is not None:
        os.close(parent)
    emit(dict(publication='rejected'))
    emit(dict(cleanup=stage))
    raise
publication_uncertain = False
try:
    digest = hashlib.sha256()
    remaining = expected
    while remaining:
        chunk = sys.stdin.buffer.read(min(CHUNK, remaining))
        if not chunk:
            raise ValueError('upload interrupted')
        digest.update(chunk)
        view = memoryview(chunk)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError('short write')
            view = view[written:]
        remaining -= len(chunk)
    os.fsync(fd)
    completed = os.fstat(fd)
    checksum = digest.hexdigest()
    emit(dict(sha256=checksum))
    # The gateway approves only after its held source also passed the version check.
    if sys.stdin.buffer.readline(16) != b'publish\n':
        raise ValueError('publication not approved')
    target = root if identity == 'output' else str(pathlib.PurePosixPath(root) / 'uploads' / identity / checksum)
    destination = directory(target, create=True)
    try:
        check_directory(parent, root)
        check_directory(destination, target)
        staged = os.stat(stage, dir_fd=parent, follow_symlinks=False)
        if version(staged) != version(completed) or version(os.fstat(fd)) != version(completed):
            raise ValueError('staging file replaced or changed')
        published_name = filename
        index = 0
        while True:
            try:
                publication_uncertain = True
                os.link(stage, published_name, src_dir_fd=parent, dst_dir_fd=destination, follow_symlinks=False)
                published = os.stat(published_name, dir_fd=destination, follow_symlinks=False)
                held = os.fstat(fd)
                if (published.st_dev, published.st_ino) != (held.st_dev, held.st_ino):
                    raise ValueError('published file replaced')
            except FileExistsError:
                publication_uncertain = False
                if identity == 'output':
                    index += 1
                    stem, suffix = os.path.splitext(filename)
                    published_name = f'{stem} ({index}){suffix}'
                    continue
                existing = os.open(published_name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=destination)
                try:
                    info = os.fstat(existing)
                    if not stat.S_ISREG(info.st_mode) or info.st_size != expected:
                        raise ValueError('destination conflict')
                    actual = hashlib.sha256()
                    while True:
                        chunk = os.read(existing, CHUNK)
                        if not chunk:
                            break
                        actual.update(chunk)
                    if actual.hexdigest() != checksum or version(info) != version(os.fstat(existing)):
                        raise ValueError('destination conflict')
                finally:
                    os.close(existing)
            break
        os.fsync(destination)
        check_directory(destination, target)
        emit(dict(publication='published', path=str(pathlib.PurePosixPath(target) / published_name), name=published_name, size=expected))
    finally:
        os.close(destination)
except BaseException:
    emit(dict(publication='unknown' if publication_uncertain else 'rejected'))
    raise
finally:
    try:
        staged = os.stat(stage, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        held = os.fstat(fd)
        if (staged.st_dev, staged.st_ino) == (held.st_dev, held.st_ino):
            os.unlink(stage, dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(fd)
        os.close(parent)
    emit(dict(cleanup=stage))
'''

_PREPARE = _SAFE_OPEN + r'''
root = sys.argv[1]
fd = directory(root, create=True)
try:
    check_directory(fd, root)
    os.fsync(fd)
    emit(dict(path=root))
finally:
    os.close(fd)
'''


async def prepare_file_output(
    connection, root: str, *, debts: dict, pending: set,
    owners: dict[str, str | None], owner: str | None,
) -> None:
    """Prepare and verify every directory component before starting a billable request."""
    async with _process(
        connection, _PREPARE, root, debts=debts, pending=pending, owners=owners, owner=owner,
    ) as process:
        receipt = await _json_line(process.stdout)
        await process.wait_closed()
        if process.exit_status != 0 or receipt != {"path": root}:
            raise OSError("无法准备远端对话文件目录")


async def read_task_file(
    connection, requested: str, root: str, *, max_bytes: int, debts: dict, pending: set,
    owners: dict[str, str | None], owner: str | None,
) -> bytes:
    """Read a bounded no-follow file, verifying the complete version before returning bytes."""
    if max_bytes < 0:
        raise ValueError("文件大小上限不能为负数")
    async with _process(
        connection, _DOWNLOAD, root, requested, str(max_bytes),
        debts=debts, pending=pending, owners=owners, owner=owner,
    ) as process:
        metadata = await _json_line(process.stdout)
        size = metadata.get("size")
        if not isinstance(size, int) or not 0 <= size <= max_bytes:
            raise ValueError(f"文件不能超过 {max_bytes} 字节")
        content = bytearray()
        checksum = hashlib.sha256()
        while len(content) < size:
            chunk = await process.stdout.read(min(CHUNK_SIZE, size - len(content)))
            if not chunk:
                raise OSError("文件读取未完成")
            content.extend(chunk)
            checksum.update(chunk)
        receipt = await _json_line(process.stdout)
        await process.wait_closed()
        if process.exit_status != 0 or receipt.get("sha256") != checksum.hexdigest():
            raise OSError("文件读取期间已变化")
        return bytes(content)


def _version(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _directory(path: Path, *, create: bool = False) -> int:
    """Open every component without following links, optionally creating missing directories."""
    if not path.is_absolute() or '..' in path.parts or '.wandrun' in path.parts:
        raise ValueError('交付目录不是允许的普通目录')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open('/', flags)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _verify_directory(descriptor: int, path: Path) -> None:
    live = _directory(path)
    try:
        left, right = os.fstat(descriptor), os.fstat(live)
        if (left.st_dev, left.st_ino) != (right.st_dev, right.st_ino):
            raise OSError('交付目录已被替换')
    finally:
        os.close(live)


def _write(descriptor: int, chunk: bytes) -> None:
    view = memoryview(chunk)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError('文件写入未完成')
        view = view[written:]


def _remove_stage(parent: int, stage: str, descriptor: int) -> None:
    try:
        staged = os.stat(stage, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    owned = os.fstat(descriptor)
    if (staged.st_dev, staged.st_ino) == (owned.st_dev, owned.st_ino):
        os.unlink(stage, dir_fd=parent)

def _stage(directory: Path) -> tuple[int, str, int]:
    parent = _directory(directory, create=True)
    name = f'.wandrun-{uuid4().hex}.stage'
    try:
        descriptor = os.open(
            name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600, dir_fd=parent,
        )
        return parent, name, descriptor
    except BaseException:
        os.close(parent)
        raise



def _publish(parent: int, stage: str, base: Path, name: str, digest: str, size: int, source_fd: int) -> Path:
    target = base / digest
    destination = _directory(target, create=True)
    try:
        _verify_directory(parent, base)
        _verify_directory(destination, target)
        staged = os.stat(stage, dir_fd=parent, follow_symlinks=False)
        owned = os.fstat(source_fd)
        if (staged.st_dev, staged.st_ino) != (owned.st_dev, owned.st_ino) or staged.st_size != size:
            raise OSError('交付暂存文件已被替换')
        try:
            os.link(stage, name, src_dir_fd=parent, dst_dir_fd=destination, follow_symlinks=False)
            published = os.stat(name, dir_fd=destination, follow_symlinks=False)
            if (published.st_dev, published.st_ino) != (owned.st_dev, owned.st_ino):
                raise OSError('已发布文件已被替换')
        except FileExistsError:
            descriptor = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=destination)
            try:
                info = os.fstat(descriptor)
                if not stat.S_ISREG(info.st_mode) or info.st_size != size:
                    raise OSError('已交付副本与内容身份冲突')
                checksum = hashlib.sha256()
                while chunk := os.read(descriptor, CHUNK_SIZE):
                    checksum.update(chunk)
                if checksum.hexdigest() != digest or _version(info) != _version(os.fstat(descriptor)):
                    raise OSError('已交付副本已被修改')
            finally:
                os.close(descriptor)
        os.fsync(destination)
        _verify_directory(destination, target)
        return target / name
    finally:
        os.close(destination)


@asynccontextmanager
async def _process(
    connection, script: str, *args: str, debts: dict, pending: set,
    owners: dict[str, str | None], owner: str | None,
    publication: _UploadReceipt | None = None,
):
    # Retain ownership if cancellation lands while AsyncSSH is still opening
    # the channel, just as the shared SFTP opener does.
    caller = asyncio.current_task()
    cleanup_path = publication.stage_path if publication is not None else None

    async def open_channel():
        if caller.cancelling():
            return None  # A queued transfer cannot start after its owner was stopped.
        return await connection.create_process(
            remote_script('python3 -c "$1" ' + ' '.join(f'"${index}"' for index in range(2, len(args) + 2)), script, *args),
            encoding=None, stderr=asyncio.subprocess.DEVNULL,
        )

    opening = asyncio.create_task(open_channel())
    identity = "transfer-" + uuid4().hex
    owners[identity] = owner
    try:
        process = await asyncio.shield(opening)
        if process is None:
            raise asyncio.CancelledError
        yield process
    finally:
        async def close():
            try:
                process = await opening
            except Exception:
                # create_process can lose the exec acknowledgement after the
                # peer started the script, including ChannelOpenError. Only
                # open_channel's local None sentinel proves no submission.
                return False
            if process is None:
                return True
            if process.exit_status is None:
                process.stdin.write_eof()
            # EOF makes an interrupted uploader run its finally/unlink. Drain
            # bounded chunks so a cancelled downloader cannot block its peer
            # on a full SSH receive window during cleanup.
            if publication is not None:
                await publication.drain(process.stdout)
            else:
                while await process.stdout.read(CHUNK_SIZE):
                    pass
            await process.wait_closed()
            if process.exit_status is None:
                return False
            if publication is not None:
                return publication.released
            return True

        debts[identity] = "文件传输清理或发布结果尚未确认" + (f"；暂存路径 {cleanup_path}" if cleanup_path else "")
        cleanup = asyncio.create_task(close())
        pending.add(cleanup)

        def settled(task):
            pending.discard(task)
            if not task.cancelled() and task.exception() is None and task.result():
                debts.pop(identity, None)
                owners.pop(identity, None)

        cleanup.add_done_callback(settled)
        try:
            async with asyncio.timeout(TRANSFER_CLEANUP_LIMIT):
                confirmed = await asyncio.shield(cleanup)
            if not confirmed:
                raise CleanupUnconfirmedError("文件传输清理未确认；环境持有者保留暂存路径与清理责任")
        except Exception as error:
            if caller.cancelling():
                raise asyncio.CancelledError from None
            if isinstance(error, TimeoutError):
                raise CleanupUnconfirmedError("文件传输清理未确认；环境持有者保留通道清理责任") from None
            raise


async def _json_line(reader) -> dict:
    return _decode_json_line(await reader.readline())


def _decode_json_line(line: bytes) -> dict:
    if len(line) > 8192:
        raise OSError('文件传输回执过大')
    try:
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (ValueError, TypeError):
        raise OSError('文件传输中断或源文件不允许交付') from None


class _UploadReceipt:
    """Own publication knowledge and its in-flight reader through caller cancellation.

    Both the foreground and channel cleanup use the same validated protocol state.
    Cleanup alone never proves a submitted publication was rejected or succeeded.
    """

    def __init__(self, root: str, identity: str, name: str, size: int, stage: str):
        self.root = Path(root)
        self.identity = identity
        self.name = name
        self.size = size
        self.stage = stage
        self.stage_path = str(self.root / stage)
        self.checksum: str | None = None
        self.publish_sent = False
        self.terminal: str | None = None
        self.result: dict | None = None
        self.cleaned = False
        self.invalid = False
        self._reading: asyncio.Task | None = None

    def approve(self, checksum: str) -> None:
        self.checksum = checksum
        self.publish_sent = True

    def observe(self, value: dict) -> None:
        try:
            if "cleanup" in value:
                if value != {"cleanup": self.stage}:
                    raise OSError("远端暂存清理回执无效")
                self.cleaned = True
            elif "publication" in value:
                terminal = value["publication"]
                if terminal not in {"published", "rejected", "unknown"} or (
                    self.terminal is not None and self.terminal != terminal
                ):
                    raise OSError("远端文件发布终态冲突")
                if terminal == "published":
                    name = value.get("name")
                    directory = (
                        self.root if self.identity == "output" else
                        self.root / "uploads" / self.identity / (self.checksum or "")
                    )
                    stem, suffix = os.path.splitext(self.name)
                    valid_name = isinstance(name, str) and (
                        name == self.name or self.identity == "output" and re.fullmatch(
                            re.escape(stem) + r" \([1-9][0-9]*\)" + re.escape(suffix), name,
                        ) is not None
                    )
                    if (not self.publish_sent or not valid_name
                            or value.get("path") != str(directory / name)
                            or type(value.get("size")) is not int or value["size"] != self.size):
                        raise OSError("远端未确认有效的文件发布落点")
                    self.result = {key: value[key] for key in ("path", "name", "size")}
                elif value != {"publication": terminal}:
                    raise OSError("远端文件发布终态回执无效")
                self.terminal = terminal
            elif set(value) != {"sha256"} or not isinstance(value["sha256"], str):
                raise OSError("远端文件传输回执无效")
        except (OSError, TypeError, ValueError):
            self.invalid = True
            raise

    @property
    def released(self) -> bool:
        return not self.invalid and self.cleaned and (
            not self.publish_sent or self.terminal in {"published", "rejected"}
        )

    async def read_reply(self, reader) -> dict:
        async def read_and_record():
            value = await _json_line(reader)
            self.observe(value)
            return value

        reading = asyncio.create_task(read_and_record())
        self._reading = reading
        try:
            return await asyncio.shield(reading)
        finally:
            if reading.done():
                self._reading = None

    async def drain(self, reader) -> None:
        if self._reading is not None:
            try:
                await self._reading
            finally:
                self._reading = None
        while line := await reader.readline():
            self.observe(_decode_json_line(line))


async def download_snapshot(
    connection, requested: str, root: str, destination: Path, *,
    debts: dict, pending: set, owners: dict[str, str | None], owner: str | None,
) -> dict:
    """Copy one permitted remote regular file; no public path exists until verification completes."""
    parent, stage, descriptor = _stage(destination)
    try:
        async with _process(
            connection, _DOWNLOAD, root, requested, "-1", debts=debts, pending=pending,
            owners=owners, owner=owner,
        ) as process:
            info = await _json_line(process.stdout)
            name, size = info['name'], info['size']
            if not isinstance(name, str) or name in ('', '.', '..', '.wandrun') or '/' in name or '\\' in name or not isinstance(size, int) or size < 0:
                raise OSError('文件传输元数据无效')
            checksum = hashlib.sha256()
            remaining = size
            while remaining:
                chunk = await process.stdout.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    raise OSError('文件传输未完成')
                checksum.update(chunk)
                _write(descriptor, chunk)
                remaining -= len(chunk)
            receipt = await _json_line(process.stdout)
            digest = checksum.hexdigest()
            if receipt.get('sha256') != digest:
                raise OSError('文件传输校验失败或源文件已变化')
            await process.wait_closed()
            if process.exit_status != 0:
                raise OSError('源文件在传输时已变化')
            os.fsync(descriptor)
            path = _publish(parent, stage, destination, name, digest, size, descriptor)
            return dict(path=str(path), name=name, size=size, delivery_digest=digest)
    finally:
        try:
            _remove_stage(parent, stage, descriptor)
        finally:
            os.close(descriptor)
            os.close(parent)


async def upload_snapshot(
    connection, source_fd: int | bytes, root: str, identity: str, name: str, *,
    debts: dict, pending: set, owners: dict[str, str | None], owner: str | None,
) -> dict:
    """Import a held gateway source, or immutable output bytes, with confirmed no-clobber publication."""
    if (not name or name in (".", "..", ".wandrun") or "/" in name or "\\" in name
            or name.startswith(".wandrun-") and name.endswith(".stage")
            or not (identity == "output" or identity.startswith("f_") and identity[2:].isalnum())):
        raise ValueError("无效的文件发布名称")
    before = os.fstat(source_fd) if isinstance(source_fd, int) else None
    if before is not None and not stat.S_ISREG(before.st_mode):
        raise ValueError('上传附件必须是普通文件')
    size = before.st_size if before is not None else len(source_fd)
    if before is not None:
        os.lseek(source_fd, 0, os.SEEK_SET)
    stage = f'.wandrun-{uuid4().hex}.stage'
    publication = _UploadReceipt(root, identity, name, size, stage)
    async with _process(
        connection, _UPLOAD, root, identity, name, str(size), stage,
        debts=debts, pending=pending, publication=publication,
        owners=owners, owner=owner,
    ) as process:
        async def reply():
            value = await publication.read_reply(process.stdout)
            if "cleanup" in value or value.get("publication") in {"rejected", "unknown"}:
                raise OSError("远端文件发布未完成；不报告成功")
            return value

        checksum = hashlib.sha256()
        remaining = size
        offset = 0
        while remaining:
            chunk = (
                os.read(source_fd, min(CHUNK_SIZE, remaining)) if before is not None
                else memoryview(source_fd)[offset:offset + min(CHUNK_SIZE, remaining)]
            )
            offset += len(chunk)
            if not chunk:
                raise OSError('上传源文件在获取时已变化')
            checksum.update(chunk)
            process.stdin.write(chunk)
            await process.stdin.drain()
            remaining -= len(chunk)
        receipt = await reply()
        if (receipt.get('sha256') != checksum.hexdigest()
                or before is not None and (
                    os.read(source_fd, 1) or _version(before) != _version(os.fstat(source_fd))
                )):
            raise OSError('上传源文件在获取时已变化')
        publication.approve(checksum.hexdigest())
        process.stdin.write(b'publish\n')
        await process.stdin.drain()
        process.stdin.write_eof()
        await reply()
        result = publication.result
        if publication.terminal != "published" or result is None:
            raise OSError("远端未确认文件发布成功")
    # The context owns bounded waiting for the cleanup ACK and channel exit.
    # Do not wait here before entering that cleanup phase.
    if process.exit_status != 0:
        raise OSError('文件获取未完成')
    return result


async def copy_snapshot(source_fd: int, destination: Path, name: str) -> dict:
    """Publish a bounded local copy, with the same content identity and no-clobber rules."""
    before = os.fstat(source_fd)
    parent, stage, descriptor = _stage(destination)
    try:
        checksum = hashlib.sha256()
        os.lseek(source_fd, 0, os.SEEK_SET)
        remaining = before.st_size
        while remaining:
            chunk = os.read(source_fd, min(CHUNK_SIZE, remaining))
            if not chunk:
                raise OSError('上传源文件在获取时已变化')
            checksum.update(chunk)
            _write(descriptor, chunk)
            remaining -= len(chunk)
            await asyncio.sleep(0)
        if os.read(source_fd, 1) or _version(before) != _version(os.fstat(source_fd)):
            raise OSError('上传源文件在获取时已变化')
        os.fsync(descriptor)
        path = _publish(parent, stage, destination, name, checksum.hexdigest(), before.st_size, descriptor)
        return dict(path=str(path), name=name, size=before.st_size)
    finally:
        try:
            _remove_stage(parent, stage, descriptor)
        finally:
            os.close(descriptor)
            os.close(parent)
