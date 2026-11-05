"""Gateway-owned skill snapshots and lazy, one-way publication to a ready SSH backend.

Metadata never consults the execution environment. Published versions are immutable by
contract, not OS isolation: remote writers can still modify them. A new connection
verifies their complete contents before reuse; a mismatch fails rather than overwrites.
"""

from __future__ import annotations

import asyncio
import os
import posixpath
import stat
from collections.abc import Collection, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

import asyncssh
from asyncssh.constants import FILEXFER_TYPE_DIRECTORY, FILEXFER_TYPE_REGULAR

from wandrun.integrations.ssh_backend import SSHBackend, sftp_client
from wandrun.integrations.shell_backend import CleanupUnconfirmedError

_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
_MISSING = (asyncssh.SFTPNoSuchFile, asyncssh.SFTPNoSuchPath)


@dataclass(frozen=True)
class _Entry:
    path: str
    mode: int
    content: bytes | None  # None denotes a directory, including the package root.


@dataclass(frozen=True)
class SkillSnapshot:
    """One frozen complete package; paths and document bytes belong to the same version."""

    root: str
    version: str
    document: bytes
    _entries: tuple[_Entry, ...] = field(repr=False)

    @property
    def path(self) -> str:
        return posixpath.join(self.root, "SKILL.md")


