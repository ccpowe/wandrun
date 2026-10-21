"""把 WorkerManager 的调度状态保存为 SQLite 快照；不解释调度规则（ADR-0008）。"""

import json
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from langchain_core.messages import HumanMessage, message_to_dict, messages_from_dict

# 3：持久区分重启屏障与显式停止，连续重启也不能把用户停止误当作可恢复屏障。
SCHEMA_VERSION = 3
QUEUE_KINDS = ("feedback", "inbox", "inflight")

# executescript 不会把多条语句自动包进事务；显式 BEGIN/COMMIT，
# 建表中途崩溃时两张表和版本号要么都在，要么都不在。
_SCHEMA = f"""
BEGIN;
CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    caller TEXT,
    stopped INTEGER NOT NULL,
    restart_stopped INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT
);
CREATE TABLE messages (
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    position INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (task_id, kind, position)
);
PRAGMA user_version = {SCHEMA_VERSION};
COMMIT;
"""


def paired_store_path(checkpoint_path: Path) -> Path:
    """调度状态只对同一份历史有效：由检查点的完整文件名派生，不同检查点不会共用调度库。"""
    return checkpoint_path.with_name(f"{checkpoint_path.name}.scheduler.sqlite")



@dataclass(frozen=True)
class TaskSnapshot:
    """一个任务在一次逻辑转换结束时的调度状态。

    queues 按 QUEUE_KINDS 保存消息的当前顺序；排序规则由 Manager 决定，存储原样保存。
    """

    task_id: str
    agent: str
    caller: str | None
    stopped: bool
    status: str
    error: str | None
    queues: dict[str, tuple[HumanMessage, ...]]
    restart_stopped: bool = False

    def fingerprint(self) -> tuple:
        # 消息以固定 ID 标识且创建后不再修改，比较 ID 顺序即可判断队列是否变化。
        return (
            self.agent,
            self.caller,
            self.stopped,
            self.restart_stopped,
            self.status,
            self.error,
            tuple(
                (kind, tuple(message.id for message in self.queues.get(kind, ())))
                for kind in QUEUE_KINDS
            ),
        )


class SchedulerStore:
    """同步读写调度快照；一次 save 是一个事务，只写与上次提交不同的任务。

    使用同步 sqlite3：Manager 依赖“判断与写入之间没有 await”，异步写入会破坏这一点。
    提交失败时事务回滚并抛出异常，由调用方决定如何停止调度。
    """

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(path)
        try:
            self._connection.execute("PRAGMA journal_mode=WAL")
            version = self._connection.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                self._connection.executescript(_SCHEMA)
            elif version != SCHEMA_VERSION:
                raise RuntimeError(
                    f"调度存储版本 {version} 与当前版本 {SCHEMA_VERSION} 不兼容：{path}"
                )
        except BaseException:
            # 关闭连接会回滚未提交的建表事务。
            self._connection.close()
            raise
        # 最近一次成功提交的指纹，用于只写变化的任务。
        self._saved: dict[str, tuple] = {}

    def load(self) -> list[TaskSnapshot]:
        queues: dict[str, dict[str, list[HumanMessage]]] = {}
        for task_id, kind, payload in self._connection.execute(
            "SELECT task_id, kind, payload FROM messages ORDER BY task_id, kind, position"
        ):
            (message,) = messages_from_dict([json.loads(payload)])
            queues.setdefault(task_id, {}).setdefault(kind, []).append(message)
        snapshots = []
        for task_id, agent, caller, stopped, restart_stopped, status, error in self._connection.execute(
            "SELECT task_id, agent, caller, stopped, restart_stopped, status, error FROM tasks"
        ):
            saved = queues.get(task_id, {})
            snapshot = TaskSnapshot(
                task_id=task_id,
                agent=agent,
                caller=caller,
                stopped=bool(stopped),
                restart_stopped=bool(restart_stopped),
                status=status,
                error=error,
                queues={kind: tuple(saved.get(kind, ())) for kind in QUEUE_KINDS},
            )
            self._saved[task_id] = snapshot.fingerprint()
            snapshots.append(snapshot)
        return snapshots

    def save(self, snapshots: Iterable[TaskSnapshot]) -> None:
        """一次事务写入变化并移除已遗忘任务；提交后才更新指纹缓存。"""
        current = {snapshot.task_id: snapshot for snapshot in snapshots}
        removed = self._saved.keys() - current.keys()
        changed = [
            snapshot for snapshot in current.values()
            if self._saved.get(snapshot.task_id) != snapshot.fingerprint()
        ]
        if not changed and not removed:
            return
        with self._connection:
            for task_id in removed:
                self._connection.execute("DELETE FROM messages WHERE task_id = ?", (task_id,))
                self._connection.execute("DELETE FROM tasks WHERE task_id = ?", (task_id,))
            for snapshot in changed:
                self._write(snapshot)
        self._saved = {identity: snapshot.fingerprint() for identity, snapshot in current.items()}

    def _write(self, snapshot: TaskSnapshot) -> None:
        self._connection.execute(
            "INSERT OR REPLACE INTO tasks (task_id, agent, caller, stopped, restart_stopped, status, error)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                snapshot.task_id,
                snapshot.agent,
                snapshot.caller,
                int(snapshot.stopped),
                int(snapshot.restart_stopped),
                snapshot.status,
                snapshot.error,
            ),
        )
        # 队列按快照整体覆盖，不在存储层重复 Manager 的排序规则。
        self._connection.execute(
            "DELETE FROM messages WHERE task_id = ?", (snapshot.task_id,)
        )
        self._connection.executemany(
            "INSERT INTO messages (task_id, kind, position, message_id, payload)"
            " VALUES (?, ?, ?, ?, ?)",
            [
                (
                    snapshot.task_id,
                    kind,
                    position,
                    message.id,
                    json.dumps(message_to_dict(message), ensure_ascii=False),
                )
                for kind in QUEUE_KINDS
                for position, message in enumerate(snapshot.queues.get(kind, ()))
            ],
        )

    def close(self) -> None:
        self._connection.close()
