"""Task-relative filesystem views, original-file delivery, and safe local publication."""

from __future__ import annotations

import errno
import json
import mimetypes
import os
import posixpath
import shlex
import stat
from contextvars import ContextVar
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable
from uuid import uuid4

from deepagents.backends.protocol import SandboxBackendProtocol
from langchain.agents.middleware import AgentMiddleware
from wandrun.integrations.ssh_backend import remote_script


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
    # None means a host-local path; SSH identity is captured at preflight, not inferred at download.
    remote_environment: str | None = None

def open_delivery_file(root: Path, path: str) -> tuple[int, Path, os.stat_result]:
    """Open a live regular workspace file, excluding lexical and canonical control paths.

    The caller owns the returned fd. Every failure closes it here; a later reader
    must use the fd, not reopen the path returned alongside it.
    """
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ValueError("交付文件必须是绝对本机路径")
    try:
        lexical = candidate.relative_to(root).parts
    except ValueError:
        lexical = candidate.parts
    if ".wandrun" in lexical:
        raise ValueError("不能交付 workspace 控制文件")
    descriptor = os.open(candidate, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
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


class TaskPathMiddleware(AgentMiddleware):
    """Give Deep Agents absolute task paths before its virtual-path normalizer runs."""

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
        return await handler(request)




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

    def update_environments(
        self, environments: dict[str, tuple[str, str]], remote_backends: dict[str, object],
    ) -> None:
        self.environments = environments
        self.remote_backends = remote_backends
        self._remote_cleanup.update({
            (identity, root): remote_backends[role]
            for role, (identity, root) in environments.items() if role in remote_backends
        })

    @staticmethod
    def local_conversation_directory(root: Path, conversation_id: str) -> Path:
        """Resolve a local conversation cwd before its root task has ever run."""
        if conversation_id in {"", ".", ".."} or "/" in conversation_id or "\\" in conversation_id:
            raise ValueError("无效的对话目录 ID")
        return root / "conversations" / conversation_id

    def open_local_conversation_directory(self, task_id: str) -> tuple[Path, int]:
        """Open a prepared local task directory without following links in its configured layout."""
        role = self.manager.agent_name(task_id)
        if not self.conversation_workdirs or role in self.remote_backends:
            raise ValueError("只支持本机对话工作目录")
        root = Path(self.environments[role][1])
        if not root.is_absolute():
            raise ValueError("无效的本机对话目录")
        directory = Path(self.directory(task_id, role))
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

    def save_local_file(self, task_id: str, filename: str, content: bytes) -> Path:
        """Write privately, then exclusively publish a complete local task file with a free suffix.

        Failed writes only remove this invocation's private staging inode; public names are
        never unlinked on failure because another writer may have claimed or replaced them.
        """
        if not filename or filename in {".", ".."} or "/" in filename or "\\" in filename:
            raise ValueError("无效的文件名")
        directory, directory_fd = self.open_local_conversation_directory(task_id)
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

    async def prepare(self, task_id: str) -> None:
        """Create this task's conversation cwd in its current role environment."""
        if not self.conversation_workdirs:
            return
        role = self.manager.agent_name(task_id)
        target = self.directory(task_id, role)
        if role in self.remote_backends:
            parent = posixpath.dirname(target)
            result = await self.remote_backends[role].aexecute(
                f"test ! -L {shlex.quote(parent)} && test ! -L {shlex.quote(target)}"
                f" && mkdir -p {shlex.quote(target)}"
            )
            if result.exit_code != 0:
                raise RuntimeError(f"无法准备远端对话目录：{result.output}")
        else:
            directory = Path(target)
            if directory.parent.is_symlink() or directory.is_symlink():
                raise ValueError("对话工作目录不能是符号链接")
            directory.mkdir(parents=True, exist_ok=True)

    async def cleanup_conversation(self, conversation_id: str) -> None:
        """Remove only empty task roots, locally and on opened SSH environments."""
        if not self.conversation_workdirs:
            return
        if conversation_id in {"", ".", ".."} or "/" in conversation_id or "\\" in conversation_id:
            raise ValueError("无效的对话目录 ID")
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
            result = await backend.aexecute(remote_script('python3 -c "$1" "$2"', script, path))
            if result.exit_code != 0:
                raise OSError(f"远端空目录清理失败 ({identity}, {path}): {result.output}")

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
        sender_env, _ = self.environments[sender]
        target_env = None if target == "human" else self.environments.get(target, (None, ""))[0]
        accepted: list[ResolvedAttachment] = []
        receipts: list[dict] = []
        for path in paths:
            receipt = {"path": path}
            try:
                if target == "human":
                    if sender in self.remote_backends:
                        raise ValueError("SSH 到本机 human 的附件跨环境，不支持复制")
                elif sender_env != target_env:
                    raise ValueError("跨执行环境不能通过附件路径共享文件；不复制远端文件")
                if sender in self.remote_backends:
                    raise ValueError("远端文件须先在异步模型边界预检；直接投递不接受未校验附件")
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
        self, sender_id: str, target: str, paths: list[str],
    ) -> tuple[list[ResolvedAttachment], list[dict]] | None:
        """Preflight remote files; None means local files need dispatch-time validation."""
        sender = self.manager.agent_name(sender_id)
        identity, root = self.environments[sender]
        if sender not in self.remote_backends:
            return None
        if identity != self.environments.get(target, (None, ""))[0]:
            return self.resolve_attachments(sender_id, target, paths)
        backend = self.remote_backends[sender]
        accepted: list[ResolvedAttachment] = []
        receipts: list[dict] = []
        # Remote host Python already runs the session service. Emit one JSON object so
        # filenames containing newlines/quotes do not corrupt the result protocol.
        script = _REMOTE_ATTACHMENT
        for path in paths:
            receipt = {"path": path}
            try:
                requested = path if path.startswith("/") else posixpath.join(self.directory(sender_id), path)
                result = await backend.aexecute(remote_script(
                    "python3 -c \"$1\" \"$2\" \"$3\"", script, requested, root,
                ))
                if result.exit_code != 0:
                    raise ValueError(f"远端文件不可交付：{result.output}")
                attachment = replace(
                    ResolvedAttachment(**json.loads(result.output.strip())),
                    requested_path=path, remote_environment=identity,
                )
                accepted.append(attachment)
                receipt.update(accepted=True, name=attachment.name)
            except (ValueError, OSError, RuntimeError, TypeError, KeyError) as error:
                receipt.update(accepted=False, error=str(error))
            receipts.append(receipt)
        return accepted, receipts


