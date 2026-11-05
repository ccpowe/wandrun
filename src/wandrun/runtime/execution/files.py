"""Task-relative filesystem views, recipient-native delivery, and safe file publication."""

from __future__ import annotations

import asyncio
import errno
import json
import logging
import mimetypes
import os
import posixpath
import shlex
import stat
from contextvars import ContextVar
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from deepagents.backends.protocol import ExecuteResponse, SandboxBackendProtocol
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from wandrun.integrations.ssh_backend import remote_script
from wandrun.runtime.browser.leases import BrowserRejected

logger = logging.getLogger(__name__)


def link_completed_file(
    source: str | Path, destination: str | Path, *,
    src_dir_fd: int | None = None, dst_dir_fd: int | None = None,
) -> bool:
    """Claim a public filename by hard-linking a completed inode, never replacing an existing entry."""
    try:
        os.link(
            source, destination, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd,
            follow_symlinks=False,
        )
    except FileExistsError:
        return False
    return True


@dataclass(frozen=True)
class ResolvedAttachment:
    path: str
    name: str
    size: int
    media_type: str
    requested_path: str | None = None  # Exact spelling in SendMessage.attachments; path is the resolved file.
    # None means a host-local path; remote identity is captured at preflight, not inferred at download.
    remote_environment: str | None = None
    # Only immutable gateway snapshots have a digest; original local/remote paths do not.
    delivery_digest: str | None = None


@dataclass(frozen=True)
class PreparedAttachments:
    """Completed preflight plus a final synchronous binding check before message delivery."""

    attachments: list[ResolvedAttachment]
    receipts: list[dict]
    validate: Callable[[], None]