@contextmanager
def _open_directory(source: Path) -> Iterator[int]:
    # Match the gateway boundary: not even an ancestor of the root may be a link.
    parts = source.absolute().parts
    descriptor = os.open(parts[0], _DIRECTORY_FLAGS)
    try:
        for part in parts[1:]:
            child = os.open(part, _DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def _read_entries(directory: int, prefix: str = "") -> list[_Entry]:
    entries = [_Entry(prefix, stat.S_IMODE(os.fstat(directory).st_mode), None)]
    for name in sorted(os.listdir(directory)):
        path = posixpath.join(prefix, name)
        path.encode("utf-8")  # SFTP paths must be representable without surrogate escapes.
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, _DIRECTORY_FLAGS, dir_fd=directory)
            try:
                entries.extend(_read_entries(child, path))
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode):
            descriptor = os.open(name, _FILE_FLAGS, dir_fd=directory)
            with os.fdopen(descriptor, "rb") as source:
                before = os.fstat(source.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise ValueError(f"skill 包文件不是普通文件：{path}")
                content = source.read()
                after = os.fstat(source.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns,
            ):
                raise OSError(f"读取期间 skill 包文件发生变化：{path}")
            entries.append(_Entry(path, stat.S_IMODE(after.st_mode), content))
        else:
            raise ValueError(f"skill 包不支持符号链接或异常文件：{path}")
    return entries


def _version(name: str, entries: tuple[_Entry, ...]) -> str:
    digest = sha256(name.encode("utf-8") + b"\0")
    for entry in entries:
        path = entry.path.encode("utf-8")
        digest.update(len(path).to_bytes(8, "big"))
        digest.update(path)
        digest.update(entry.mode.to_bytes(4, "big"))
        digest.update(b"d" if entry.content is None else b"f")
        if entry.content is not None:
            digest.update(len(entry.content).to_bytes(8, "big"))
            digest.update(entry.content)
    return digest.hexdigest()


class SkillPackages:
    """Freeze selected gateway packages and prepare all retained versions on real I/O.

    snapshot() is synchronous host-only discovery; it does not open a backend. Old
    selections remain registered so concurrent agents and checkpoint paths keep working.
    prepare() accepts only the already-ready SSH backend, never the lazy provider facade.
    A cancelled lock waiter cannot cancel another preparation; an upload cancellation
    cleans only its own staging directory and propagates to the caller.
    """

    def __init__(self, source: Path, builtin_source: Path | None, remote_root: str):
        if (
            not remote_root.startswith("/") or not remote_root.strip("/")
            or "\x00" in remote_root
            or any(part in {".", ".."} for part in remote_root.split("/"))
        ):
            raise ValueError("skill 包远端根目录必须是绝对 POSIX 路径，且不能含 . 或 ..")
        self._source = source
        self._builtin_source = builtin_source
        self._remote_root = posixpath.normpath(remote_root)
        self._snapshots: dict[str, SkillSnapshot] = {}
        self._lock = asyncio.Lock()
        self._connection = None
        self._prepared: set[str] = set()
        self._pending_staging: dict[str, SkillSnapshot] = {}

    def snapshot(
        self, names: Collection[str], *, builtin_names: Collection[str] = (),
    ) -> tuple[SkillSnapshot, ...]:
        """Read complete selected packages, with builtin names overriding user names.

        Invalid paths, links, special files and read failures propagate, never become an
        empty catalog. Registration is all-or-nothing if any selected package fails.
        """
        reserved = set(builtin_names)
        selections = [
            (name, self._source, "user") for name in dict.fromkeys(names)
            if name not in reserved
        ] + [(name, self._builtin_source, "builtin") for name in sorted(reserved)]
        snapshots = []
        for name, source, kind in selections:
            if not name or name in {".", ".."} or "/" in name or "\x00" in name:
                raise ValueError("技能名称必须是技能目录中的单个名称，不能是路径")
            if source is None:
                raise ValueError(f"未找到配置的 skill: {name}")
            try:
                with _open_directory(source) as root:
                    directory = os.open(name, _DIRECTORY_FLAGS, dir_fd=root)
                    try:
                        entries = tuple(_read_entries(directory))
                    finally:
                        os.close(directory)
            except FileNotFoundError as error:
                raise ValueError(f"未找到配置的 skill 或包文件: {name}") from error
            document = next((entry.content for entry in entries if entry.path == "SKILL.md"), None)
            if document is None:
                raise ValueError(f"skill 包缺少普通文件 SKILL.md: {name}")
            version = _version(name, entries)
            target = posixpath.join(self._remote_root, kind, version, name)
            snapshots.append(self._snapshots.get(target) or SkillSnapshot(target, version, document, entries))
        self._snapshots.update((snapshot.root, snapshot) for snapshot in snapshots)
        return tuple(snapshots)

    @property
    def skills_source(self) -> str:
        """Planned execution-side catalog location for the official skills prompt."""
        return posixpath.join(self._remote_root, "user")

    @property
    def builtin_skills_source(self) -> str | None:
        return posixpath.join(self._remote_root, "builtin") if self._builtin_source is not None else None

    @property
    def pending_staging(self) -> tuple[str, ...]:
        """Private publication directories not yet confirmed renamed or removed."""
        return tuple(sorted(self._pending_staging))

    async def prepare(self, backend: SSHBackend) -> None:
        """Verify/reuse or atomically publish retained packages on the ready connection."""
        if not self._snapshots:
            return
        async with self._lock:
            connection = backend._connection
            if connection is None:
                raise RuntimeError("skill 包准备需要已就绪的 SSH 连接")
            if connection is not self._connection:
                self._connection = connection
                self._prepared.clear()
            pending = [item for path, item in self._snapshots.items() if path not in self._prepared]
            if not pending and not self._pending_staging:
                return
            async with sftp_client(connection) as sftp:
                for staging, snapshot in tuple(self._pending_staging.items()):
                    try:
                        await _remove_staging(sftp, staging, snapshot)
                    except Exception as error:
                        raise CleanupUnconfirmedError(f"技能临时目录清理未确认：{staging}") from error
                    self._pending_staging.pop(staging, None)
                # A turn may register another snapshot while an upload awaits the network.
                while pending:
                    for snapshot in pending:
                        await _prepare_package(sftp, snapshot, self._pending_staging)
                        self._prepared.add(snapshot.root)
                    pending = [item for path, item in self._snapshots.items() if path not in self._prepared]


async def _ensure_directory(sftp, path: str) -> None:
    directory = "/"
    for part in path.split("/")[1:]:
        directory = posixpath.join(directory, part)
        try:
            attrs = await sftp.lstat(directory)
        except _MISSING:
            try:
                await sftp.mkdir(directory, asyncssh.SFTPAttrs(permissions=0o700))
            except (asyncssh.SFTPFailure, asyncssh.SFTPFileAlreadyExists):
                pass  # A competing publisher may have created it; verify its type below.
            attrs = await sftp.lstat(directory)
        if attrs.type != FILEXFER_TYPE_DIRECTORY:
            raise OSError(f"skill 包目录不是普通目录（禁止符号链接）：{directory}")


async def _verify_package(sftp, container: str, snapshot: SkillSnapshot) -> bool:
    try:
        attrs = await sftp.lstat(container)
    except _MISSING:
        return False
    if attrs.type != FILEXFER_TYPE_DIRECTORY:
        raise OSError(f"skill 包目录不是普通目录（禁止符号链接）：{container}")
    name = posixpath.basename(snapshot.root)
    expected_children = {"": {name}}
    for entry in snapshot._entries:
        relative = posixpath.join(name, entry.path) if entry.path else name
        expected_children.setdefault(posixpath.dirname(relative), set()).add(posixpath.basename(relative))
        if entry.content is None:
            expected_children.setdefault(relative, set())
        path = posixpath.join(container, relative)
        attrs = await sftp.lstat(path)
        expected_type = FILEXFER_TYPE_DIRECTORY if entry.content is None else FILEXFER_TYPE_REGULAR
        if attrs.type != expected_type or attrs.permissions is None or stat.S_IMODE(attrs.permissions) != entry.mode:
            raise OSError(f"远端 skill 包类型或权限与快照不一致：{path}")
        if entry.content is not None:
            async with sftp.open(path, "rb") as remote:
                if await remote.read() != entry.content:
                    raise OSError(f"远端 skill 包内容与快照不一致：{path}")
    for relative, expected in expected_children.items():
        children = {
            child.filename async for child in sftp.scandir(posixpath.join(container, relative))
            if child.filename not in {".", ".."}
        }
        if children != expected:
            raise OSError(f"远端 skill 包目录内容与快照不一致：{posixpath.join(container, relative)}")
    return True


async def _remove_staging(sftp, staging: str, snapshot: SkillSnapshot) -> None:
    # Restore only our staging directories, never published packages or shared parents.
    try:
        attrs = await sftp.lstat(staging)
    except _MISSING:
        return
    if attrs.type != FILEXFER_TYPE_DIRECTORY:
        raise OSError(f"skill staging 目录被替换，拒绝清理：{staging}")
    name = posixpath.basename(snapshot.root)
    for entry in snapshot._entries:
        if entry.content is None:
            path = posixpath.join(staging, name, entry.path) if entry.path else posixpath.join(staging, name)
            try:
                attrs = await sftp.lstat(path)
            except _MISSING:
                continue
            if attrs.type != FILEXFER_TYPE_DIRECTORY:
                raise OSError(f"skill staging 目录被替换，拒绝清理：{path}")
            await sftp.chmod(path, entry.mode | 0o700)
    await sftp.rmtree(staging)


async def _prepare_package(sftp, snapshot: SkillSnapshot, pending_staging: dict[str, SkillSnapshot]) -> None:
    # SFTP cannot pin parent directory handles. As with artifact publication, hostile
    # concurrent replacement of a checked remote ancestor is outside this boundary.
    container = posixpath.dirname(snapshot.root)
    parent = posixpath.dirname(container)
    await _ensure_directory(sftp, parent)
    if await _verify_package(sftp, container, snapshot):
        return
    staging = posixpath.join(parent, f".stage-{uuid4().hex}")
    pending_staging[staging] = snapshot
    try:
        await sftp.mkdir(staging, asyncssh.SFTPAttrs(permissions=0o700))
        name = posixpath.basename(snapshot.root)
        for entry in snapshot._entries:
            path = posixpath.join(staging, name, entry.path) if entry.path else posixpath.join(staging, name)
            if entry.content is None:
                await sftp.mkdir(path, asyncssh.SFTPAttrs(permissions=0o700))
            else:
                async with sftp.open(path, "xb") as remote:
                    await remote.write(entry.content)
                await sftp.chmod(path, entry.mode)
        # Set directory modes last so read-only source directories do not prevent upload.
        for entry in reversed(snapshot._entries):
            if entry.content is None:
                path = posixpath.join(staging, name, entry.path) if entry.path else posixpath.join(staging, name)
                await sftp.chmod(path, entry.mode)
        await _verify_package(sftp, staging, snapshot)
        try:
            # Standard SFTP rename is atomic and refuses an existing target; no overwrite.
            await sftp.rename(staging, container)
        except asyncssh.SFTPError:
            if not await _verify_package(sftp, container, snapshot):
                raise
        else:
            pending_staging.pop(staging, None)
            return
    except BaseException as error:
        try:
            await _remove_staging(sftp, staging, snapshot)
            pending_staging.pop(staging, None)
        except Exception as cleanup:
            error.add_note(f"清理 skill staging 失败：{type(cleanup).__name__}")
            if not isinstance(error, asyncio.CancelledError):
                raise CleanupUnconfirmedError(f"技能临时目录清理未确认：{staging}") from error
        raise
    try:
        await _remove_staging(sftp, staging, snapshot)
    except Exception as error:
        raise CleanupUnconfirmedError(f"技能临时目录清理未确认：{staging}") from error
    pending_staging.pop(staging, None)
