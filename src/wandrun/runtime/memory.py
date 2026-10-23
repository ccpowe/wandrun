"""宿主记忆的唯一发布边界：归属、CAS、不可变详情及撤销清理。"""

from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
from threading import RLock
from uuid import uuid4
from urllib.parse import urlsplit

from markdown_it import MarkdownIt

from wandrun.config import _agent_id

MEMORY_LIMIT = 1000
MEMORY_DETAIL_LIMIT = 64 * 1024
_SLUG = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_REFERENCE = re.compile(
    r"/\.wandrun/memory/(profile|work)/details/([A-Za-z0-9][A-Za-z0-9_-]{0,63})/([0-9a-f]{64})\.md"
)
_REFERENCE_TOKEN = re.compile(r"/\.wandrun/memory/[^\s<>\[\]()`\"']+")
_MARKDOWN = MarkdownIt("commonmark")


class InvalidMemory(ValueError):
    """输入、引用或操作无效；调用方应重新读取后判断。"""


class MemoryReadError(RuntimeError):
    """已有发布内容损坏，不能当成空记忆。"""


class MemoryRetired(ValueError):
    """Agent 删除意图已封锁工作记忆。"""


class MemoryCleanupError(RuntimeError):
    """活动内容已发布或撤销，但受管文件清理未完成。"""


@dataclass(frozen=True)
class MemorySnapshot:
    content: str
    version: str
    updated_at: float | None
    scope: str
    agent_id: str | None
    details: dict[str, dict[str, str]]
    revision: int


@dataclass(frozen=True)
class MemoryDetailSnapshot:
    content: str
    sha256: str
    path: str
    version: str
    scope: str
    agent_id: str | None
    slug: str


class MemoryConflict(ValueError):
    def __init__(self, current: MemorySnapshot):
        super().__init__("记忆已更新，请读取最新内容后重新决定修改")
        self.current = current


@dataclass(frozen=True)
class MemoryChange:
    agent_id: str | None
    snapshot: MemorySnapshot
    task_id: str | None


def _normalize(content: str) -> str:
    if not isinstance(content, str):
        raise InvalidMemory("记忆正文必须是字符串")
    return content.replace("\r\n", "\n").replace("\r", "\n")


def _body(content: str, *, detail: bool = False) -> tuple[str, bytes]:
    content = _normalize(content)
    try:
        encoded = content.encode("utf-8")
    except UnicodeEncodeError as error:
        raise InvalidMemory("记忆正文必须是有效的 Unicode 文本") from error
    if detail:
        if len(encoded) > MEMORY_DETAIL_LIMIT:
            raise InvalidMemory(f"详情最多 {MEMORY_DETAIL_LIMIT} UTF-8 字节")
    elif len(content) > MEMORY_LIMIT:
        raise InvalidMemory(f"记忆正文为 {len(content)} 字符，最多 {MEMORY_LIMIT} 字符")
    return content, encoded


def _digest(encoded: bytes) -> str:
    return hashlib.sha256(encoded).hexdigest()


