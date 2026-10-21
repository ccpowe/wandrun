"""宿主上的小型 Agent 记忆：内容版本、局部编辑和受管保存共享一个边界。"""

from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import stat
import tempfile
from threading import RLock

from wandrun.config import _agent_id

MEMORY_LIMIT = 1000


class InvalidMemory(ValueError):
    """提交的正文或编辑目标无效；没有改变文件。"""


class MemoryReadError(RuntimeError):
    """已有记忆损坏或超限；不能当成空记忆继续请求模型。"""


class MemoryRetired(ValueError):
    """Agent 已进入删除流程，禁止新的记忆访问。"""


@dataclass(frozen=True)
class MemorySnapshot:
    content: str
    version: str
    updated_at: float | None


class MemoryConflict(ValueError):
    def __init__(self, current: MemorySnapshot):
        super().__init__("记忆已更新，请读取最新内容后重新决定修改")
        self.current = current


@dataclass(frozen=True)
class MemoryChange:
    agent_id: str
    snapshot: MemorySnapshot
    # None 表示用户保存；外部文件编辑不产生此回调。
    task_id: str | None


def _normalize(content: str) -> str:
    if not isinstance(content, str):
        raise InvalidMemory("记忆正文必须是字符串")
    return content.replace("\r\n", "\n").replace("\r", "\n")


def _body(content: str) -> tuple[str, bytes]:
    content = _normalize(content)
    if len(content) > MEMORY_LIMIT:
        raise InvalidMemory(f"记忆正文为 {len(content)} 字符，最多 {MEMORY_LIMIT} 字符")
    try:
        encoded = content.encode("utf-8")
    except UnicodeEncodeError as error:
        raise InvalidMemory("记忆正文必须是有效的 Unicode 文本") from error
    return content, encoded


def _version(encoded: bytes) -> str:
    return hashlib.sha256(encoded).hexdigest()


class MemoryStore:
    """一个运行时持有一份，所有 Agent 的受管读写在进程内串行。

    回调在改变文件后同步执行，调用方须在事件循环线程使用，以便网关同步持久化事件。
    回调失败会传播，此时正文可能已经保存；不能把它报告为未执行或自动重试。
    本锁和原子替换不保护绕过本实例的 shell、外部编辑器或另一进程的并发写入。
    """

    def __init__(
        self, root: Path, *, on_change: Callable[[MemoryChange], None] | None = None,
    ):
        self.root = Path(root).resolve()
        self.on_change = on_change
        self._lock = RLock()
        self._retired: set[str] = set()

    def _path(self, agent_id: str) -> Path:
        try:
            _agent_id(agent_id, "记忆 Agent id")
        except ValueError as error:
            raise InvalidMemory(str(error)) from error
        return self.root / f"{agent_id}.md"

    def _active_path(self, agent_id: str) -> Path:
        path = self._path(agent_id)
        if agent_id in self._retired:
            raise MemoryRetired(f"Agent 已删除或正在删除: {agent_id}")
        return path

    def _read(self, path: Path) -> MemorySnapshot:
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return MemorySnapshot("", _version(b""), None)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise MemoryReadError("记忆路径必须是普通文件")
            # 每个有效 Unicode 码点最多四字节；CRLF 规范化不会超过这个上界。
            encoded = stream.read(MEMORY_LIMIT * 4 + 1)
        if len(encoded) > MEMORY_LIMIT * 4:
            raise MemoryReadError(f"已有记忆超过 {MEMORY_LIMIT} 字符上限")
        try:
            content, normalized = _body(encoded.decode("utf-8"))
        except (UnicodeDecodeError, InvalidMemory) as error:
            raise MemoryReadError(f"无法读取有效记忆: {error}") from error
        return MemorySnapshot(content, _version(normalized), info.st_mtime)

    def read(self, agent_id: str) -> MemorySnapshot:
        with self._lock:
            return self._read(self._active_path(agent_id))

    def save(
        self, agent_id: str, content: str, expected_version: str, *, task_id: str | None = None,
    ) -> MemorySnapshot:
        with self._lock:
            path = self._active_path(agent_id)
            current = self._read(path)
            if current.version != expected_version:
                raise MemoryConflict(current)
            return self._save(agent_id, path, current, content, task_id)

    def edit(
        self, agent_id: str, old_string: str, new_string: str, expected_version: str,
        *, replace_all: bool = False, task_id: str | None = None,
    ) -> MemorySnapshot:
        """对期望版本作精确替换；空目标不是追加协议，初始正文通过普通 write 保存。"""
        with self._lock:
            path = self._active_path(agent_id)
            current = self._read(path)
            if current.version != expected_version:
                raise MemoryConflict(current)
            old_string, new_string = _normalize(old_string), _normalize(new_string)
            if not old_string:
                raise InvalidMemory("编辑目标不能为空；空记忆请使用普通 write_file 写入")
            count = current.content.count(old_string)
            if not count:
                raise InvalidMemory("记忆中未找到编辑目标；请依据最新快照重新选择")
            if count > 1 and not replace_all:
                raise InvalidMemory("记忆中有多个匹配，请提供唯一目标或显式使用 replace_all")
            content = current.content.replace(old_string, new_string, -1 if replace_all else 1)
            return self._save(agent_id, path, current, content, task_id)

    def _save(
        self, agent_id: str, path: Path, current: MemorySnapshot,
        content: str, task_id: str | None,
    ) -> MemorySnapshot:
        content, encoded = _body(content)
        if content == current.content:
            return current
        self.root.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=f".{agent_id}.", dir=self.root)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
                modified = os.fstat(stream.fileno()).st_mtime
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
        snapshot = MemorySnapshot(content, _version(encoded), modified)
        if self.on_change is not None:
            self.on_change(MemoryChange(agent_id, snapshot, task_id))
        return snapshot

    def retire(self, agent_id: str) -> None:
        with self._lock:
            self._path(agent_id)
            self._retired.add(agent_id)

    def delete(self, agent_id: str) -> None:
        """删除意图之后的可重试清理；即使 unlink 失败，也不重新开放写入。"""
        with self._lock:
            path = self._path(agent_id)
            self._retired.add(agent_id)
            path.unlink(missing_ok=True)