class TaskBackend(SandboxBackendProtocol):
    """Translate task-relative paths and supply its browser endpoint to local Code Mode commands."""

    def __init__(
        self, backend, directory: Callable[[str], str], *,
        task_id: str | None = None, browser=None,
    ):
        self.backend = backend
        self.directory = directory
        self.task_id = task_id
        self.browser = browser

    @property
    def id(self):
        return self.backend.id

    def for_code_call(self):
        task = self.task_id or _current_task.get()
        backend = self.backend.for_code_call() if hasattr(self.backend, "for_code_call") else self.backend
        return TaskBackend(backend, self.directory, task_id=task, browser=self.browser)

    def _cwd(self) -> str:
        task = self.task_id or _current_task.get()
        if task is None:
            raise RuntimeError("文件操作缺少任务上下文")
        return self.directory(task)

    def _path(self, path: str | None) -> str:
        # Deep Agents' glob treats '/' as its default search root; use this
        # task's directory for an omitted base, preserving explicit absolute paths.
        return path if path is not None and path.startswith("/") else posixpath.join(self._cwd(), path or ".")

    def _command(self, command: str) -> str:
        if not command or not isinstance(command, str):
            return command
        return f"cd {shlex.quote(self._cwd())} || exit\n{command}"

    def read(self, file_path, offset=0, limit=2000):
        return self.backend.read(self._path(file_path), offset, limit)

    async def aread(self, file_path, offset=0, limit=2000):
        return await self.backend.aread(self._path(file_path), offset, limit)

    def write(self, file_path, content):
        return self.backend.write(self._path(file_path), content)

    async def awrite(self, file_path, content):
        return await self.backend.awrite(self._path(file_path), content)

    def edit(self, file_path, old_string, new_string, replace_all=False):
        return self.backend.edit(self._path(file_path), old_string, new_string, replace_all)

    async def aedit(self, file_path, old_string, new_string, replace_all=False):
        return await self.backend.aedit(self._path(file_path), old_string, new_string, replace_all)

    def delete(self, file_path):
        return self.backend.delete(self._path(file_path))

    async def adelete(self, file_path):
        return await self.backend.adelete(self._path(file_path))

    def ls(self, path):
        return self.backend.ls(self._path(path))

    async def als(self, path):
        return await self.backend.als(self._path(path))

    def glob(self, pattern, path=None):
        return self.backend.glob(pattern, self._path(path))

    async def aglob(self, pattern, path=None):
        return await self.backend.aglob(pattern, self._path(path))

    def grep(self, pattern, path=None, glob=None, *, max_count=None):
        return self.backend.grep(pattern, self._path(path), glob, max_count=max_count)

    async def agrep(self, pattern, path=None, glob=None, *, max_count=None):
        return await self.backend.agrep(pattern, self._path(path), glob, max_count=max_count)

    def execute(self, command, *, timeout=None):
        return self.backend.execute(self._command(command), timeout=timeout)

    async def aexecute(self, command, *, timeout=None):
        env = await self.browser.command_environment(self.task_id or _current_task.get()) if self.browser else None
        if env is None:
            return await self.backend.aexecute(self._command(command), timeout=timeout)
        return await self.backend.aexecute(self._command(command), timeout=timeout, env=env)

    def upload_files(self, files):
        return self.backend.upload_files([(self._path(path), content) for path, content in files])

    async def aupload_files(self, files):
        return await self.backend.aupload_files([(self._path(path), content) for path, content in files])

    def download_files(self, paths):
        return self.backend.download_files([self._path(path) for path in paths])

    async def adownload_files(self, paths):
        return await self.backend.adownload_files([self._path(path) for path in paths])