def _json(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _scope(agent_id: str | None) -> str:
    return "profile" if agent_id is None else "work"


def _slug(slug: str) -> None:
    if not isinstance(slug, str) or not _SLUG.fullmatch(slug):
        raise InvalidMemory("详情标识须为 1–64 个 ASCII 字母、数字、下划线或连字符，以字母或数字开头")


def _reference(agent_id: str | None, slug: str, fingerprint: str) -> str:
    return f"/.wandrun/memory/{_scope(agent_id)}/details/{slug}/{fingerprint}.md"


class MemoryStore:
    """运行时持有；进程内串行发布，current.json 是唯一活动真相。

    agent_id=None 指共享画像，否则指该 Agent 工作记忆。authorize 在锁内每次提交前
    调用；任务身份/代际由宿主回调验证，不从文件路径或文本推断。owner 绑定受管准备
    操作及其已观察版本。回调失败可能发生在文件已发布后，不能自动重试。
    不提供跨进程锁，也不是宿主 shell 沙箱。
    """

    def __init__(self, root: Path, *, on_change: Callable[[MemoryChange], None] | None = None):
        self.root = Path(root).resolve()
        self.on_change = on_change
        self._lock = RLock()
        self._retired: set[str] = set()
        # (document, owner, path) -> complete observed document version.
        self._prepared: dict[tuple[str | None, str, str], str] = {}
        self._pending_cleanup: dict[str, set[str | None]] = {}
        self._dirty_documents: set[str | None] = set()
        self._recover()

    def _directory(self, agent_id: str | None, *, retired: bool = False) -> Path:
        if agent_id is None:
            directory = self.root / "profile"
        else:
            try:
                _agent_id(agent_id, "记忆 Agent id")
            except ValueError as error:
                raise InvalidMemory(str(error)) from error
            if not retired and agent_id in self._retired:
                raise MemoryRetired(f"Agent 已删除或正在删除: {agent_id}")
            directory = self.root / "agents" / agent_id
        self._directories(directory)
        return directory

    def _directories(self, directory: Path, *, create: bool = False) -> None:
        """拒绝任何受管目录链接；不能让 O_NOFOLLOW 只保护最后一个文件名。"""
        path = self.root
        self._directory_entry(path, create)
        for part in directory.relative_to(self.root).parts:
            path /= part
            self._directory_entry(path, create)

    @staticmethod
    def _directory_entry(path: Path, create: bool) -> None:
        try:
            info = path.lstat()
        except FileNotFoundError:
            if create:
                path.mkdir(parents=True, exist_ok=True)
                info = path.lstat()
            else:
                return
        if not stat.S_ISDIR(info.st_mode):
            raise MemoryReadError(f"记忆目录必须是真实目录: {path}")

    @staticmethod
    def _read_bytes(path: Path, maximum: int) -> tuple[bytes, float]:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise MemoryReadError("记忆路径必须是普通文件")
            encoded = stream.read(maximum + 1)
        if len(encoded) > maximum:
            raise MemoryReadError("已有记忆超出大小上限")
        return encoded, info.st_mtime

    def _references(self, agent_id: str | None, content: str) -> dict[str, dict[str, str]]:
        # Markdown references may point only to managed details, not arbitrary host
        # files. External evidence URLs and same-document anchors are not details.
        raw_references = _REFERENCE_TOKEN.findall(content)
        for block in _MARKDOWN.parse(content):
            for token in block.children or []:
                destination = token.attrGet("href") or token.attrGet("src")
                if destination and not destination.startswith("#"):
                    if urlsplit(destination).scheme not in {"http", "https"} and not _REFERENCE.fullmatch(destination):
                        raise InvalidMemory("索引的文件链接只能引用本归属的受管详情")
                    if _REFERENCE.fullmatch(destination) and destination not in raw_references:
                        raise InvalidMemory("索引含非法或越界的记忆详情引用")
        details = {}
        for token in raw_references:
            match = _REFERENCE.fullmatch(token)
            if match is None or match[1] != _scope(agent_id):
                raise InvalidMemory("索引含非法或越界的记忆详情引用")
            slug, fingerprint = match[2], match[3]
            reference = {"path": token, "sha256": fingerprint}
            if slug in details and details[slug] != reference:
                raise InvalidMemory("同一详情不能同时引用多个版本")
            details[slug] = reference
        return details

    def _detail_file(self, directory: Path, slug: str, fingerprint: str) -> Path:
        _slug(slug)
        if not isinstance(fingerprint, str) or not _HASH.fullmatch(fingerprint):
            raise InvalidMemory("详情内容指纹无效")
        parent = directory / "details" / slug
        self._directories(parent)
        return parent / f"{fingerprint}.md"

    def _detail_content(self, directory: Path, slug: str, fingerprint: str) -> str:
        raw, _ = self._read_bytes(self._detail_file(directory, slug, fingerprint), MEMORY_DETAIL_LIMIT)
        try:
            content, encoded = _body(raw.decode("utf-8"), detail=True)
        except (UnicodeDecodeError, InvalidMemory) as error:
            raise MemoryReadError(f"详情内容无效: {error}") from error
        if raw != encoded or _digest(encoded) != fingerprint:
            raise MemoryReadError("详情内容与指纹不一致")
        return content

    def _read(self, agent_id: str | None, directory: Path) -> MemorySnapshot:
        try:
            raw, modified = self._read_bytes(directory / "current.json", 32 * 1024)
        except FileNotFoundError:
            content, details, revision, modified = "", {}, 0, None
        else:
            try:
                value = json.loads(raw.decode("utf-8"))
                if not isinstance(value, dict) or set(value) != {"content", "details", "revision"}:
                    raise InvalidMemory("活动清单字段无效")
                content, _ = _body(value["content"])
                revision = value["revision"]
                if type(revision) is not int or revision < 1:
                    raise InvalidMemory("活动清单 revision 无效")
                details = self._references(agent_id, content)
                if value["details"] != details:
                    raise InvalidMemory("正文与活动详情清单不一致")
                for slug, reference in details.items():
                    self._detail_content(directory, slug, reference["sha256"])
            except (ValueError, TypeError, KeyError, FileNotFoundError) as error:
                raise MemoryReadError(f"无法读取有效记忆: {error}") from error
        version = _digest(_json({"content": content, "details": details, "revision": revision}))
        return MemorySnapshot(content, version, modified, _scope(agent_id), agent_id, details, revision)

    def read(self, agent_id: str | None) -> MemorySnapshot:
        with self._lock:
            return self._read(agent_id, self._directory(agent_id))

    def _check(self, agent_id, directory, expected_version, owner, authorize) -> MemorySnapshot:
        if authorize is not None:
            authorize()
        current = self._read(agent_id, directory)
        if current.version != expected_version:
            if owner is not None:
                self.discard_prepared(owner)
            raise MemoryConflict(current)
        return current

    @staticmethod
    def _atomic(path: Path, encoded: bytes) -> float:
        descriptor, temporary = tempfile.mkstemp(prefix=".memory-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
                modified = os.fstat(stream.fileno()).st_mtime
            os.replace(temporary, path)
            return modified
        finally:
            Path(temporary).unlink(missing_ok=True)

    def save(self, agent_id: str | None, content: str, expected_version: str, *,
             task_id: str | None = None, owner: str | None = None, authorize=None) -> MemorySnapshot:
        with self._lock:
            directory = self._directory(agent_id)
            current = self._check(agent_id, directory, expected_version, owner, authorize)
            return self._publish(agent_id, directory, current, content, task_id, owner)

    def edit(self, agent_id: str | None, old_string: str, new_string: str, expected_version: str, *,
             replace_all: bool = False, task_id: str | None = None,
             owner: str | None = None, authorize=None) -> MemorySnapshot:
        with self._lock:
            directory = self._directory(agent_id)
            current = self._check(agent_id, directory, expected_version, owner, authorize)
            old_string, new_string = _normalize(old_string), _normalize(new_string)
            count = current.content.count(old_string)
            if not old_string or not count or (count > 1 and not replace_all):
                raise InvalidMemory("编辑目标为空、未找到或不唯一；请依据最新快照重新选择")
            content = current.content.replace(old_string, new_string, -1 if replace_all else 1)
            return self._publish(agent_id, directory, current, content, task_id, owner)

    def _publish(self, agent_id, directory, current, content, task_id, owner) -> MemorySnapshot:
        content, _ = _body(content)
        details = self._references(agent_id, content)
        for slug, reference in details.items():
            if current.details.get(slug) != reference and self._prepared.get(
                (agent_id, owner, reference["path"])
            ) != current.version:
                raise InvalidMemory("详情未由当前操作在已观察版本下准备；请重新读取并准备详情")
            self._detail_content(directory, slug, reference["sha256"])
        if not content:
            self._revoke_prepared(agent_id)
        if content == current.content and details == current.details:
            if agent_id in self._dirty_documents:
                try:
                    self._cleanup(directory, details, agent_id=agent_id)
                except OSError as error:
                    raise MemoryCleanupError("活动记忆未变，但旧详情清理仍未完成") from error
                self._dirty_documents.discard(agent_id)
            return current
        value = {"content": content, "details": details, "revision": current.revision + 1}
        self._directories(directory, create=True)
        modified = self._atomic(directory / "current.json", _json(value))
        snapshot = MemorySnapshot(content, _digest(_json(value)), modified, _scope(agent_id),
                                  agent_id, details, value["revision"])
        self._revoke_prepared(agent_id)
        cleanup_error = None
        try:
            self._cleanup(directory, details, agent_id=agent_id)
            self._dirty_documents.discard(agent_id)
        except OSError as error:
            self._dirty_documents.add(agent_id)
            cleanup_error = error
        if self.on_change is not None:
            self.on_change(MemoryChange(agent_id, snapshot, task_id))
        if cleanup_error is not None:
            raise MemoryCleanupError("记忆已发布，但旧详情清理未完成") from cleanup_error
        return snapshot

    def prepare_detail(self, agent_id: str | None, slug: str, content: str, expected_version: str, *,
                       owner: str, task_id: str | None = None, authorize=None) -> MemoryDetailSnapshot:
        """准备不可变文件但不发布；只有同 owner、同完整文档版本可加入索引。"""
        with self._lock:
            _slug(slug)
            if not isinstance(owner, str) or not owner:
                raise InvalidMemory("详情准备须绑定可信操作身份")
            directory = self._directory(agent_id)
            current = self._check(agent_id, directory, expected_version, owner, authorize)
            content, encoded = _body(content, detail=True)
            fingerprint = _digest(encoded)
            path = self._detail_file(directory, slug, fingerprint)
            self._directories(path.parent, create=True)
            try:
                # Content-addressed files never change in place, including retries.
                existing, _ = self._read_bytes(path, MEMORY_DETAIL_LIMIT)
            except FileNotFoundError:
                self._atomic(path, encoded)
            else:
                if existing != encoded:
                    raise MemoryReadError("已有详情文件与内容指纹不一致")
            reference = _reference(agent_id, slug, fingerprint)
            self._prepared[(agent_id, owner, reference)] = current.version
            return MemoryDetailSnapshot(content, fingerprint, reference, current.version,
                                        _scope(agent_id), agent_id, slug)

    def read_detail(self, agent_id: str | None, slug: str, *, path: str | None = None) -> MemoryDetailSnapshot:
        with self._lock:
            _slug(slug)
            directory = self._directory(agent_id)
            current = self._read(agent_id, directory)
            reference = current.details.get(slug)
            if reference is None or (path is not None and path != reference["path"]):
                raise InvalidMemory("详情引用已失效或未发布，请重新加载记忆索引")
            content = self._detail_content(directory, slug, reference["sha256"])
            return MemoryDetailSnapshot(content, reference["sha256"], reference["path"],
                                        current.version, _scope(agent_id), agent_id, slug)

    def put_detail(self, agent_id: str | None, slug: str, content: str, expected_version: str, *,
                   index_content: str | None = None, task_id: str | None = None,
                   authorize=None) -> MemorySnapshot:
        """认证 API 的组合提交；新项必须提供含逻辑或规范引用的索引。"""
        with self._lock:
            owner = "api:" + uuid4().hex
            directory = self._directory(agent_id)
            current = self._check(agent_id, directory, expected_version, owner, authorize)
            try:
                prepared = self.prepare_detail(agent_id, slug, content, expected_version,
                                               owner=owner, task_id=task_id, authorize=authorize)
                previous = current.details.get(slug)
                if index_content is None:
                    if previous is None:
                        raise InvalidMemory("新建详情须同时提供索引正文 index_content")
                    index_content = current.content.replace(previous["path"], prepared.path)
                else:
                    index_content = _normalize(index_content)
                    logical = f"/.wandrun/memory/{_scope(agent_id)}/details/{slug}.md"
                    index_content = index_content.replace(logical, prepared.path)
                    if previous is not None:
                        index_content = index_content.replace(previous["path"], prepared.path)
                references = self._references(agent_id, index_content)
                if references.get(slug, {}).get("path") != prepared.path:
                    raise InvalidMemory("索引必须引用本次准备的详情")
                # Recheck host authorization at the actual publication boundary too.
                return self.save(agent_id, index_content, expected_version, task_id=task_id,
                                 owner=owner, authorize=authorize)
            finally:
                self.discard_prepared(owner)

    def delete_detail(self, agent_id: str | None, slug: str, content: str, expected_version: str, *,
                      task_id: str | None = None, owner: str | None = None,
                      authorize=None) -> MemorySnapshot:
        with self._lock:
            _slug(slug)
            directory = self._directory(agent_id)
            current = self._check(agent_id, directory, expected_version, owner, authorize)
            content, _ = _body(content)
            if slug in self._references(agent_id, content):
                raise InvalidMemory("删除详情须同时移除索引中的对应引用")
            if slug not in current.details and content != current.content:
                raise InvalidMemory("详情不存在；不能借删除修改其他索引内容")
            self._revoke_prepared(agent_id, slug=slug)
            return self._publish(agent_id, directory, current, content, task_id, owner)

    def _revoke_prepared(self, agent_id: str | None, *, slug: str | None = None) -> None:
        """撤销发布资格与清理所有权分开：同值删除也必须使旧暂存失效。"""
        for key in tuple(self._prepared):
            if key[0] == agent_id and (slug is None or _REFERENCE.fullmatch(key[2])[2] == slug):
                del self._prepared[key]
                self._pending_cleanup.setdefault(key[1], set()).add(agent_id)
                self._dirty_documents.add(agent_id)

    def discard_prepared(self, owner: str) -> None:
        """撤销操作的发布资格，清理其未活动文件；取消不能留下可复活的暂存。"""
        with self._lock:
            documents = self._pending_cleanup.setdefault(owner, set())
            documents.update(key[0] for key in self._prepared if key[1] == owner)
            self._prepared = {key: version for key, version in self._prepared.items() if key[1] != owner}
            for agent_id in tuple(documents):
                directory = self._directory(agent_id, retired=True)
                current = self._read(agent_id, directory)
                try:
                    self._cleanup(directory, current.details, agent_id=agent_id)
                except OSError:
                    self._dirty_documents.add(agent_id)
                    raise
                documents.remove(agent_id)
                self._dirty_documents.discard(agent_id)
            self._pending_cleanup.pop(owner)

    def _cleanup(self, directory: Path, details: dict, *, agent_id: str | None = None) -> None:
        parent = directory / "details"
        self._directories(parent)
        if not parent.exists():
            return
        keep = {reference["path"] for reference in details.values()}
        keep.update(key[2] for key in self._prepared if key[0] == agent_id)
        for slug_dir in parent.iterdir():
            if slug_dir.is_symlink() or not slug_dir.is_dir():
                slug_dir.unlink()
                continue
            for path in slug_dir.iterdir():
                reference = f"/.wandrun/memory/{_scope(agent_id)}/details/{slug_dir.name}/{path.name}"
                if reference not in keep:
                    if path.is_dir() and not path.is_symlink():
                        shutil.rmtree(path)
                    else:
                        path.unlink()
            if not any(slug_dir.iterdir()):
                slug_dir.rmdir()

    def _recover(self) -> None:
        if not self.root.exists():
            return
        self._directories(self.root)
        profile = self._directory(None)
        self._cleanup_temporaries(profile)
        current = self._read(None, profile)
        self._cleanup(profile, current.details)
        agents = self.root / "agents"
        self._directories(agents)
        if agents.exists():
            for directory in agents.iterdir():
                identity = directory.name
                directory = self._directory(identity)
                self._cleanup_temporaries(directory)
                current = self._read(identity, directory)
                self._cleanup(directory, current.details, agent_id=identity)

    @staticmethod
    def _cleanup_temporaries(directory: Path) -> None:
        # A crash during atomic replacement can leave only our unpublished temp file.
        if directory.exists():
            for path in directory.glob(".memory-*"):
                path.unlink()

    def retire(self, agent_id: str) -> None:
        with self._lock:
            if agent_id is None:
                raise InvalidMemory("Agent 删除不能删除共享画像")
            self._directory(agent_id, retired=True)
            self._retired.add(agent_id)
            self._revoke_prepared(agent_id)

    def delete(self, agent_id: str) -> None:
        """只清理该 Agent 工作记忆；共享画像不属于 Agent 删除范围。"""
        with self._lock:
            if agent_id is None:
                raise InvalidMemory("Agent 删除不能删除共享画像")
            directory = self._directory(agent_id, retired=True)
            self.retire(agent_id)
            # Revoke the publication point before recursive cleanup can remove a
            # referenced file. A partial deletion then reopens as an empty document,
            # allowing the gateway's durable Agent deletion intent to finish.
            (directory / "current.json").unlink(missing_ok=True)
            if directory.exists():
                shutil.rmtree(directory)