def open_delivery_file(
    root: Path, path: str, *, follow_symlinks: bool = True,
) -> tuple[int, Path, os.stat_result]:
    """Open a live regular workspace file, excluding lexical and canonical control paths.

    With follow_symlinks=False, reject every symlink and lexical parent traversal
    below root before opening the file. The caller owns the returned fd and must
    read it rather than reopening the returned path.
    """
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ValueError("交付文件必须是绝对本机路径")
    try:
        lexical = candidate.relative_to(root).parts
    except ValueError:
        lexical = candidate.parts
    if ".wandrun" in lexical or any(part.startswith(".wandrun-") and part.endswith(".stage") for part in lexical):
        raise ValueError("不能交付 workspace 控制文件或未发布的暂存文件")
    if follow_symlinks:
        descriptor = os.open(candidate, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    else:
        parts = candidate.relative_to(root).parts
        if not parts or ".." in parts:
            raise ValueError("文件必须位于当前对话目录内")
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        parent_fd = os.open(root, flags)
        try:
            for component in parts[:-1]:
                child_fd = os.open(component, flags, dir_fd=parent_fd)
                os.close(parent_fd)
                parent_fd = child_fd
            descriptor = os.open(
                parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=parent_fd,
            )
        finally:
            os.close(parent_fd)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("附件必须是普通文件")
        if not info.st_nlink:
            raise ValueError("交付文件已被替换或删除")
        # /proc reports the held dentry. Resolving this string again could follow
        # a replacement symlink to a different (public) file after the open.
        opened = Path(os.readlink(f"/proc/self/fd/{descriptor}"))
        relative = opened.relative_to(root)
        control = (root / ".wandrun").resolve(strict=False)
        if not relative.parts or ".wandrun" in relative.parts or opened.is_relative_to(control):
            raise ValueError("不能交付 workspace 控制文件")
        live = os.stat(opened, follow_symlinks=False)
        if (live.st_dev, live.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("交付文件已被替换或删除")
        return descriptor, opened, info
    except BaseException:
        os.close(descriptor)
        raise




_current_task: ContextVar[str | None] = ContextVar("wandrun_file_task", default=None)
_REMOTE_ATTACHMENT = """import json, mimetypes, os, pathlib, stat, sys
requested = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2]).resolve(strict=True)
try:
    lexical = requested.relative_to(root).parts
except ValueError:
    lexical = requested.parts
if '.wandrun' in lexical:
    raise ValueError('附件不是允许的普通文件')
fd = os.open(requested, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
try:
    info = os.fstat(fd)
    if not info.st_nlink:
        raise ValueError('附件已被替换或删除')
    opened = pathlib.Path(os.readlink(f'/proc/self/fd/{fd}'))
    relative = opened.relative_to(root)
    control = (root / '.wandrun').resolve(strict=False)
    if not stat.S_ISREG(info.st_mode) or '.wandrun' in relative.parts or opened.is_relative_to(control):
        raise ValueError('附件不是允许的普通文件')
    live = os.stat(opened, follow_symlinks=False)
    if (live.st_dev, live.st_ino) != (info.st_dev, info.st_ino):
        raise ValueError('附件已被替换或删除')
    print(json.dumps(dict(path=str(opened), name=requested.name, size=info.st_size,
                          media_type=mimetypes.guess_type(requested.name)[0] or 'application/octet-stream')))
finally:
    os.close(fd)
"""

_FILE_PATH_TOOLS = frozenset({"ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep"})


@dataclass
class _GlobCall:
    """Own backend tasks spawned by the official glob tool, including cancellation before they start."""

    tasks: set[asyncio.Task] = field(default_factory=set)
    closed: bool = False

    async def close(self) -> None:
        self.closed = True
        for task in self.tasks:
            if not task.done() and not task.cancelling():
                task.cancel()
        if not self.tasks:
            return
        cleanup = asyncio.gather(*self.tasks, return_exceptions=True)
        cancelled = False
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
        if cancelled:
            raise asyncio.CancelledError


_current_glob_call: ContextVar[_GlobCall | None] = ContextVar("wandrun_glob_call", default=None)


class TaskDirectoryError(RuntimeError):
    """The environment could not prepare cwd; the dependent file/command operation was not submitted."""


class TaskPathMiddleware(AgentMiddleware):
    """Expand task paths before normalization and own the official glob tool's derived backend tasks."""

    def __init__(self, files: TaskFiles):
        super().__init__()
        self.files = files

    async def awrap_tool_call(self, request, handler):
        call = request.tool_call
        if call.get("name") in _FILE_PATH_TOOLS:
            args = call.get("args", {})
            key = "file_path" if "file_path" in args else "path"
            path = args.get(key)
            if isinstance(path, str) and path and not path.startswith("/"):
                directory = self.files.directory(request.runtime.context["task_id"])
                call = {**call, "args": {**args, key: posixpath.join(directory, path)}}
                request = request.override(tool_call=call)
        try:
            if call.get("name") != "glob":
                return await handler(request)
            # Deep Agents 0.7.13 does not cancel the glob task when its caller stops.
            scope = _GlobCall()
            token = _current_glob_call.set(scope)
            try:
                return await handler(request)
            finally:
                try:
                    await scope.close()
                finally:
                    _current_glob_call.reset(token)
        except TaskDirectoryError as error:
            return ToolMessage(
                content=f"Error: {error}", tool_call_id=call["id"], status="error",
            )




class TaskFiles:
    """Resolve cwd by task ancestry, never by mutating a shared environment backend."""

    def __init__(
        self, workspace: Path, manager, environments: dict[str, tuple[str, str]],
        *, conversation_workdirs: bool, remote_backends: dict[str, object] | None = None,
    ):
        self.workspace = workspace.resolve()
        self.manager = manager
        self.environments = environments  # role -> (environment identity, execution root)
        self.remote_backends = remote_backends or {}
        self._remote_cleanup = {
            (identity, root): self.remote_backends[role]
            for role, (identity, root) in environments.items() if role in self.remote_backends
        }
        self.conversation_workdirs = conversation_workdirs
        self._upload_resolver = None
        self._file_operations: dict[str, tuple[frozenset[str], tuple[object, ...], str, bool]] = {}

    def update_environments(
        self, environments: dict[str, tuple[str, str]], remote_backends: dict[str, object],
    ) -> None:
        for role in self.pending_transfer_agents():
            if (environments.get(role) != self.environments.get(role)
                    or remote_backends.get(role) is not self.remote_backends.get(role)):
                raise ValueError("附件传输或文件发布尚未释放，不能切换执行环境")
        self.environments = environments
        self.remote_backends = remote_backends
        self._remote_cleanup.update({
            (identity, root): remote_backends[role]
            for role, (identity, root) in environments.items() if role in remote_backends
        })

    def pending_transfer_agents(self) -> set[str]:
        """Freeze both bindings through I/O and any backend-owned unconfirmed cleanup."""
        busy = set()
        for identity, (roles, backends, owner, active) in list(self._file_operations.items()):
            outstanding = any(
                owner in pending or None in pending
                for backend in backends
                for pending in [backend.pending_transfer_owners()]
            )
            if active or outstanding:
                busy.update(roles)
            else:
                del self._file_operations[identity]
        return busy

    @contextmanager
    def _file_operation(self, owner: str, *roles: str):
        identity = uuid4().hex
        backends = tuple(dict.fromkeys(
            self.remote_backends[role] for role in roles if role in self.remote_backends
        ))
        scope = frozenset(roles)
        self._file_operations[identity] = (scope, backends, owner, True)
        try:
            yield
        finally:
            self._file_operations[identity] = (scope, backends, owner, False)
            self.pending_transfer_agents()

    async def prepare_file_output(self, task_id: str) -> None:
        """Preflight the caller's writable conversation before a billable operation."""
        if not self.conversation_workdirs:
            raise ValueError("此入口不支持对话文件读写")
        role = self.manager.agent_name(task_id)
        token = _current_task.set(task_id)
        try:
            with self._file_operation(task_id, role):
                if role in self.remote_backends:
                    await self.remote_backends[role].aprepare_file_output(
                        self.directory(task_id), owner=task_id,
                    )
                else:
                    _, descriptor = self.open_local_conversation_directory(task_id, create=True)
                    os.close(descriptor)
        finally:
            _current_task.reset(token)

    async def read_task_file(self, task_id: str, path: str, *, max_bytes: int) -> bytes:
        """Read a bounded no-follow ordinary file confined to the caller's conversation."""
        if not self.conversation_workdirs:
            raise ValueError("此入口不支持对话文件读写")
        role = self.manager.agent_name(task_id)
        if not path or "://" in path or path.startswith("data:"):
            raise ValueError("文件路径必须位于当前对话目录内，不能是 URL")
        token = _current_task.set(task_id)
        try:
            with self._file_operation(task_id, role):
                if role not in self.remote_backends:
                    return self._read_local_file(task_id, path, max_bytes=max_bytes)
                directory = self.directory(task_id)
                requested = path if path.startswith("/") else posixpath.join(directory, path)
                return await self.remote_backends[role].aread_task_file(
                    requested, directory, max_bytes=max_bytes, owner=task_id,
                )
        finally:
            _current_task.reset(token)

    async def save_task_file(self, task_id: str, filename: str, content: bytes) -> str:
        """Exclusively publish complete bytes in the caller's actual Backend, never the gateway."""
        if not self.conversation_workdirs:
            raise ValueError("此入口不支持对话文件读写")
        role = self.manager.agent_name(task_id)
        token = _current_task.set(task_id)
        try:
            with self._file_operation(task_id, role):
                if role in self.remote_backends:
                    return await self.remote_backends[role].asave_task_file(
                        self.directory(task_id), filename, content, owner=task_id,
                    )
                return str(self._save_local_file(task_id, filename, content))
        finally:
            _current_task.reset(token)

    def bind_upload_resolver(self, resolver) -> None:
        """Bind the gateway's conversation-authorized existing upload registry lookup."""
        self._upload_resolver = resolver

    async def fetch_upload(self, task_id: str, upload_id: str) -> dict:
        """Explicitly import this conversation's upload into the caller's own environment.

        The caller supplies only a registered upload identity. Registry authorization
        and source paths stay in the gateway; no target environment or URL is accepted.
        """
        if self._upload_resolver is None:
            raise ValueError("此入口不支持获取用户上传")
        record, path = self._upload_resolver(task_id, upload_id)
        conversation = self.manager.root_of(task_id)
        if (record["source"] != "user_upload" or record["conversation_id"] != conversation
                or record["id"] != upload_id or record.get("remote_environment") is not None):
            raise ValueError("只能获取当前对话已完成的用户上传")
        source_root = self.local_conversation_directory(self.workspace, conversation)
        descriptor, opened, info = open_delivery_file(source_root, path, follow_symlinks=False)
        token = _current_task.set(task_id)
        try:
            if info.st_size != record["size"]:
                raise ValueError("上传附件已被修改")
            role = self.manager.agent_name(task_id)
            directory = self.directory(task_id)
            if role in self.remote_backends:
                return await self.remote_backends[role].aimport_file(
                    descriptor, directory, upload_id, record["name"], owner=task_id,
                )
            if opened.is_relative_to(Path(directory)):
                return {"path": str(opened), "name": record["name"], "size": info.st_size}
            from wandrun.integrations.file_transfer import copy_snapshot

            return await copy_snapshot(
                descriptor, Path(directory) / "uploads" / upload_id, record["name"],
            )
        finally:
            _current_task.reset(token)
            os.close(descriptor)

    @staticmethod
    def local_conversation_directory(root: Path, conversation_id: str) -> Path:
        """Resolve a local conversation cwd before its root task has ever run."""
        if conversation_id in {"", ".", ".."} or "/" in conversation_id or "\\" in conversation_id:
            raise ValueError("无效的对话目录 ID")
        return root / "conversations" / conversation_id

    def open_local_conversation_directory(self, task_id: str, *, create: bool = False) -> tuple[Path, int]:
        """Open a safe local cwd; create it only for an operation that needs to publish files."""
        role = self.manager.agent_name(task_id)
        if not self.conversation_workdirs or role in self.remote_backends:
            raise ValueError("只支持本机对话工作目录")
        root = Path(self.environments[role][1])
        if not root.is_absolute():
            raise ValueError("无效的本机对话目录")
        directory = Path(self.directory(task_id, role))
        if create:
            self._prepare_local_directory(directory)
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        root_fd = os.open(root, flags)
        try:
            parent_fd = os.open(directory.parent.name, flags, dir_fd=root_fd)
            try:
                directory_fd = os.open(directory.name, flags, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
        finally:
            os.close(root_fd)
        try:
            self._verify_local_conversation_directory(directory, directory_fd)
        except BaseException:
            os.close(directory_fd)
            raise
        return directory, directory_fd

    def _read_local_file(self, task_id: str, path: str, *, max_bytes: int) -> bytes:
        """Read a bounded regular file in this task's conversation; never follow links."""
        directory, directory_fd = self.open_local_conversation_directory(task_id)
        os.close(directory_fd)
        if not path or "://" in path or path.startswith("data:"):
            raise ValueError("文件路径必须位于当前对话目录内，不能是 URL")
        candidate = Path(path)
        absolute = candidate if candidate.is_absolute() else directory / candidate
        descriptor, _, info = open_delivery_file(directory, str(absolute), follow_symlinks=False)
        try:
            if info.st_size > max_bytes:
                raise ValueError(f"文件不能超过 {max_bytes} 字节")
            with os.fdopen(descriptor, "rb", closefd=False) as source:
                content = source.read(max_bytes + 1)
            if len(content) > max_bytes:
                raise ValueError(f"文件不能超过 {max_bytes} 字节")
            after = os.fstat(descriptor)
            if (
                (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                or len(content) != info.st_size
            ):
                raise OSError("文件读取期间已变化")
            return content
        finally:
            os.close(descriptor)

    @staticmethod
    def _verify_local_conversation_directory(directory: Path, directory_fd: int) -> None:
        """Ensure the held directory still has its expected, non-symlinked public path."""
        root = os.stat(directory.parent.parent, follow_symlinks=False)
        parent = os.stat(directory.parent, follow_symlinks=False)
        live = os.stat(directory, follow_symlinks=False)
        held = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(root.st_mode)
            or not stat.S_ISDIR(parent.st_mode)
            or not stat.S_ISDIR(live.st_mode)
            or (live.st_dev, live.st_ino) != (held.st_dev, held.st_ino)
        ):
            raise OSError("对话工作目录已被替换")

    def _save_local_file(self, task_id: str, filename: str, content: bytes) -> Path:
        """Write privately, then exclusively publish a complete local task file with a free suffix.

        Failed writes only remove this invocation's private staging inode; public names are
        never unlinked on failure because another writer may have claimed or replaced them.
        """
        if (not filename or filename in {".", "..", ".wandrun"} or "/" in filename or "\\" in filename
                or filename.startswith(".wandrun-") and filename.endswith(".stage")):
            raise ValueError("无效的文件名")
        directory, directory_fd = self.open_local_conversation_directory(task_id, create=True)
        # The unpredictable name remains private until an exclusive hard link claims a public name.
        stage_name = f".wandrun-{uuid4().hex}.stage"
        try:
            stage_fd = os.open(
                stage_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600, dir_fd=directory_fd,
            )
            owned = os.fstat(stage_fd)
            try:
                view = memoryview(content)
                while view:
                    written = os.write(stage_fd, view)
                    if written <= 0:
                        raise OSError("文件写入未完成")
                    view = view[written:]
                os.fsync(stage_fd)
                stem, suffix = os.path.splitext(filename)
                index = 0
                while True:
                    candidate = filename if index == 0 else f"{stem} ({index}){suffix}"
                    self._verify_local_conversation_directory(directory, directory_fd)
                    staged = os.stat(stage_name, dir_fd=directory_fd, follow_symlinks=False)
                    if (staged.st_dev, staged.st_ino) != (owned.st_dev, owned.st_ino):
                        raise OSError("暂存文件已被替换")
                    if link_completed_file(
                        stage_name, candidate, src_dir_fd=directory_fd, dst_dir_fd=directory_fd,
                    ):
                        os.fsync(directory_fd)
                        self._verify_local_conversation_directory(directory, directory_fd)
                        return directory / candidate
                    index += 1
            finally:
                os.close(stage_fd)
                try:
                    staged = os.stat(stage_name, dir_fd=directory_fd, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    if (staged.st_dev, staged.st_ino) == (owned.st_dev, owned.st_ino):
                        os.unlink(stage_name, dir_fd=directory_fd)
        finally:
            os.close(directory_fd)

    def directory(self, task_id: str, agent: str | None = None) -> str:
        role = agent or self.manager.agent_name(task_id)
        _, root = self.environments[role]
        if not self.conversation_workdirs:
            return root
        conversation = self.manager.root_of(task_id)
        if role in self.remote_backends:
            if conversation in {"", ".", ".."} or "/" in conversation or "\\" in conversation:
                raise ValueError("无效的对话目录 ID")
            return posixpath.join(root, "conversations", conversation)
        return str(self.local_conversation_directory(Path(root), conversation))

    @staticmethod
    def _prepare_local_directory(directory: Path) -> None:
        if directory.parent.parent.is_symlink() or directory.parent.is_symlink() or directory.is_symlink():
            raise ValueError("对话工作目录不能是符号链接")
        directory.mkdir(parents=True, exist_ok=True)

    def _prepare_command(self, task_id: str) -> str:
        target = self.directory(task_id)
        parent = posixpath.dirname(target)
        return (
            f"test ! -L {shlex.quote(parent)} && test ! -L {shlex.quote(target)}"
            f" && mkdir -p {shlex.quote(target)}"
        )

    @staticmethod
    def _check_prepared(result) -> None:
        if result.exit_code != 0:
            raise TaskDirectoryError(f"无法准备远端对话目录，本次依赖操作未提交：{result.output}")

    def prepare_sync(self, task_id: str) -> None:
        """Prepare cwd for synchronous backend operations, using the environment's own execution path."""
        if not self.conversation_workdirs:
            return
        role = self.manager.agent_name(task_id)
        if role in self.remote_backends:
            self._check_prepared(self.remote_backends[role].execute(self._prepare_command(task_id)))
        else:
            self._prepare_local_directory(Path(self.directory(task_id)))

    async def prepare(self, task_id: str) -> None:
        """Prepare cwd immediately before real use; remote preparation remains cancellable."""
        if not self.conversation_workdirs:
            return
        role = self.manager.agent_name(task_id)
        if role in self.remote_backends:
            self._check_prepared(await self.remote_backends[role].aexecute(self._prepare_command(task_id)))
        else:
            self._prepare_local_directory(Path(self.directory(task_id)))

    async def cleanup_conversation(self, conversation_id: str) -> list[dict]:
        """Remove empty roots; report unconfirmed filesystem cleanup without blocking local deletion.

        Reports identify the environment/path, never claim removal, and are persisted by the
        gateway's deletion tombstone. Each environment is attempted; there is no background retry.
        """
        if not self.conversation_workdirs:
            return []
        if conversation_id in {"", ".", ".."} or "/" in conversation_id or "\\" in conversation_id:
            raise ValueError("无效的对话目录 ID")
        unconfirmed = []
        try:
            self._cleanup_local_conversation(conversation_id)
        except OSError as error:
            logger.warning("本地空目录清理未确认 (%s)", conversation_id, exc_info=True)
            unconfirmed.append({
                "stage": "directory", "environment": "local",
                "path": posixpath.join("conversations", conversation_id),
                "error": type(error).__name__,
            })
        script = """import errno, os, pathlib, sys
p = pathlib.Path(sys.argv[1])
try:
    parent_fd = os.open(p.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
except OSError as error:
    if error.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
        raise
else:
    try:
        try:
            os.rmdir(p.name, dir_fd=parent_fd)
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ENOTEMPTY, errno.EEXIST, errno.ENOTDIR):
                raise
    finally:
        os.close(parent_fd)
"""
        for (identity, root), backend in self._remote_cleanup.items():
            path = posixpath.join(root, "conversations", conversation_id)
            try:
                result = await backend.aexecute(remote_script('python3 -c "$1" "$2"', script, path))
                if result.exit_code != 0:
                    raise OSError(f"远端空目录清理失败 ({identity}, {path}): {result.output}")
            except OSError as error:
                logger.warning("远端空目录清理未确认 (%s, %s)", identity, path, exc_info=True)
                unconfirmed.append({
                    "stage": "directory", "environment": identity,
                    "path": posixpath.join("conversations", conversation_id),
                    "error": type(error).__name__,
                })
        return unconfirmed

    def _cleanup_local_conversation(self, conversation_id: str) -> None:
        parent = self.workspace / "conversations"
        try:
            parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                raise
        else:
            try:
                try:
                    os.rmdir(conversation_id, dir_fd=parent_fd)
                except OSError as error:
                    if error.errno not in (errno.ENOENT, errno.ENOTEMPTY, errno.EEXIST, errno.ENOTDIR):
                        raise
            finally:
                os.close(parent_fd)

    def resolve_delivery(self, path: str) -> ResolvedAttachment:
        """Validate an original workspace file for registration without retaining its fd."""
        descriptor, opened, info = open_delivery_file(self.workspace, path)
        os.close(descriptor)
        name = Path(path).name
        return ResolvedAttachment(
            path=str(opened), name=name, size=info.st_size,
            media_type=mimetypes.guess_type(name)[0] or "application/octet-stream",
        )

    def resolve_attachments(self, sender_id: str, target: str, paths: list[str]) -> tuple[list[ResolvedAttachment], list[dict]]:
        sender = self.manager.agent_name(sender_id)
        same_local = sender not in self.remote_backends and (
            target == "human" or target in self.environments and target not in self.remote_backends
        )
        accepted: list[ResolvedAttachment] = []
        receipts: list[dict] = []
        for path in paths:
            receipt = {"path": path}
            try:
                if not same_local:
                    raise ValueError("跨环境或远端附件须先在异步投递边界完成交付")
                candidate = Path(path)
                absolute = candidate if candidate.is_absolute() else Path(self.directory(sender_id)) / candidate
                file = replace(self.resolve_delivery(str(absolute)), requested_path=path)
                accepted.append(file)
                receipt["accepted"] = True
                receipt["name"] = file.name
            except (OSError, ValueError, RuntimeError) as error:
                receipt.update(accepted=False, error=str(error))
            receipts.append(receipt)
        return accepted, receipts

    async def prepare_attachments(
        self, sender_id: str, target: str, paths: list[str], target_task_id: str | None = None,
    ) -> PreparedAttachments:
        """Deliver to the trusted recipient's environment; receipts always retain source spelling.

        WorkerManager validates the recipient before calling this boundary. Existing
        recipients use their own root; a new member inherits only the sender's root
        identity, interpreted in its own environment. Cross-machine files stream
        through a private gateway snapshot, never through a model response.
        """
        sender = self.manager.agent_name(sender_id)
        _, root = self.environments[sender]
        backend = self.remote_backends.get(sender)
        destination_backend = self.remote_backends.get(target)
        same_environment = target != "human" and (
            backend is destination_backend if backend is not None else destination_backend is None
        )
        if target == "human" and backend is None:
            attachments, receipts = self.resolve_attachments(sender_id, target, paths)
            return PreparedAttachments(attachments, receipts, self._attachment_binding_check(sender_id, target, target_task_id))
        if target != "human" and target not in self.environments:
            raise ValueError(f"未知 Agent: {target}")
        destination_directory = (
            self.directory(target_task_id or sender_id, target) if target != "human" else None
        )
        binding_check = self._attachment_binding_check(sender_id, target, target_task_id)
        accepted: list[ResolvedAttachment] = []
        receipts: list[dict] = []
        roles = (sender,) if target == "human" else (sender, target)
        token = _current_task.set(sender_id)
        try:
            with self._file_operation(sender_id, *roles):
                for path in paths:
                    receipt = {"path": path}
                    try:
                        requested = path if path.startswith("/") else posixpath.join(self.directory(sender_id), path)
                        if same_environment:
                            if backend is None:
                                descriptor, opened, info = open_delivery_file(Path(root), requested)
                                os.close(descriptor)
                                attachment = ResolvedAttachment(
                                    str(opened), Path(path).name, info.st_size,
                                    mimetypes.guess_type(path)[0] or "application/octet-stream",
                                    requested_path=path,
                                )
                            else:
                                result = await backend.aexecute(remote_script(
                                    'python3 -c "$1" "$2" "$3"', _REMOTE_ATTACHMENT, requested, root,
                                ))
                                if result.exit_code != 0:
                                    raise ValueError(f"远端文件不可交付：{result.output}")
                                attachment = replace(
                                    ResolvedAttachment(**json.loads(result.output.strip())),
                                    requested_path=path, remote_environment=self.environments[target][0],
                                )
                        elif target == "human":
                            destination = self.local_conversation_directory(
                                self.workspace, self.manager.root_of(sender_id),
                            ) / "deliveries"
                            snapshot = await backend.aretrieve_attachment(
                                requested, root, destination, owner=sender_id,
                            )
                            descriptor, _, info = open_delivery_file(
                                self.workspace, snapshot["path"], follow_symlinks=False,
                            )
                            os.close(descriptor)
                            if info.st_size != snapshot["size"]:
                                raise ValueError("交付副本已被修改")
                            attachment = ResolvedAttachment(
                                **snapshot, requested_path=path,
                                media_type=mimetypes.guess_type(snapshot["name"])[0] or "application/octet-stream",
                            )
                        else:
                            attachment = await self._copy_attachment(
                                sender_id, path, requested, root, backend, target,
                                destination_backend, destination_directory,
                            )
                        accepted.append(attachment)
                        receipt.update(accepted=True, name=attachment.name)
                    except Exception as error:
                        receipt.update(accepted=False, error=str(error))
                    receipts.append(receipt)
        finally:
            _current_task.reset(token)
        return PreparedAttachments(accepted, receipts, binding_check)

    async def _copy_attachment(
        self, owner: str, requested_path: str, requested: str, root: str, source_backend,
        target: str, destination_backend, directory: str,
    ) -> ResolvedAttachment:
        from wandrun.integrations.file_transfer import copy_snapshot

        # A private relay is deleted on every exit; only the receiver's complete,
        # exclusively published inode survives. Source files are never removed.
        with TemporaryDirectory(prefix="wandrun-delivery-") as temporary:
            source_root = Path(root)
            source_path = requested
            if source_backend is not None:
                source_root = Path(temporary)
                snapshot = await source_backend.aretrieve_attachment(
                    requested, root, source_root / "source", owner=owner,
                )
                source_path = snapshot["path"]
            descriptor, _, info = open_delivery_file(source_root, source_path, follow_symlinks=False)
            try:
                identity = "f_" + uuid4().hex
                name = posixpath.basename(requested)
                if destination_backend is None:
                    result = await copy_snapshot(
                        descriptor, Path(directory) / "attachments" / identity, name,
                    )
                else:
                    result = await destination_backend.aimport_file(
                        descriptor, directory, identity, name, owner=owner,
                    )
                actual = result["path"]
                if (not isinstance(actual, str) or not actual.startswith(directory.rstrip("/") + "/")
                        or ".." in Path(actual).parts or result["name"] != name
                        or result["size"] != info.st_size):
                    raise ValueError("接收环境未确认有效的附件落点")
                return ResolvedAttachment(
                    actual, name, info.st_size,
                    mimetypes.guess_type(name)[0] or "application/octet-stream",
                    requested_path=requested_path,
                    remote_environment=self.environments[target][0] if destination_backend is not None else None,
                )
            finally:
                os.close(descriptor)

    def _attachment_binding_check(self, sender_id: str, target: str, target_task_id: str | None):
        sender = self.manager.agent_name(sender_id)
        roles = (sender,) if target == "human" else (sender, target)
        bindings = {role: (self.environments[role], self.remote_backends.get(role)) for role in roles}
        source_root = self.manager.root_of(sender_id)
        recipient_root = self.manager.root_of(target_task_id or sender_id)

        def validate() -> None:
            if (self.manager.root_of(sender_id) != source_root
                    or self.manager.root_of(target_task_id or sender_id) != recipient_root
                    or any(
                        self.environments.get(role) != binding
                        or self.remote_backends.get(role) is not backend
                        for role, (binding, backend) in bindings.items()
                    )):
                raise ValueError("附件预检后执行环境或接收对话已变化，请重新交付")

        return validate


class TaskBackend(SandboxBackendProtocol):
    """Prepare task cwd on use and translate paths without mutating the shared backend.

    Async execution returns browser setup rejections as ExecuteResponse without
    submitting the command; cancellation and unexpected faults still propagate.
    """

    def __init__(
        self, backend, files: TaskFiles, *,
        task_id: str | None = None, browser=None,
    ):
        self.backend = backend
        self.files = files
        self.task_id = task_id
        self.browser = browser

    @property
    def id(self):
        return self.backend.id

    def for_code_call(self):
        task = self.task_id or _current_task.get()
        backend = self.backend.for_code_call() if hasattr(self.backend, "for_code_call") else self.backend
        return TaskBackend(backend, self.files, task_id=task, browser=self.browser)

    def _task(self) -> str:
        task = self.task_id or _current_task.get()
        if task is None:
            raise RuntimeError("文件操作缺少任务上下文")
        return task

    def _cwd(self) -> str:
        return self.files.directory(self._task())

    def _uses_cwd(self, path: str | None) -> bool:
        if path is None or not path.startswith("/"):
            return True
        if self.task_id is None and _current_task.get() is None:
            return False
        # Middleware may already have expanded a relative tool argument. Recognize
        # that absolute spelling too, but leave unrelated absolute reads alone.
        # Linux treats exactly two leading separators like one; normpath alone
        # deliberately preserves them and would miss this cwd's layout checks.
        cwd = "/" + posixpath.normpath(self._cwd()).lstrip("/")
        absolute = "/" + posixpath.normpath(path).lstrip("/")
        return absolute == cwd or absolute.startswith(cwd.rstrip("/") + "/")

    def _resolve_path(self, path: str | None) -> str:
        return path if path is not None and path.startswith("/") else posixpath.join(self._cwd(), path or ".")

    def _path(self, path: str | None) -> str:
        if self._uses_cwd(path):
            self.files.prepare_sync(self._task())
        return self._resolve_path(path)

    async def _apath(self, path: str | None) -> str:
        if self._uses_cwd(path):
            await self.files.prepare(self._task())
        return self._resolve_path(path)

    def _command(self, command: str) -> str:
        if not command or not isinstance(command, str):
            return command
        return f"cd {shlex.quote(self._cwd())} || exit\n{command}"

    def read(self, file_path, offset=0, limit=2000):
        return self.backend.read(self._path(file_path), offset, limit)

    async def aread(self, file_path, offset=0, limit=2000):
        return await self.backend.aread(await self._apath(file_path), offset, limit)

    def write(self, file_path, content):
        return self.backend.write(self._path(file_path), content)

    async def awrite(self, file_path, content):
        return await self.backend.awrite(await self._apath(file_path), content)

    def edit(self, file_path, old_string, new_string, replace_all=False):
        return self.backend.edit(self._path(file_path), old_string, new_string, replace_all)

    async def aedit(self, file_path, old_string, new_string, replace_all=False):
        return await self.backend.aedit(await self._apath(file_path), old_string, new_string, replace_all)

    def delete(self, file_path):
        return self.backend.delete(self._path(file_path))

    async def adelete(self, file_path):
        return await self.backend.adelete(await self._apath(file_path))

    def ls(self, path):
        return self.backend.ls(self._path(path))

    async def als(self, path):
        return await self.backend.als(await self._apath(path))

    def glob(self, pattern, path=None):
        return self.backend.glob(pattern, self._path(path))

    async def aglob(self, pattern, path=None):
        scope = _current_glob_call.get()
        if scope is not None:
            if scope.closed:
                raise asyncio.CancelledError
            scope.tasks.add(asyncio.current_task())
        return await self.backend.aglob(pattern, await self._apath(path))

    def grep(self, pattern, path=None, glob=None, *, max_count=None):
        return self.backend.grep(pattern, self._path(path), glob, max_count=max_count)

    async def agrep(self, pattern, path=None, glob=None, *, max_count=None):
        return await self.backend.agrep(pattern, await self._apath(path), glob, max_count=max_count)

    def execute(self, command, *, timeout=None):
        if command and isinstance(command, str):
            self.files.prepare_sync(self._task())
        return self.backend.execute(self._command(command), timeout=timeout)

    async def aexecute(self, command, *, timeout=None):
        try:
            env = await self.browser.command_environment(self.task_id or _current_task.get()) if self.browser else None
        except BrowserRejected as error:
            return ExecuteResponse(
                output=f"浏览器命令被拒绝：{error} 本次命令未提交。",
                exit_code=None, truncated=False,
            )
        if command and isinstance(command, str):
            await self.files.prepare(self._task())
        if env is None:
            return await self.backend.aexecute(self._command(command), timeout=timeout)
        return await self.backend.aexecute(self._command(command), timeout=timeout, env=env)

    def upload_files(self, files):
        return self.backend.upload_files([(self._path(path), content) for path, content in files])

    async def aupload_files(self, files):
        return await self.backend.aupload_files([(await self._apath(path), content) for path, content in files])

    def download_files(self, paths):
        return self.backend.download_files([self._path(path) for path in paths])

    async def adownload_files(self, paths):
        return await self.backend.adownload_files([await self._apath(path) for path in paths])
