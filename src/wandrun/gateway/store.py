"""网关库（gateway.sqlite）：设备配对、Agent、定时、对话及持久事件。

对话事件表平时追加，删除时移除对应历史并保留全局墓碑；聊天历史和事件流续传共用它。
检查点仍是模型的上下文，这里只保存给用户看的事件，不随压缩或尾部修复改变。

Agent 定义与对话放在同一个库：对话必须引用存在的入口 Agent（外键）。删除 Agent
时先记录意图、清理其对话和跨库状态，最后原子删除定义及引用并留下全局墓碑。
网关首次启动时从 agents.toml 与 mcps.toml 一起导入，之后以这里为唯一来源。

ADR-0043：task_conversations 保存成员会话；事件的 conversation_id 始终指向根，
data.timeline_ids 指定展示时间线，无此字段的事件只属于根。成员 human 正文与根预览
同事务保存，草稿终态仍按 draft_id 去重；协作消息不参与首页未读和产品活动。
浏览器进入 requested 仍计入入口 Agent 首页活动；协作行红点由 App 合并未读与租约状态。
协作记录随根删除，不能独立改名/删除；结构版本 22 不兼容旧库。
"""

import hashlib
import json
import math
import secrets
import sqlite3
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import uuid4

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.connectors import UnknownConnector, public_connector
from wandrun.gateway.schedules import UnknownSchedule, next_run_at

# 22：应用唯一绑定及 OAuth 注册、凭据和代际与连接器同库；升级须清空 state。
SCHEMA_VERSION = 22
AVATAR_COUNT = 8


def _validate_avatar(avatar: int) -> None:
    if type(avatar) is not int or not 0 <= avatar < AVATAR_COUNT:
        raise ValueError(f"avatar 必须是 0～{AVATAR_COUNT - 1} 的整数")


# 消息/定时触发总是产品活动；浏览器事件仅进入 requested 的那次算活动。
HOME_EVENT_TYPES = ("message.user", "message.agent", "schedule.triggered")

# AUTOINCREMENT 保证 seq 删除后也不复用：App 用 seq 续传，复用会让已删事件的位置指向新事件。
_SCHEMA = f"""
BEGIN;
-- id 不可变，运行时的身份（检查点绑定、委派目标）都用它；name 只用于显示，导入时等于 id。
-- 列表字段（MCP、skills）存 JSON 数组：只整体读写，不按元素查询。
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT,
    context_window INTEGER,
    compaction_keep_tokens INTEGER NOT NULL,
    compaction_model TEXT,
    mcp_servers TEXT NOT NULL,
    searchable_mcp_servers TEXT NOT NULL,
    skills TEXT NOT NULL,
    code_mode INTEGER NOT NULL,
    environment TEXT NOT NULL,
    -- 移出首页时的全局 seq；空表示没移出。是否在首页由它与对话里的新事件共同决定（见 agents）。
    hidden_after_seq INTEGER
);
-- 直接委派关系（tuple 顺序即 position，影响委派目录的顺序）。“是谁的成员”从这里反查，不另存。
CREATE TABLE agent_workers (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    worker_id TEXT NOT NULL REFERENCES agents(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (agent_id, worker_id)
);
-- 删除跨检查点与调度库，必须先保存意图；最后只在没有对话和外部成员引用时删定义。
CREATE TABLE deleting_agents (id TEXT PRIMARY KEY REFERENCES agents(id));
CREATE TABLE memory_metadata (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    updated_by TEXT NOT NULL CHECK (updated_by IN ('user', 'agent'))
);
CREATE TABLE deleted_agents (
    id TEXT PRIMARY KEY,
    event_seq INTEGER NOT NULL REFERENCES events(seq)
);
-- client_id 的首次响应即使 Agent 后来改名、删除也必须能原样重放。
CREATE TABLE created_agent_results (
    client_id TEXT PRIMARY KEY,
    event_seq INTEGER NOT NULL REFERENCES events(seq),
    detail TEXT NOT NULL
);
CREATE TABLE connectors (
    id TEXT PRIMARY KEY,
    definition TEXT NOT NULL
);
CREATE TABLE app_connectors (
    app_id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL UNIQUE REFERENCES connectors(id) ON DELETE CASCADE
);
CREATE TABLE connector_oauth (
    connector_id TEXT PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 0,
    record TEXT
);
-- 首次响应只保存脱敏投影，删除后仍可按 client_id 重放。
CREATE TABLE created_connector_results (
    client_id TEXT PRIMARY KEY,
    event_seq INTEGER NOT NULL REFERENCES events(seq),
    detail TEXT NOT NULL,
    app_id TEXT
);
CREATE TABLE deleted_connectors (
    id TEXT PRIMARY KEY,
    event_seq INTEGER NOT NULL REFERENCES events(seq)
);
-- main_agent：运行时默认入口（网关创建对话总是显式指定 Agent）。
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- 仅持久化展示所需的脱敏成功快照；身份为认证来源的 opaque hash。
CREATE TABLE subscription_snapshots (
    kind TEXT NOT NULL,
    identity TEXT NOT NULL,
    client_version TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    PRIMARY KEY (kind, identity, client_version)
);
CREATE TABLE agent_daily_usage (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, date)
);
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    title TEXT NOT NULL,
    title_user_edited INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    read_seq INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle',
    source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'schedule')),
    schedule_origin TEXT
);
-- Agent 身份是历史快照，不加 Agent 外键：删除成员不能抹掉其他入口下的协作记录。
CREATE TABLE task_conversations (
    task_id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    creator_task_id TEXT NOT NULL,
    creator_agent_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    read_seq INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX tasks_received ON task_conversations(agent_id, updated_at);
CREATE INDEX tasks_created ON task_conversations(creator_agent_id, updated_at);
CREATE INDEX tasks_root ON task_conversations(root_id);
-- 快照保留结束原因供列表/详情及重启后查询；事件写入同一事务。
CREATE TABLE browser_tasks (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    root_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    entry_agent_id TEXT NOT NULL,
    state TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX browser_tasks_by_root ON browser_tasks (root_id);
CREATE INDEX browser_tasks_by_agent ON browser_tasks (agent_id);
-- 控制命令断线重试返回第一次结果，不再次接管或交还。
CREATE TABLE browser_command_results (
    client_id TEXT PRIMARY KEY,
    browser_task_id TEXT NOT NULL,
    action TEXT NOT NULL,
    response TEXT NOT NULL
);
CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    rule TEXT NOT NULL,
    timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    next_run_at REAL,
    processed_through REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled = 1;
CREATE TABLE schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    scheduled_at REAL NOT NULL,
    started_at REAL,
    finished_at REAL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'missed')),
    reason TEXT,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    missed_before REAL,
    UNIQUE (schedule_id, scheduled_at)
);
CREATE INDEX schedule_runs_recent ON schedule_runs (schedule_id, id DESC);
CREATE INDEX schedule_runs_conversation ON schedule_runs (conversation_id);
CREATE TABLE created_schedule_results (
    client_id TEXT PRIMARY KEY,
    event_seq INTEGER NOT NULL REFERENCES events(seq),
    detail TEXT NOT NULL
);
CREATE TABLE deleted_schedules (
    id TEXT PRIMARY KEY,
    event_seq INTEGER NOT NULL REFERENCES events(seq)
);
-- 跨检查点、调度库的删除不能事务化：先保存完整线程集合，重启后从这里继续清理。
CREATE TABLE deleting_conversations (
    id TEXT PRIMARY KEY REFERENCES conversations(id),
    threads TEXT NOT NULL
);
-- 墓碑不随对话历史删除；重复 DELETE 返回原来的全局事件。
CREATE TABLE deleted_conversations (
    id TEXT PRIMARY KEY,
    event_seq INTEGER NOT NULL REFERENCES events(seq)
);
-- 文件登记独立于来源，删除对话/Agent 只断开跳转，不删除原文件或记录。
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    remote_environment TEXT,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    task_id TEXT NOT NULL,
    created_at REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('agent', 'user_upload'))
);
CREATE INDEX files_name ON files (name);
CREATE INDEX files_conversation ON files (conversation_id);
CREATE INDEX files_agent ON files (agent_id);
-- 上传状态保留到显式 termination：file_id 在创建时分配，完成前后不变。
-- destination 在物理放置前持久化；终止意图在清理 spool 前提交，崩溃后继续清理。
CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    filetype TEXT NOT NULL,
    metadata TEXT NOT NULL,
    length INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    created_at REAL NOT NULL,
    destination TEXT,
    file_id TEXT NOT NULL UNIQUE,
    completed INTEGER NOT NULL DEFAULT 0,
    terminating INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX uploads_pending ON uploads (completed, created_at);
-- 令牌与配对码都只保存 SHA-256 摘要；配对本身不进入可订阅的 events。
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    paired_at REAL NOT NULL,
    last_used_at REAL,
    pairing_method TEXT NOT NULL CHECK (pairing_method IN ('manual', 'qr')),
    revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pairing_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    name TEXT,
    expires_at REAL NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 空：不属于任何对话的资源变化和删除墓碑，只为让其他设备续传到。
    conversation_id TEXT,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    at REAL NOT NULL,
    client_id TEXT UNIQUE
);
CREATE INDEX events_by_conversation ON events (conversation_id, seq);
CREATE UNIQUE INDEX agent_message_draft ON events (json_extract(data, '$.draft_id'))
    WHERE type = 'message.agent' AND json_extract(data, '$.draft_id') IS NOT NULL;
-- 检查点对账可重复，身份不能依赖 SSE 序号或客户端命令键。
CREATE TABLE compaction_events (
    task_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
    PRIMARY KEY (task_id, event_id)
);
PRAGMA user_version = {SCHEMA_VERSION};
COMMIT;
"""


class UnknownAgent(LookupError):
    """引用了库里不存在的 Agent。"""


class ClientIdConflict(ValueError):
    """同一个 client_id 已用于另一个对话或另一种命令。"""


class InvalidReadPosition(ValueError):
    """已读位置超过了已有的最新事件。"""


@dataclass(frozen=True)
class Event:
    seq: int
    conversation_id: str | None
    type: str
    data: dict
    at: float
    client_id: str | None

    def to_dict(self) -> dict:
        event = {
            "seq": self.seq,
            "type": self.type,
            "at": self.at,
            "data": self.data,
        }
        if self.conversation_id is not None:  # ADR-0022 第 6 节：conversation_id “如有”
            event["conversation_id"] = self.conversation_id
        if self.client_id is not None:
            event["client_id"] = self.client_id
        return event


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _utc(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


class GatewayStore:
    """同步读写；每次追加是一个事务。管理整个网关库：Agent、定时、设置、对话与事件。

    使用同步 sqlite3：网关在“按 client_id 查重 → 提交给 Manager → 追加事件”之间不能有 await，
    否则同一命令的并发重试可能都被执行（与 SchedulerStore 的理由相同）。
    """

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(path)
        try:
            # 外键默认关闭且按连接生效；建表脚本里的 BEGIN 之内不能改它，所以先设。
            self._connection.execute("PRAGMA foreign_keys=ON")
            self._connection.execute("PRAGMA journal_mode=WAL")
            version = self._connection.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                self._connection.executescript(_SCHEMA)
            elif version != SCHEMA_VERSION:
                raise RuntimeError(
                    f"事件存储版本 {version} 与当前版本 {SCHEMA_VERSION} 不兼容：{path}"
                )
        except BaseException:
            self._connection.close()
            raise

    # ---- 设备和配对 ----

    def issue_pairing_code(self, name: str | None = None) -> dict:
        """只保留一个有效挑战；新码使旧码失效，错误猜测计入当前挑战的连续五次额度。"""
        code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
        expires_at = time.time() + 300
        with self._connection:
            self._connection.execute("UPDATE pairing_codes SET used = 1 WHERE used = 0")
            self._connection.execute(
                "INSERT INTO pairing_codes (code_hash, name, expires_at) VALUES (?, ?, ?)",
                (_digest(code), name, expires_at),
            )
        return {"code": code, "expires_at": _utc(expires_at)}

    def exchange_pairing_code(self, code: str, name: str | None, method: str) -> tuple[dict | None, str | None]:
        """一个 SQLite 写事务中兑换、记错与建设备；并发请求只能有一个领取者。

        返回 (凭据, 错误码)。即使猜中旧挑战也不能兑换；猜错始终扣当前挑战的额度。
        """
        now = time.time()
        code_hash = _digest(code.upper().strip())
        with self._connection:
            self._connection.execute("BEGIN IMMEDIATE")
            active = self._connection.execute(
                "SELECT id, code_hash, name, expires_at, failures, used"
                " FROM pairing_codes ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if active is None:
                return None, "pairing_invalid"
            identity, expected_hash, issued_name, expires, failures, used = active
            if not secrets.compare_digest(code_hash, expected_hash):
                old = self._connection.execute(
                    "SELECT used, expires_at, failures FROM pairing_codes WHERE code_hash = ?",
                    (code_hash,),
                ).fetchone()
                if not used and expires > now and failures < 5:
                    self._connection.execute(
                        "UPDATE pairing_codes SET failures = failures + 1 WHERE id = ?", (identity,)
                    )
                if old is not None:
                    return None, (
                        "pairing_used" if old[0] else "pairing_expired" if old[1] <= now
                        else "pairing_locked" if old[2] >= 5 else "pairing_invalid"
                    )
                return None, "pairing_locked" if failures >= 4 and not used and expires > now else "pairing_invalid"
            if used:
                return None, "pairing_used"
            if expires <= now:
                return None, "pairing_expired"
            if failures >= 5:
                return None, "pairing_locked"
            token = secrets.token_urlsafe(32)
            device_id = uuid4().hex
            self._connection.execute("UPDATE pairing_codes SET used = 1 WHERE id = ?", (identity,))
            self._connection.execute(
                "INSERT INTO devices (id, name, token_hash, paired_at, pairing_method)"
                " VALUES (?, ?, ?, ?, ?)",
                (device_id, name or issued_name or "移动设备", _digest(token), now, method),
            )
        return {
            "token": token, "device_id": device_id, "paired_at": _utc(now),
            "pairing_method": method,
        }, None

    def device_for_token(self, token: str) -> dict | None:
        """验证未撤销令牌，最近使用时间最多每分钟写一次。"""
        now = time.time()
        row = self._connection.execute(
            "SELECT id, name, paired_at, last_used_at, pairing_method FROM devices"
            " WHERE token_hash = ? AND revoked = 0", (_digest(token),)
        ).fetchone()
        if row is None:
            return None
        identity, name, paired_at, last_used_at, method = row
        if last_used_at is None or now - last_used_at >= 60:
            with self._connection:
                self._connection.execute(
                    "UPDATE devices SET last_used_at = ? WHERE id = ? AND revoked = 0",
                    (now, identity),
                )
        return {
            "id": identity, "name": name, "paired_at": _utc(paired_at), "pairing_method": method,
        }

    def device_active(self, identity: str) -> bool:
        return self._connection.execute(
            "SELECT 1 FROM devices WHERE id = ? AND revoked = 0", (identity,)
        ).fetchone() is not None

    def list_devices(self) -> list[dict]:
        rows = self._connection.execute(
            "SELECT id, name, paired_at, last_used_at, revoked FROM devices ORDER BY paired_at DESC"
        ).fetchall()
        return [
            {"id": identity, "name": name, "paired_at": _utc(paired),
             "last_used_at": _utc(used) if used is not None else None, "revoked": bool(revoked)}
            for identity, name, paired, used, revoked in rows
        ]

    def revoke_device(self, identity: str) -> bool:
        """返回设备是否存在；重复撤销也成功，未知设备留给 HTTP 处理为 404。"""
        with self._connection:
            cursor = self._connection.execute(
                "UPDATE devices SET revoked = 1 WHERE id = ?", (identity,)
            )
        return cursor.rowcount != 0

    # ---- Agent 定义 ----

    def has_agents(self) -> bool:
        return self._connection.execute("SELECT EXISTS (SELECT 1 FROM agents)").fetchone()[0] == 1

    def has_imported_agents(self) -> bool:
        """首次导入/创建已经发生；即使用户删光 Agent，也不得重新读取 agents.toml。"""
        return self._connection.execute(
            "SELECT 1 FROM settings WHERE key = 'agents_imported'"
        ).fetchone() is not None

    def import_agents(self, catalog: AgentCatalog, connectors: dict[str, dict] | None = None) -> None:
        """只在首次启动导入已校验的完整定义；空集也记为已导入。

        Agent、连接器、委派关系和入口设置一起提交，失败不留部分数据。
        """
        with self._connection:
            if self.has_imported_agents() or self.has_agents():
                raise RuntimeError("库里已有 Agent 导入记录，不能再导入")
            for identity, definition in (connectors or {}).items():
                self._connection.execute(
                    "INSERT INTO connectors (id, definition) VALUES (?, ?)",
                    (identity, json.dumps(definition, ensure_ascii=False)),
                )
            for position, (identity, agent) in enumerate(catalog.agents.items()):
                self._insert_agent(identity, agent, agent.name or identity, position % AVATAR_COUNT)
            # 委派关系引用其他 Agent，等全部 Agent 写入后再写，外键才能成立。
            for identity, agent in catalog.agents.items():
                self._connection.executemany(
                    "INSERT INTO agent_workers (agent_id, worker_id, position) VALUES (?, ?, ?)",
                    [(identity, worker, position) for position, worker in enumerate(agent.workers)],
                )
            if catalog.main_agent is not None:
                self._connection.execute(
                    "INSERT INTO settings (key, value) VALUES ('main_agent', ?)", (catalog.main_agent,)
                )
            self._connection.execute(
                "INSERT INTO settings (key, value) VALUES ('agents_imported', '1')"
            )

    def agent_catalog(self) -> AgentCatalog:
        """库里的全部定义，供运行时装配；引用是否成立由运行时按文件来源的同一规则再检查。"""
        workers = self._workers()
        rows = self._connection.execute(
            "SELECT id, name, description, system_prompt, model, reasoning_effort,"
            " context_window, compaction_keep_tokens, compaction_model, mcp_servers,"
            " searchable_mcp_servers, skills, code_mode, environment FROM agents ORDER BY rowid"
        ).fetchall()
        settings = dict(self._connection.execute("SELECT key, value FROM settings"))
        agents = {
            identity: AgentDefinition(
                description=description, system_prompt=system_prompt, model=model,
                reasoning_effort=effort, context_window=context_window,
                compaction_keep_tokens=keep_tokens, compaction_model=compaction_model,
                mcp_servers=tuple(json.loads(mcp)),
                searchable_mcp_servers=tuple(json.loads(searchable)), skills=tuple(json.loads(skills)),
                workers=tuple(workers.get(identity, ())), code_mode=bool(code_mode),
                environment=environment, name=name if name != identity else None,
            )
            for identity, name, description, system_prompt, model, effort, context_window,
            keep_tokens, compaction_model, mcp, searchable, skills, code_mode, environment in rows
        }
        return AgentCatalog(settings.get("main_agent"), agents)

    # ---- 连接器定义：含密钥的读取仅供装配；HTTP 必须走 Gateway 的公开投影 ----

    def connector_definitions(self) -> dict[str, dict]:
        return {identity: json.loads(definition) for identity, definition in self._connection.execute(
            "SELECT id, definition FROM connectors ORDER BY rowid"
        )}

    def connector_users(self, identity: str) -> list[dict]:
        return [
            {"id": agent_id, "name": name}
            for agent_id, name, direct, searchable in self._connection.execute(
                "SELECT id, name, mcp_servers, searchable_mcp_servers FROM agents ORDER BY rowid"
            )
            if identity in json.loads(direct) or identity in json.loads(searchable)
        ]

    def replay_create_connector(self, client_id: str) -> tuple[dict, Event] | None:
        event = self.by_client_id(client_id)
        if event is None:
            return None
        if event.type != "resource.changed" or event.data.get("kind") != "connector" or event.data.get("op") != "created":
            raise ClientIdConflict("client_id 已用于其他命令")
        row = self._connection.execute(
            "SELECT detail, app_id FROM created_connector_results WHERE client_id = ? AND event_seq = ?",
            (client_id, event.seq),
        ).fetchone()
        if row is None:
            raise RuntimeError("连接器创建事件缺少原始响应")
        if row[1] is not None:
            raise ClientIdConflict("client_id 已用于应用绑定")
        return json.loads(row[0]), event

    def create_connector(self, definition: dict, client_id: str) -> tuple[dict, Event, bool]:
        with self._connection:
            if replay := self.replay_create_connector(client_id):
                return *replay, False
            identity = definition["id"]
            self._connection.execute(
                "INSERT INTO connectors (id, definition) VALUES (?, ?)",
                (identity, json.dumps(definition, ensure_ascii=False)),
            )
            detail = {
                **public_connector(definition), "status": "disconnected", "error": None,
                "tool_count": 0, "used_by": [], "pending_restart": False,
                "auth": {
                    "status": "unauthorized" if definition.get("auth_type") == "oauth" else "not_required",
                    "authorizing": False, "scopes": [],
                },
            }
            event = self._connector_event(identity, "created", client_id)
            self._connection.execute(
                "INSERT INTO created_connector_results (client_id, event_seq, detail) VALUES (?, ?, ?)",
                (client_id, event.seq, json.dumps(detail, ensure_ascii=False)),
            )
            return detail, event, True

    def app_connector_id(self, app_id: str) -> str | None:
        row = self._connection.execute(
            "SELECT connector_id FROM app_connectors WHERE app_id = ?", (app_id,)
        ).fetchone()
        return row[0] if row else None

    def bind_app(self, app_id: str, definition: dict, client_id: str) -> bool:
        """One binding and its public creation event commit together, even across devices."""
        with self._connection:
            event = self.by_client_id(client_id)
            if event is not None:
                if event.data != {"kind": "connector", "id": definition["id"], "op": "created"}:
                    raise ClientIdConflict("client_id 已用于其他命令")
                return False
            if self.app_connector_id(app_id) is not None:
                return False
            self._connection.execute(
                "INSERT INTO connectors (id, definition) VALUES (?, ?)",
                (definition["id"], json.dumps(definition, ensure_ascii=False)),
            )
            self._connection.execute(
                "INSERT INTO app_connectors (app_id, connector_id) VALUES (?, ?)",
                (app_id, definition["id"]),
            )
            detail = {
                **public_connector(definition), "status": "disconnected", "error": None,
                "tool_count": 0, "used_by": [], "pending_restart": False,
                "auth": {"status": "unauthorized", "authorizing": False, "scopes": []},
            }
            event = self._connector_event(definition["id"], "created", client_id)
            self._connection.execute(
                "INSERT INTO created_connector_results (client_id, event_seq, detail, app_id) VALUES (?, ?, ?, ?)",
                (client_id, event.seq, json.dumps(detail, ensure_ascii=False), app_id),
            )
            return True

    def replay_connect_app(self, app_id: str, client_id: str) -> dict | None:
        event = self.by_client_id(client_id)
        if event is None:
            return None
        row = self._connection.execute(
            "SELECT detail FROM created_connector_results WHERE client_id = ? AND event_seq = ? AND app_id = ?",
            (client_id, event.seq, app_id),
        ).fetchone()
        if row is None:
            raise ClientIdConflict("client_id 已用于其他命令")
        return json.loads(row[0])

    def remember_app_binding(self, app_id: str, identity: str, client_id: str, detail: dict) -> None:
        """An existing binding acquisition also consumes the global command ID durably."""
        with self._connection:
            if self.by_client_id(client_id) is not None:
                raise ClientIdConflict("client_id 已用于其他命令")
            if self.app_connector_id(app_id) != identity:
                raise UnknownConnector(identity)
            event = self._connector_event(identity, "bound", client_id)
            self._connection.execute(
                "INSERT INTO created_connector_results (client_id, event_seq, detail, app_id) VALUES (?, ?, ?, ?)",
                (client_id, event.seq, json.dumps(detail, ensure_ascii=False), app_id),
            )

    def oauth_record(self, identity: str) -> tuple[int, dict | None]:
        row = self._connection.execute(
            "SELECT generation, record FROM connector_oauth WHERE connector_id = ?", (identity,)
        ).fetchone()
        return (row[0], json.loads(row[1]) if row[1] else None) if row else (0, None)

    def save_oauth(self, identity: str, generation: int, record: dict | None) -> bool:
        """CAS for refresh and callbacks. Failed generations cannot resurrect removed credentials."""
        with self._connection:
            cursor = self._connection.execute(
                "UPDATE connector_oauth SET record = ? WHERE connector_id = ? AND generation = ?",
                (json.dumps(record) if record is not None else None, identity, generation),
            )
            if cursor.rowcount == 0:
                if generation != 0 or identity not in self.connector_definitions():
                    return False
                cursor = self._connection.execute(
                    "INSERT INTO connector_oauth (connector_id, generation, record) VALUES (?, 0, ?)"
                    " ON CONFLICT(connector_id) DO NOTHING",
                    (identity, json.dumps(record) if record is not None else None),
                )
                if cursor.rowcount == 0:
                    return False
            self._connector_event(identity, "status")
            return True

    def invalidate_oauth(
        self, identity: str, *, reauthorization_required: bool = False,
        expected_generation: int | None = None,
    ) -> int | None:
        """Persist a new generation; a stale refresh/callback must not invalidate its successor."""
        with self._connection:
            if identity not in self.connector_definitions():
                raise UnknownConnector(identity)
            record = json.dumps({"status": "reauthorization_required"}) if reauthorization_required else None
            if expected_generation is None:
                self._connection.execute(
                    "INSERT INTO connector_oauth (connector_id, generation, record) VALUES (?, 1, ?)"
                    " ON CONFLICT(connector_id) DO UPDATE SET generation = generation + 1, record = excluded.record",
                    (identity, record),
                )
            else:
                changed = self._connection.execute(
                    "UPDATE connector_oauth SET generation = generation + 1, record = ?"
                    " WHERE connector_id = ? AND generation = ?",
                    (record, identity, expected_generation),
                )
                if not changed.rowcount:
                    return None
            self._connector_event(identity, "status")
            return self.oauth_record(identity)[0]

    def update_connector(self, definition: dict) -> Event | None:
        with self._connection:
            identity = definition["id"]
            current = self.connector_definitions().get(identity)
            if current is None:
                raise UnknownConnector(identity)
            if definition == current:
                return None
            self._connection.execute(
                "UPDATE connectors SET definition = ? WHERE id = ?",
                (json.dumps(definition, ensure_ascii=False), identity),
            )
            return self._connector_event(identity, "updated")

    def deleted_connector_event(self, identity: str) -> Event | None:
        row = self._connection.execute(
            "SELECT e.seq, e.conversation_id, e.type, e.data, e.at, e.client_id"
            " FROM deleted_connectors d JOIN events e ON e.seq = d.event_seq WHERE d.id = ?", (identity,)
        ).fetchone()
        return _event(row) if row else None

    def delete_connector(self, identity: str) -> Event:
        with self._connection:
            if event := self.deleted_connector_event(identity):
                return event
            if identity not in self.connector_definitions():
                raise UnknownConnector(identity)
            if self.connector_users(identity):
                raise ValueError("连接器仍被 Agent 引用")
            self._connection.execute("DELETE FROM connectors WHERE id = ?", (identity,))
            event = self._connector_event(identity, "deleted")
            self._connection.execute(
                "INSERT INTO deleted_connectors (id, event_seq) VALUES (?, ?)", (identity, event.seq)
            )
            return event

    def connector_status_changed(self, identity: str) -> Event:
        with self._connection:
            return self._connector_event(identity, "status")

    def _connector_event(self, identity: str, op: str, client_id: str | None = None) -> Event:
        return self._insert(
            None, "resource.changed", {"kind": "connector", "id": identity, "op": op},
            client_id, time.time(),
        )

    def get_model_settings(self) -> dict | None:
        """没有配置时返回 None；显式模型和可选推理档位按同一事务保存。"""
        settings = dict(self._connection.execute(
            "SELECT key, value FROM settings"
            " WHERE key IN ('default_model', 'default_reasoning_effort')"
        ))
        if "default_model" not in settings:
            return None
        return {
            "default_model": settings["default_model"],
            "default_reasoning_effort": settings.get("default_reasoning_effort"),
        }

    def set_model_settings(self, model: str, effort: str | None) -> None:
        with self._connection:
            self._connection.execute(
                "INSERT INTO settings (key, value) VALUES ('default_model', ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (model,),
            )
            if effort is None:
                self._connection.execute(
                    "DELETE FROM settings WHERE key = 'default_reasoning_effort'"
                )
            else:
                self._connection.execute(
                    "INSERT INTO settings (key, value) VALUES ('default_reasoning_effort', ?)"
                    " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (effort,),
                )

    def load_subscription_snapshot(
        self, kind: str, identity: str, client_version: str
    ) -> dict | None:
        row = self._connection.execute(
            "SELECT snapshot FROM subscription_snapshots"
            " WHERE kind = ? AND identity = ? AND client_version = ?",
            (kind, identity, client_version),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def save_subscription_snapshot(
        self, kind: str, identity: str, client_version: str, snapshot: dict
    ) -> None:
        """只接受 SubscriptionData 已规范化、脱敏的成功快照；这里仅负责持久化。"""
        with self._connection:
            self._connection.execute(
                "INSERT INTO subscription_snapshots (kind, identity, client_version, snapshot)"
                " VALUES (?, ?, ?, ?) ON CONFLICT(kind, identity, client_version)"
                " DO UPDATE SET snapshot = excluded.snapshot",
                (kind, identity, client_version, json.dumps(snapshot, ensure_ascii=False)),
            )

    def record_agent_usage(self, agent_id: str, usage: dict, *, at: float) -> None:
        """完成的模型请求按其完成时的本地日期原子累加；缺失的用量不臆测。"""
        values = [usage.get(key) for key in (
            "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens",
        )]
        if any(value is not None and (type(value) is not int or value < 0) for value in values):
            raise ValueError("token 用量必须是非负整数或 None")
        if all(value is None for value in values):
            return
        day = datetime.fromtimestamp(at).date().isoformat()
        with self._connection:
            self._connection.execute(
                "INSERT INTO agent_daily_usage"
                " (agent_id, date, input_tokens, cached_input_tokens,"
                " output_tokens, reasoning_output_tokens) VALUES (?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(agent_id, date) DO UPDATE SET"
                " input_tokens = input_tokens + excluded.input_tokens,"
                " cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,"
                " output_tokens = output_tokens + excluded.output_tokens,"
                " reasoning_output_tokens = reasoning_output_tokens + excluded.reasoning_output_tokens",
                (agent_id, day, *(value or 0 for value in values)),
            )

    def agent_usage(self, days: int) -> list[dict]:
        """最近 days 个本地日期（含今天），无记录的 Agent 也返回零用量。"""
        if type(days) is not int or days < 1:
            raise ValueError("days 必须是正整数")
        today = date.today()
        start = date.fromordinal(max(1, today.toordinal() - days + 1))
        rows = self._connection.execute(
            "SELECT a.id, u.date, u.input_tokens, u.cached_input_tokens,"
            " u.output_tokens, u.reasoning_output_tokens"
            " FROM agents a LEFT JOIN agent_daily_usage u"
            " ON u.agent_id = a.id AND u.date BETWEEN ? AND ?"
            " ORDER BY a.rowid, u.date",
            (start.isoformat(), today.isoformat()),
        )
        fields = (
            "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"
        )
        agents = {}
        for agent_id, day, *counts in rows:
            if agent_id not in agents:
                agents[agent_id] = {
                    "agent_id": agent_id, **dict.fromkeys(fields, 0), "daily": []
                }
            item = agents[agent_id]
            if day is not None:
                daily = {"date": day, **dict(zip(fields, counts))}
                item["daily"].append(daily)
                for field, count in zip(fields, counts):
                    item[field] += count
        return list(agents.values())


    def _least_used_avatar(self) -> int:
        """基于当前定义选使用次数最少的头像，并列时取编号最小者。"""
        counts = [0] * AVATAR_COUNT
        for avatar, count in self._connection.execute(
            "SELECT avatar, COUNT(*) FROM agents GROUP BY avatar"
        ):
            counts[avatar] = count
        return min(range(AVATAR_COUNT), key=counts.__getitem__)



    def _insert_agent(
        self, identity: str, definition: AgentDefinition, name: str, avatar: int
    ) -> None:
        _validate_avatar(avatar)
        self._connection.execute(
            "INSERT INTO agents (id, name, avatar, description, system_prompt, model,"
            " reasoning_effort, context_window, compaction_keep_tokens, compaction_model,"
            " mcp_servers, searchable_mcp_servers, skills, code_mode, environment)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                identity, name, avatar, definition.description, definition.system_prompt,
                definition.model, definition.reasoning_effort, definition.context_window,
                definition.compaction_keep_tokens, definition.compaction_model,
                json.dumps(definition.mcp_servers), json.dumps(definition.searchable_mcp_servers),
                json.dumps(definition.skills), int(definition.code_mode), definition.environment,
            ),
        )

    def replay_create_agent(self, client_id: str) -> tuple[dict, Event] | None:
        """重放创建时的原始详情（后续编辑/删除不改变它）；其他命令复用 id 则冲突。"""
        event = self.by_client_id(client_id)
        if event is None:
            return None
        if event.type != "resource.changed" or event.data.get("kind") != "agent" or (
            event.data.get("op") != "created"
        ):
            raise ClientIdConflict("client_id 已用于其他命令")
        row = self._connection.execute(
            "SELECT detail FROM created_agent_results WHERE client_id = ? AND event_seq = ?",
            (client_id, event.seq),
        ).fetchone()
        if row is None:
            raise RuntimeError("Agent 创建事件缺少原始响应")
        return json.loads(row[0]), event

    def create_agent(
        self, identity: str, definition: AgentDefinition, name: str, avatar: int | None,
        client_id: str,
    ) -> tuple[dict, Event, bool]:
        """原子保存定义、委派关系、首次响应和同步事件；头像缺省时取最少使用编号。"""
        with self._connection:
            if (replayed := self.replay_create_agent(client_id)) is not None:
                return *replayed, False
            if self.deleted_agent_event(identity) is not None:
                raise ValueError(f"Agent id 已被删除，不能复用：{identity}")
            if avatar is None:
                avatar = self._least_used_avatar()
            self._insert_agent(identity, definition, name, avatar)
            self._connection.executemany(
                "INSERT INTO agent_workers (agent_id, worker_id, position) VALUES (?, ?, ?)",
                [(identity, worker, position) for position, worker in enumerate(definition.workers)],
            )
            detail = self.agent(identity)
            event = self._resource_changed(identity, "created", client_id)
            self._connection.execute(
                "INSERT INTO created_agent_results (client_id, event_seq, detail) VALUES (?, ?, ?)",
                (client_id, event.seq, json.dumps(detail, ensure_ascii=False)),
            )
            self._connection.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES ('agents_imported', '1')"
            )
            return detail, event, True

    def update_agent(
        self, identity: str, definition: AgentDefinition, name: str, avatar: int
    ) -> tuple[dict, Event | None]:
        """修改可编辑定义及关系；完全相同不写事件，执行环境不可通过此接口改动。"""
        _validate_avatar(avatar)
        with self._connection:
            current = self.agent(identity)
            if current is None:
                raise UnknownAgent(identity)
            if self.agent_deleting(identity):
                raise RuntimeError(f"Agent 正在删除：{identity}")
            if current["environment"] != definition.environment:
                raise ValueError("不能修改 Agent 的执行环境")
            changed = (
                (current["name"], current["avatar"], current["description"],
                 current["system_prompt"], current["model"], current["reasoning_effort"],
                 current["context_window"], current["compaction_keep_tokens"], current["compaction_model"],
                 current["skills"], current["workers"], current["mcp_servers"], current["searchable_mcp_servers"],
                 current["code_mode"])
                != (name, avatar, definition.description, definition.system_prompt,
                    definition.model, definition.reasoning_effort, definition.context_window,
                    definition.compaction_keep_tokens, definition.compaction_model,
                    list(definition.skills), list(definition.workers),
                    list(definition.mcp_servers), list(definition.searchable_mcp_servers),
                    definition.code_mode)
            )
            if not changed:
                return current, None
            self._connection.execute(
                "UPDATE agents SET name = ?, avatar = ?, description = ?, system_prompt = ?,"
                " model = ?, reasoning_effort = ?, context_window = ?,"
                " compaction_keep_tokens = ?, compaction_model = ?, skills = ?, mcp_servers = ?,"
                " searchable_mcp_servers = ?, code_mode = ? WHERE id = ?",
                (name, avatar, definition.description, definition.system_prompt,
                 definition.model, definition.reasoning_effort, definition.context_window,
                 definition.compaction_keep_tokens, definition.compaction_model,
                 json.dumps(definition.skills), json.dumps(definition.mcp_servers),
                 json.dumps(definition.searchable_mcp_servers), int(definition.code_mode), identity),
            )
            if current["workers"] != list(definition.workers):
                self._connection.execute("DELETE FROM agent_workers WHERE agent_id = ?", (identity,))
                self._connection.executemany(
                    "INSERT INTO agent_workers (agent_id, worker_id, position) VALUES (?, ?, ?)",
                    [(identity, worker, position) for position, worker in enumerate(definition.workers)],
                )
            return self.agent(identity), self._resource_changed(identity, "updated")

    def memory_author(self, identity: str, version: str) -> str | None:
        """只有正文版本仍匹配最后一次受管写入时才归属其修改者。"""
        row = self._connection.execute(
            "SELECT version, updated_by FROM memory_metadata WHERE agent_id = ?", (identity,)
        ).fetchone()
        return row[1] if row is not None and row[0] == version else None

    def record_memory_change(
        self, identity: str, version: str, updated_by: str, conversation_id: str | None,
    ) -> None:
        """文件已保存后，将作者与全部通知原子提交；失败必须交由网关停服。"""
        with self._connection:
            self._require_agent(identity)
            if self.agent_deleting(identity):
                raise RuntimeError(f"Agent 正在删除：{identity}")
            self._connection.execute(
                "INSERT INTO memory_metadata (agent_id, version, updated_by) VALUES (?, ?, ?)"
                " ON CONFLICT(agent_id) DO UPDATE SET version = excluded.version,"
                " updated_by = excluded.updated_by",
                (identity, version, updated_by),
            )
            now = time.time()
            self._insert(
                None, "resource.changed", {"kind": "memory", "id": identity, "op": "updated"},
                None, now,
            )
            if conversation_id is not None and self._connection.execute(
                "SELECT 1 FROM conversations WHERE id = ? AND NOT EXISTS"
                " (SELECT 1 FROM deleting_conversations WHERE id = ?)",
                (conversation_id, conversation_id),
            ).fetchone() is not None:
                self._insert(
                    conversation_id, "memory.updated",
                    {"agent_id": identity, "version": version, "summary": "已记住"},
                    None, now,
                )
                self._connection.execute(
                    "UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id)
                )

    def begin_delete_agent(self, identity: str) -> None:
        """跨库清理前持久化删除意图；重启后仍须从此意图继续，重复调用不重置状态。"""
        with self._connection:
            self._require_agent(identity)
            self._connection.execute(
                "INSERT OR IGNORE INTO deleting_agents (id) VALUES (?)", (identity,)
            )

    def pending_agent_deletions(self) -> list[str]:
        return [row[0] for row in self._connection.execute("SELECT id FROM deleting_agents ORDER BY rowid")]

    def agent_deleting(self, identity: str) -> bool:
        return self._connection.execute(
            "SELECT 1 FROM deleting_agents WHERE id = ?", (identity,)
        ).fetchone() is not None

    def deleted_agent_event(self, identity: str) -> Event | None:
        row = self._connection.execute(
            "SELECT e.seq, e.conversation_id, e.type, e.data, e.at, e.client_id"
            " FROM deleted_agents d JOIN events e ON e.seq = d.event_seq WHERE d.id = ?",
            (identity,),
        ).fetchone()
        return _event(row) if row else None

    def finish_delete_agent(self, identity: str) -> Event:
        """仅在对话/外部成员引用都已清理后原子删除，并永久保存删除墓碑供重试。"""
        with self._connection:
            if (event := self.deleted_agent_event(identity)) is not None:
                return event
            if not self.agent_deleting(identity):
                raise UnknownAgent(identity)
            if self.conversations(identity):
                raise RuntimeError(f"Agent 仍有对话：{identity}")
            # 外部成员引用由 FK 拒绝；失败时关系、设置及事件整体回滚。
            # 定义级联清理运行记录；删除通知与 Agent 墓碑同事务提交。
            for (schedule_id,) in self._connection.execute(
                "SELECT id FROM schedules WHERE agent_id = ? ORDER BY rowid", (identity,)
            ):
                deleted = self._schedule_event(schedule_id, "deleted")
                self._connection.execute(
                    "INSERT INTO deleted_schedules (id, event_seq) VALUES (?, ?)",
                    (schedule_id, deleted.seq),
                )
            self._connection.execute("DELETE FROM agent_workers WHERE agent_id = ?", (identity,))
            self._connection.execute("DELETE FROM deleting_agents WHERE id = ?", (identity,))
            self._connection.execute("DELETE FROM agents WHERE id = ?", (identity,))
            self._connection.execute(
                "DELETE FROM settings WHERE key = 'main_agent' AND value = ?", (identity,)
            )
            event = self._resource_changed(identity, "deleted")
            self._connection.execute(
                "INSERT INTO deleted_agents (id, event_seq) VALUES (?, ?)", (identity, event.seq)
            )
            return event

    def agents(self) -> list[dict]:
        """首页视图（ADR-0022 约定 9）：身份、显示信息、直接委派对象 id 和从对话派生的字段。

        排序按“产品活动”（见 HOME_EVENT_TYPES）：有活动的按最近一条活动倒序排在前面；
        没有活动的（从没对话过，或只有还没发过消息的空对话）在后面，保持导入顺序——
        它们没有活动时间可比，稳定的创建次序比按名字排更不易跳动。
        """
        items = self._agent_items(None)
        items.sort(key=lambda item: (item["_activity_seq"] is None, -(item["_activity_seq"] or 0)))
        for item in items:
            del item["_activity_seq"]
        return items

    def agent_item(self, identity: str) -> dict | None:
        """单个 Agent 的列表项；只读取这个 Agent 相关的数据。"""
        items = self._agent_items(identity)
        if not items:
            return None
        del items[0]["_activity_seq"]
        return items[0]

    def _agent_items(self, only: str | None) -> list[dict]:
        """列表项（含内部排序键 _activity_seq）。only 限定单个 Agent，None 为全部。

        “最近对话”取该 Agent 作为入口、最近一次有产品活动的对话；摘要给出那条事件的 seq 和时间，
        seq 用于比较新鲜度，时间只用于展示（墙上时间可能回拨）。
        状态变化和已读不是活动：它们不改变排序、摘要选哪个对话和时间（状态字段仍是对话当前状态）。
        一个对话都没有活动（刚新建、还没发消息）时，若 Agent 只有这类空对话，摘要指向其中最新创建的，
        让点首页一行有地方可去；此时没有活动时间，也不参与排序——与“新建对话不回首页”一致。
        有活动的对话存在时，空对话不会成为摘要：它没有可显示的内容。
        """
        placeholders = ", ".join("?" for _ in HOME_EVENT_TYPES)
        activity_filter = (
            f"(e.type IN ({placeholders}) OR (e.type = 'browser_task.updated'"
            " AND json_extract(e.data, '$.entered_requested') = 1))"
            " AND json_extract(e.data, '$.timeline_ids') IS NULL"
        )
        where, params = ("WHERE a.id = ?", (only,)) if only is not None else ("", ())
        rows = self._connection.execute(
            "SELECT a.id, a.name, a.avatar, a.description,"
            # 在首页：没移出过，或移出后它作为入口的对话里有产品意义上的新事件。
            " a.hidden_after_seq IS NULL OR EXISTS (SELECT 1 FROM events e JOIN conversations c"
            "  ON c.id = e.conversation_id WHERE c.agent_id = a.id AND e.seq > a.hidden_after_seq"
            f"  AND {activity_filter})"
            f" FROM agents a {where} ORDER BY a.rowid",
            (*HOME_EVENT_TYPES, *params),
        ).fetchall()
        # 每个对话最后一次活动：SQLite 对单个 MAX 的裸列取最大行的值，at 即那条事件的时间。
        activity = {
            conversation_id: (seq, at)
            for conversation_id, seq, at in self._connection.execute(
                "SELECT e.conversation_id, MAX(e.seq), e.at FROM events e JOIN conversations c"
                f" ON c.id = e.conversation_id WHERE {activity_filter}"
                + (" AND c.agent_id = ?" if only is not None else "")
                + " GROUP BY e.conversation_id",
                (*HOME_EVENT_TYPES, *((only,) if only is not None else ())),
            )
        }
        workers = self._workers(only)
        conversations: dict[str, list[dict]] = {}
        for conversation in self.conversations(only):
            conversations.setdefault(conversation["agent_id"], []).append(conversation)
        items = []
        for identity, name, avatar, description, home in rows:
            own = conversations.get(identity, [])
            active = [c for c in own if c["id"] in activity]
            if active:
                latest = max(active, key=lambda c: activity[c["id"]][0])
                activity_seq, activity_at = activity[latest["id"]]
            else:
                latest = max(own, key=lambda c: c["created_at"], default=None)
                activity_seq = activity_at = None
            items.append({
                "id": identity, "name": name, "avatar": avatar, "description": description,
                "workers": workers.get(identity, []),
                "home": bool(home),
                "latest_conversation": None if latest is None else {
                    "id": latest["id"], "title": latest["title"], "last_text": latest["last_text"],
                    "last_activity_seq": activity_seq, "last_activity_at": activity_at, "status": latest["status"],
                },
                "unread": any(conversation["unread"] for conversation in own),
                "_activity_seq": activity_seq,
            })
        return items

    def _require_agent(self, identity: str) -> None:
        if self._connection.execute("SELECT 1 FROM agents WHERE id = ?", (identity,)).fetchone() is None:
            raise UnknownAgent(identity)

    def hide_agent(self, identity: str) -> Event | None:
        """移出首页：记下当前全局 seq，之后它的对话里有更大 seq 的新事件才回到首页。

        已经不在首页时什么也不做并返回 None（幂等）；移出后又因新事件回到首页的，可以再次移出。
        成功时记录 resource.changed，让其他设备重新拉取；该事件不属于任何对话，不会把它判回首页。
        """
        item = self.agent_item(identity)
        if item is None:
            raise UnknownAgent(identity)
        if not item["home"]:
            return None
        with self._connection:
            self._connection.execute(
                "UPDATE agents SET hidden_after_seq = ? WHERE id = ?", (self.last_seq(), identity)
            )
            return self._resource_changed(identity, "hidden")

    def unhide_agent(self, identity: str) -> Event | None:
        """回到首页：清除移出记录。本来就没有移出记录时什么也不做并返回 None（幂等）。"""
        self._require_agent(identity)
        with self._connection:
            cursor = self._connection.execute(
                "UPDATE agents SET hidden_after_seq = NULL WHERE id = ? AND hidden_after_seq IS NOT NULL",
                (identity,),
            )
            return self._resource_changed(identity, "unhidden") if cursor.rowcount else None

    def _resource_changed(
        self, agent_id: str, op: str, client_id: str | None = None
    ) -> Event:
        return self._insert(
            None, "resource.changed", {"kind": "agent", "id": agent_id, "op": op},
            client_id, time.time(),
        )

    def agent(self, identity: str) -> dict | None:
        """详情：完整定义 + 直接委派对象 + member_of（由其他 Agent 的 workers 反查，不存储）。"""
        row = self._connection.execute(
            "SELECT id, name, avatar, description, system_prompt, model, reasoning_effort,"
            " context_window, compaction_keep_tokens, compaction_model,"
            " mcp_servers, searchable_mcp_servers, skills, code_mode, environment"
            " FROM agents WHERE id = ?",
            (identity,),
        ).fetchone()
        if row is None:
            return None
        (_, name, avatar, description, system_prompt, model, effort, context_window,
         keep_tokens, compaction_model, mcp, searchable, skills, code_mode, environment) = row
        return {
            "id": identity, "name": name, "avatar": avatar, "description": description,
            "system_prompt": system_prompt, "model": model, "reasoning_effort": effort,
            "context_window": context_window, "compaction_keep_tokens": keep_tokens,
            "compaction_model": compaction_model,
            "mcp_servers": json.loads(mcp), "searchable_mcp_servers": json.loads(searchable),
            "skills": json.loads(skills), "code_mode": bool(code_mode), "environment": environment,
            "workers": self._workers(identity).get(identity, []),
            "member_of": [
                member for (member,) in self._connection.execute(
                    "SELECT w.agent_id FROM agent_workers w JOIN agents a ON a.id = w.agent_id"
                    " WHERE w.worker_id = ? ORDER BY a.rowid",
                    (identity,),
                )
            ],
        }

    def _workers(self, only: str | None = None) -> dict[str, list[str]]:
        """Agent → 直接委派对象 id（按 position）；only 限定为单个 Agent。"""
        where, params = ("WHERE agent_id = ?", (only,)) if only is not None else ("", ())
        workers: dict[str, list[str]] = {}
        for agent_id, worker_id in self._connection.execute(
            f"SELECT agent_id, worker_id FROM agent_workers {where} ORDER BY agent_id, position", params
        ):
            workers.setdefault(agent_id, []).append(worker_id)
        return workers

    # ---- 定时：定义、执行事实与事件在同一个同步库中 ----

    def schedule(self, identity: str, *, internal: bool = False) -> dict | None:
        row = self._connection.execute(
            "SELECT id, agent_id, name, content, rule, timezone, enabled, next_run_at,"
            " processed_through, created_at, updated_at FROM schedules WHERE id = ?", (identity,)
        ).fetchone()
        if row is None:
            return None
        detail = dict(zip(
            ("id", "agent_id", "name", "content", "rule", "timezone", "enabled", "next_run_at",
             "processed_through", "created_at", "updated_at"), row,
        ))
        detail["rule"] = json.loads(detail["rule"])
        detail["enabled"] = bool(detail["enabled"])
        # 单次结束以 UTC 和已处理边界判定；DST 回拨或电脑校时不能使已运行的定义复活。
        detail["ended"] = (
            not detail["enabled"] and detail["rule"]["kind"] == "once"
            and next_run_at(
                detail["rule"], detail["timezone"],
                max(time.time(), detail["processed_through"] if detail["processed_through"] is not None else -math.inf),
            ) is None
        )
        if not internal:
            del detail["processed_through"]
        return detail

    def schedules(self, agent_id: str) -> list[dict]:
        return [
            self.schedule(identity) for (identity,) in self._connection.execute(
                "SELECT id FROM schedules WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC",
                (agent_id,),
            )
        ]

    def due_schedules(self, now: float) -> list[dict]:
        return [
            self.schedule(identity, internal=True) for (identity,) in self._connection.execute(
                "SELECT id FROM schedules WHERE enabled = 1 AND next_run_at <= ?"
                " ORDER BY next_run_at, rowid", (now,),
            )
        ]

    def replay_create_schedule(self, client_id: str) -> tuple[dict, Event] | None:
        event = self.by_client_id(client_id)
        if event is None:
            return None
        if (event.type, event.data.get("kind"), event.data.get("op")) != (
            "resource.changed", "schedule", "created",
        ):
            raise ClientIdConflict("client_id 已用于其他命令")
        row = self._connection.execute(
            "SELECT detail FROM created_schedule_results WHERE client_id = ? AND event_seq = ?",
            (client_id, event.seq),
        ).fetchone()
        if row is None:
            raise RuntimeError("定时创建事件缺少原始响应")
        return json.loads(row[0]), event

    def _schedule_event(self, identity: str, op: str, client_id: str | None = None) -> Event:
        return self._insert(
            None, "resource.changed", {"kind": "schedule", "id": identity, "op": op},
            client_id, time.time(),
        )

    def create_schedule(
        self, identity: str, agent_id: str, fields: dict, client_id: str,
    ) -> tuple[dict, Event, bool]:
        """原子写入定义和首次响应；删除意图在同一个同步事务内挡住创建。"""
        with self._connection:
            if replay := self.replay_create_schedule(client_id):
                return *replay, False
            self._require_agent(agent_id)
            if self.agent_deleting(agent_id):
                raise UnknownAgent(agent_id)
            now = time.time()
            self._connection.execute(
                "INSERT INTO schedules"
                " (id, agent_id, name, content, rule, timezone, enabled, next_run_at,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (identity, agent_id, fields["name"], fields["content"],
                 json.dumps(fields["rule"], ensure_ascii=False), fields["timezone"],
                 int(fields["enabled"]), fields["next_run_at"], now, now),
            )
            detail = self.schedule(identity)
            event = self._schedule_event(identity, "created", client_id)
            self._connection.execute(
                "INSERT INTO created_schedule_results (client_id, event_seq, detail) VALUES (?, ?, ?)",
                (client_id, event.seq, json.dumps(detail, ensure_ascii=False)),
            )
            return detail, event, True

    def update_schedule(self, identity: str, fields: dict) -> tuple[dict, Event | None]:
        with self._connection:
            current = self.schedule(identity, internal=True)
            if current is None:
                raise UnknownSchedule(identity)
            if self.agent_deleting(current["agent_id"]):
                raise UnknownSchedule(identity)
            editable = ("name", "content", "rule", "timezone", "enabled", "next_run_at")
            if all(current[key] == fields[key] for key in editable):
                del current["processed_through"]
                return current, None
            self._connection.execute(
                "UPDATE schedules SET name = ?, content = ?, rule = ?, timezone = ?,"
                " enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
                (fields["name"], fields["content"], json.dumps(fields["rule"], ensure_ascii=False),
                 fields["timezone"], int(fields["enabled"]), fields["next_run_at"], time.time(), identity),
            )
            return self.schedule(identity), self._schedule_event(identity, "updated")

    def deleted_schedule_event(self, identity: str) -> Event | None:
        row = self._connection.execute(
            "SELECT e.seq, e.conversation_id, e.type, e.data, e.at, e.client_id"
            " FROM deleted_schedules d JOIN events e ON e.seq = d.event_seq WHERE d.id = ?",
            (identity,),
        ).fetchone()
        return _event(row) if row else None

    def delete_schedule(self, identity: str) -> Event:
        with self._connection:
            if event := self.deleted_schedule_event(identity):
                return event
            current = self.schedule(identity)
            if current is None or self.agent_deleting(current["agent_id"]):
                raise UnknownSchedule(identity)
            self._connection.execute("DELETE FROM schedules WHERE id = ?", (identity,))
            event = self._schedule_event(identity, "deleted")
            self._connection.execute(
                "INSERT INTO deleted_schedules (id, event_seq) VALUES (?, ?)", (identity, event.seq)
            )
            return event

    def schedule_runs(
        self, identity: str, *, before: int | None = None, limit: int = 20,
    ) -> list[dict]:
        if self.schedule(identity) is None:
            raise UnknownSchedule(identity)
        rows = self._connection.execute(
            "SELECT id, schedule_id, scheduled_at, started_at, finished_at, status, reason,"
            " conversation_id, name, content, missed_before FROM schedule_runs"
            " WHERE schedule_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
            (identity, before if before is not None else 2**63 - 1, limit),
        )
        keys = ("id", "schedule_id", "scheduled_at", "started_at", "finished_at", "status",
                "reason", "conversation_id", "name", "content", "missed_before")
        return [dict(zip(keys, row)) for row in rows]

    def _trim_schedule_runs(self, identity: str) -> None:
        """运行中的记录不裁剪；只保留最近 100 条终态，处理边界独立于历史。"""
        self._connection.execute(
            "DELETE FROM schedule_runs WHERE schedule_id = ? AND status != 'running'"
            " AND id NOT IN (SELECT id FROM schedule_runs WHERE schedule_id = ?"
            " AND status != 'running' ORDER BY id DESC LIMIT 100)",
            (identity, identity),
        )

    def recover_schedule_runs(self, *, now: float) -> None:
        """重启发现的未结算执行只标失败，不重新投递。"""
        with self._connection:
            affected = [
                row[0] for row in self._connection.execute(
                    "SELECT DISTINCT schedule_id FROM schedule_runs WHERE status = 'running'"
                )
            ]
            self._connection.execute(
                "UPDATE schedule_runs SET status = 'failed', reason = 'gateway_restarted',"
                " finished_at = ? WHERE status = 'running'", (now,),
            )
            for identity in affected:
                self._trim_schedule_runs(identity)
                self._schedule_event(identity, "updated")

    def finish_schedule_run(self, conversation_id: str, status: str, reason: str | None = None) -> None:
        """首次根任务终态固定；后续续聊或重复回调不覆盖。"""
        if status not in ("completed", "failed", "cancelled"):
            raise ValueError("根任务尚未结算")
        with self._connection:
            row = self._connection.execute(
                "SELECT schedule_id FROM schedule_runs"
                " WHERE conversation_id = ? AND status = 'running'", (conversation_id,),
            ).fetchone()
            if row is None:
                return
            self._connection.execute(
                "UPDATE schedule_runs SET status = ?, reason = ?, finished_at = ?"
                " WHERE conversation_id = ? AND status = 'running'",
                (status, reason, time.time(), conversation_id),
            )
            self._trim_schedule_runs(row[0])
            self._schedule_event(row[0], "updated")

    def consume_schedule(
        self, identity: str, scheduled_at: float, *, now: float, missed_before: float | None = None,
        missed_reason: str | None = None,
    ) -> tuple[dict | None, int | None]:
        """消费一个到期点（或一段错过区间）：运行、来源对话、事件、处理边界一并提交。

        missed_before 是严格右开边界；计算下一点只需从边界前进一次，不枚举停机积压。
        返回 (新对话或 None, run_id 或 None)；已编辑/删除/暂停的旧扫描结果不生效。
        """
        with self._connection:
            current = self.schedule(identity, internal=True)
            if (current is None or not current["enabled"] or current["next_run_at"] != scheduled_at
                    or self.agent_deleting(current["agent_id"])):
                return None, None
            if missed_before is None and not scheduled_at <= now < scheduled_at + 60:
                return None, None
            if missed_before is None:
                next_due = next_run_at(current["rule"], current["timezone"], scheduled_at)
                boundary = scheduled_at
            else:
                if not scheduled_at < missed_before:
                    return None, None
                # 严格右开区间；即使计划点恰好在边界也留给正常轮询。
                boundary = math.nextafter(missed_before, -math.inf)
                next_due = next_run_at(
                    current["rule"], current["timezone"], missed_before, inclusive=True
                )
            cursor = self._connection.execute(
                "INSERT INTO schedule_runs"
                " (schedule_id, scheduled_at, started_at, finished_at, status, reason,"
                " name, content, missed_before) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (identity, scheduled_at, None if missed_before is not None else now,
                 now if missed_before is not None else None,
                 "missed" if missed_before is not None else "running",
                 missed_reason, current["name"], current["content"], missed_before),
            )
            run_id = cursor.lastrowid
            conversation = None
            if missed_before is None:
                origin = {
                    "schedule_id": identity, "run_id": run_id,
                    "name": current["name"], "scheduled_at": scheduled_at,
                }
                conversation_id = uuid4().hex
                self._insert_conversation(
                    conversation_id, current["name"], current["agent_id"], now,
                    source="schedule", schedule_origin=origin,
                )
                self._connection.execute(
                    "UPDATE schedule_runs SET conversation_id = ? WHERE id = ?",
                    (conversation_id, run_id),
                )
                self._insert(conversation_id, "schedule.triggered", origin, None, now)
                self._insert(conversation_id, "message.user", {"text": current["content"]}, None, now)
                conversation = self.conversation(conversation_id)
            self._connection.execute(
                "UPDATE schedules SET enabled = ?, next_run_at = ?, processed_through = ?,"
                " updated_at = ? WHERE id = ?",
                (int(next_due is not None) if current["rule"]["kind"] == "once"
                 else int(current["enabled"]), next_due,
                 max(current["processed_through"] if current["processed_through"] is not None
                     else -math.inf, boundary), now, identity),
            )
            self._trim_schedule_runs(identity)
            self._schedule_event(identity, "updated")
            return conversation, run_id

    # ---- 对话 ----

    # ---- 协作会话（ADR-0043） ----
    # events.conversation_id 始终是根；timeline_ids 明确事件在哪些聊天页显示。
    # 无 timeline_ids 的既有事件只属于根。一个投递只存一次，可出现在两个成员时间线。
    def _working_task_branches(self, root_id: str | None = None) -> set[str]:
        """Include settled ancestors of running/waiting tasks; client lists are only partial trees."""
        rows = self._connection.execute(
            "WITH RECURSIVE active(task_id) AS ("
            " SELECT task_id FROM task_conversations WHERE status IN ('running', 'waiting')"
            " AND (? IS NULL OR root_id = ?)"
            " UNION SELECT t.creator_task_id FROM task_conversations t JOIN active a ON t.task_id = a.task_id)"
            " SELECT task_id FROM active", (root_id, root_id),
        )
        return {row[0] for row in rows}

    def _branch_activity(self, task_id: str, root_id: str) -> dict[str, bool]:
        """State-event projection only; ancestor activity must not widen message/unread routing."""
        working = self._working_task_branches(root_id)
        ancestors = self._connection.execute(
            "WITH RECURSIVE ancestors(task_id, creator_task_id) AS ("
            " SELECT task_id, creator_task_id FROM task_conversations WHERE task_id = ?"
            " UNION SELECT t.task_id, t.creator_task_id FROM task_conversations t"
            " JOIN ancestors a ON t.task_id = a.creator_task_id)"
            " SELECT task_id FROM ancestors", (task_id,),
        )
        return {row[0]: row[0] in working for row in ancestors}

    def create_task_conversation(
        self, task_id: str, root_id: str, creator_task_id: str,
        creator_agent_id: str, agent_id: str, summary: str,
    ) -> Event:
        now = time.time()
        title = " ".join(summary.strip().splitlines())[:200]
        with self._connection:
            self._connection.execute(
                "INSERT INTO task_conversations"
                " (task_id, root_id, creator_task_id, creator_agent_id, agent_id, title, status, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)",
                (task_id, root_id, creator_task_id, creator_agent_id, agent_id, title, now, now),
            )
            return self._insert(root_id, "task.created", {
                "task_id": task_id, "creator_task_id": creator_task_id,
                "creator_agent_id": creator_agent_id, "agent_id": agent_id,
                "title": title, "summary": summary, "status": "running",
                "timeline_ids": [creator_task_id, task_id],
                "branch_activity": self._branch_activity(task_id, root_id),
            }, None, now)

    def task_conversation(self, task_id: str) -> dict | None:
        rows = self.task_conversations(task_id=task_id)
        return rows[0] if rows else None

    def task_conversations(
        self, *, agent_id: str | None = None, creator_agent_id: str | None = None,
        task_id: str | None = None,
    ) -> list[dict]:
        rows = self._connection.execute(
            "SELECT t.task_id, t.root_id, t.creator_task_id, t.creator_agent_id, t.agent_id,"
            " t.title, t.status, t.error, t.read_seq, t.created_at, t.updated_at, c.title,"
            " EXISTS (SELECT 1 FROM events e, json_each(e.data, '$.timeline_ids') j"
            "  WHERE e.conversation_id = t.root_id AND j.value = t.task_id AND e.seq > t.read_seq"
            "  AND (e.type IN ('message.task', 'message.agent')"
            "       OR (e.type = 'task.status' AND json_extract(e.data, '$.status') IN ('failed', 'unavailable'))))"
            " FROM task_conversations t JOIN conversations c ON c.id = t.root_id"
            " WHERE (? IS NULL OR t.agent_id = ?) AND (? IS NULL OR t.creator_agent_id = ?)"
            " AND (? IS NULL OR t.task_id = ?)"
            " AND (? IS NOT NULL OR NOT EXISTS (SELECT 1 FROM deleting_conversations d WHERE d.id = t.root_id))"
            " ORDER BY t.updated_at DESC, t.task_id",
            (agent_id, agent_id, creator_agent_id, creator_agent_id, task_id, task_id, task_id),
        ).fetchall()
        keys = ("task_id", "root_id", "creator_task_id", "creator_agent_id", "agent_id",
                "title", "status", "error", "read_seq", "created_at", "updated_at", "root_title", "unread")
        result = []
        working = self._working_task_branches()
        for row in rows:
            item = dict(zip(keys, row))
            item.update(id=item["task_id"], kind="task", initiator=item["creator_agent_id"],
                        recipient=item["agent_id"], unread=bool(item["unread"]),
                        branch_working=item["task_id"] in working)
            result.append(item)
        return result

    def received_conversations(self, agent_id: str) -> list[dict]:
        roots = [
            {**item, "kind": "conversation", "root_id": item["id"], "task_id": item["id"],
             "initiator": "human", "recipient": agent_id}
            for item in self.conversations(agent_id)
            if self.deletion_threads(item["id"]) is None
        ]
        return sorted(
            [*roots, *self.task_conversations(agent_id=agent_id)],
            key=lambda item: (-item["updated_at"], item["id"]),
        )

    def append_task_event(
        self, task_id: str, kind: str, data: dict, *, client_id: str | None = None,
        timeline_ids: list[str] | None = None,
    ) -> tuple[Event, bool]:
        """只改变所属成员的活动；不让协作消息点亮首页。命令键仍在全局去重。"""
        task = self.task_conversation(task_id)
        if task is None:
            raise LookupError(task_id)
        if client_id is not None and (existing := self.by_client_id(client_id)) is not None:
            if existing.type != kind or existing.data.get("task_id") != task_id:
                raise ClientIdConflict("client_id 已用于其他会话或其他命令")
            return existing, False
        now = time.time()
        timelines = timeline_ids if timeline_ids is not None else [task_id]
        with self._connection:
            event = self._insert(task["root_id"], kind, {
                **data, "task_id": task_id, "timeline_ids": timelines,
            }, client_id, now)
            self._connection.executemany(
                "UPDATE task_conversations SET updated_at = ? WHERE task_id = ?",
                [(now, identity) for identity in timelines],
            )
        return event, True

    def append_task_message(
        self, task_id: str, data: dict, attachments: list, *, timeline_ids: list[str],
    ) -> tuple[Event, list[Event]]:
        """已接受的 Agent 投递与文件同事务保存；文件归发送任务，展示范围归会话两端。"""
        task = self.task_conversation(task_id)
        if task is None:
            raise LookupError(task_id)
        now = time.time()
        with self._connection:
            files = self._register_delivery_files(
                task["root_id"], data["sender_task_id"], data["sender_agent_id"], attachments, now,
            )
            event = self._insert(task["root_id"], "message.task", {
                **data, "attachments": [record for record, _ in files],
                "task_id": task_id, "timeline_ids": timeline_ids,
            }, None, now)
            notices = self._file_produced_events(event, files)
            self._connection.executemany(
                "UPDATE task_conversations SET updated_at = ? WHERE task_id = ?",
                [(now, identity) for identity in timeline_ids],
            )
        return event, notices

    def set_task_status(self, task_id: str, status: str, error: str | None = None) -> Event | None:
        task = self.task_conversation(task_id)
        if task is None or (task["status"], task["error"]) == (status, error):
            return None
        now = time.time()
        with self._connection:
            self._connection.execute(
                "UPDATE task_conversations SET status = ?, error = ?, updated_at = ? WHERE task_id = ?",
                (status, error, now, task_id),
            )
            return self._insert(task["root_id"], "task.status", {
                "task_id": task_id, "status": status, "error": error,
                "creator_task_id": task["creator_task_id"], "agent_id": task["agent_id"],
                "timeline_ids": [task["creator_task_id"], task_id],
                "branch_activity": self._branch_activity(task_id, task["root_id"]),
            }, None, now)

    def task_history(self, task_id: str, *, before: int | None = None, limit: int = 50) -> list[Event]:
        task = self.task_conversation(task_id)
        if task is None:
            raise LookupError(task_id)
        return self.history(task["root_id"], before=before, limit=limit, timeline_id=task_id)

    def mark_task_read(self, task_id: str, seq: int) -> Event | None:
        if seq > self.last_seq():
            raise InvalidReadPosition(f"已读位置 {seq} 超过最新事件 {self.last_seq()}")
        task = self.task_conversation(task_id)
        if task is None:
            raise LookupError(task_id)
        if seq <= task["read_seq"]:
            return None
        with self._connection:
            self._connection.execute("UPDATE task_conversations SET read_seq = ? WHERE task_id = ?", (seq, task_id))
            return self._insert(task["root_id"], "task.read", {
                "task_id": task_id, "seq": seq, "timeline_ids": [task_id],
            }, None, time.time())

    def create_conversation(self, title: str, agent_id: str) -> tuple[dict, Event]:
        """新建对话并记录 conversation.created；对话 ID 同时是运行时的根任务 ID。

        agent_id 是这个对话的入口 Agent，创建后不变；Agent 不存在时抛 UnknownAgent。
        """
        if self._connection.execute("SELECT 1 FROM agents WHERE id = ?", (agent_id,)).fetchone() is None:
            raise UnknownAgent(agent_id)
        identity = uuid4().hex
        now = time.time()
        with self._connection:
            event = self._insert_conversation(identity, title, agent_id, now)
        return self.conversation(identity), event

    def _insert_conversation(
        self, identity: str, title: str, agent_id: str, now: float,
        *, source: str = "user", schedule_origin: dict | None = None,
    ) -> Event:
        """不提交：触发路径须与运行记录、首条消息共用外层事务。"""
        self._connection.execute(
            "INSERT INTO conversations"
            " (id, agent_id, title, created_at, updated_at, source, schedule_origin)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (identity, agent_id, title, now, now, source,
             json.dumps(schedule_origin, ensure_ascii=False) if schedule_origin else None),
        )
        return self._insert(
            identity, "conversation.created",
            {"title": title, "agent_id": agent_id, "source": source, "schedule_origin": schedule_origin},
            None, now,
        )

    def rename_conversation(self, identity: str, title: str) -> tuple[dict, Event | None]:
        """显式改名持久标记即使标题未改变；只有实际变化才产生同步事件。"""
        title = title.strip()
        if not title or len(title) > 200:
            raise ValueError("title 必须为非空且不超过 200 个字符")
        with self._connection:
            current = self._connection.execute(
                "SELECT title FROM conversations WHERE id = ? AND NOT EXISTS"
                " (SELECT 1 FROM deleting_conversations WHERE id = ?)", (identity, identity)
            ).fetchone()
            if current is None:
                raise LookupError(identity)
            now = time.time()
            self._connection.execute(
                "UPDATE conversations SET title = ?, title_user_edited = 1,"
                " updated_at = CASE WHEN title = ? THEN updated_at ELSE ? END WHERE id = ?",
                (title, title, now, identity),
            )
            event = self._insert(identity, "conversation.updated", {"title": title}, None, now) if current[0] != title else None
        return self.conversation(identity), event

    def append_user_message(
        self, identity: str, text: str, client_id: str, attachments: list[dict] | None = None,
        *, ui_submission: dict | None = None,
    ) -> tuple[Event, bool]:
        """首条已接收消息原子生成标题；client_id 重放保留第一次的完整附件与提交快照。"""
        with self._connection:
            if (existing := self.by_client_id(client_id)) is not None:
                previous = existing.data.get("ui_submission")
                if (existing.conversation_id != identity or existing.type != "message.user"
                        or (previous is None) != (ui_submission is None)
                        or (previous is not None and
                            (previous["message_seq"], previous["block"])
                            != (ui_submission["message_seq"], ui_submission["block"]))):
                    raise ClientIdConflict("client_id 已用于其他对话或其他命令")
                return existing, False
            now = time.time()
            data = {"text": text, "attachments": attachments or []}
            if ui_submission is not None:
                data["ui_submission"] = ui_submission
            event = self._insert(identity, "message.user", data, client_id, now)
            self._connection.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?", (now, identity)
            )
            row = self._connection.execute(
                "SELECT title, title_user_edited FROM conversations WHERE id = ?", (identity,)
            ).fetchone()
            if row == ("新对话", 0):
                first = self._connection.execute(
                    "SELECT seq FROM events WHERE conversation_id = ? AND type = 'message.user'"
                    " ORDER BY seq LIMIT 1", (identity,)
                ).fetchone()[0]
                if first == event.seq:
                    title = " ".join(text.strip().splitlines()).strip()[:20]
                    if title and title != row[0]:
                        self._connection.execute(
                            "UPDATE conversations SET title = ? WHERE id = ?", (title, identity)
                        )
                        self._insert(identity, "conversation.updated", {"title": title}, None, time.time())
            return event, True

    def begin_delete(self, identity: str, threads: set[str]) -> None:
        """破坏性跨库操作前持久化线程集合；重试绝不重新从已遗忘的 Manager 推导。"""
        with self._connection:
            if self._connection.execute("SELECT 1 FROM conversations WHERE id = ?", (identity,)).fetchone() is None:
                raise LookupError(identity)
            self._connection.execute(
                "INSERT OR IGNORE INTO deleting_conversations (id, threads) VALUES (?, ?)",
                (identity, json.dumps(sorted(threads | {identity}))),
            )

    def extend_delete_threads(self, identity: str, stopped: list[str]) -> None:
        """停止屏障已封住分支后补录竞争窗口中新生的后代，检查点删除前持久提交。"""
        with self._connection:
            threads = set(self.deletion_threads(identity))
            threads.update(stopped)
            self._connection.execute(
                "UPDATE deleting_conversations SET threads = ? WHERE id = ?",
                (json.dumps(sorted(threads)), identity),
            )

    def deletion_threads(self, identity: str) -> list[str] | None:
        row = self._connection.execute(
            "SELECT threads FROM deleting_conversations WHERE id = ?", (identity,)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def pending_deletions(self) -> list[str]:
        return [row[0] for row in self._connection.execute("SELECT id FROM deleting_conversations")]

    def deleted_event(self, identity: str) -> Event | None:
        row = self._connection.execute(
            "SELECT e.seq, e.conversation_id, e.type, e.data, e.at, e.client_id"
            " FROM deleted_conversations d JOIN events e ON e.seq = d.event_seq WHERE d.id = ?",
            (identity,),
        ).fetchone()
        return _event(row) if row else None

    def append_agent_message(
        self, conversation_id: str, task_id: str, text: str, agent: str | None,
        attachments: list, *, ui: list[dict] | None = None,
        ui_files: dict[int, set[str]] | None = None,
        draft_id: str | None = None, status: str = "completed",
    ) -> tuple[Event, list[Event]]:
        """Persist one terminal draft outcome, files and UI references atomically.

        Interrupted previews have no delivered files or interactive UI. A replay of
        the same host draft identity returns its first terminal outcome.
        """
        if status not in {"completed", "interrupted"}:
            raise ValueError("未知的消息终态")
        if status == "interrupted" and (draft_id is None or attachments or ui or ui_files):
            raise ValueError("中断预览需要草稿身份且不能交付附件或界面")
        with self._connection:
            if draft_id is not None:
                row = self._connection.execute(
                    "SELECT seq, conversation_id, type, data, at, client_id FROM events"
                    " WHERE type = 'message.agent' AND json_extract(data, '$.draft_id') = ?",
                    (draft_id,),
                ).fetchone()
                if row is not None:
                    return _event(row), []
            now = time.time()
            agent_id = agent or self._connection.execute(
                "SELECT agent_id FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()[0]
            files = self._register_delivery_files(conversation_id, task_id, agent_id, attachments, now)
            registered_images: dict[str, str] = {}
            for record, requested_path in files:
                if record["media_type"].startswith("image/"):
                    registered_images.setdefault(requested_path, record["id"])
            data = {"text": text, "attachments": [record for record, _ in files], "status": status}
            child = self.task_conversation(task_id)
            if child is not None:
                data.update(task_id=task_id, timeline_ids=[task_id])
            if draft_id is not None:
                data["draft_id"] = draft_id
            if agent is not None:
                data["agent"] = agent
            if ui is not None:
                data["ui"] = []
                for block in ui:
                    metadata = block.copy()
                    paths = (ui_files or {}).get(block["block"], set()) if block["valid"] else set()
                    if paths:
                        mapped = {path: registered_images[path] for path in paths if path in registered_images}
                        if len(mapped) != len(paths):
                            raise ValueError("界面图片未登记为本条消息的图片附件")
                        metadata["files"] = mapped
                    data["ui"].append(metadata)
            event = self._insert(conversation_id, "message.agent", data, None, now)
            notices = self._file_produced_events(event, files)
            if child is not None:
                self._connection.execute(
                    "UPDATE task_conversations SET updated_at = ? WHERE task_id = ?", (now, task_id)
                )
                self._insert(conversation_id, "message.task_preview", {
                    "task_id": task_id, "agent_id": agent, "text": text.split("\n", 1)[0],
                    "message_seq": event.seq, "status": status, "timeline_ids": [conversation_id],
                }, None, now)
            else:
                self._connection.execute(
                    "UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id)
                )
            return event, notices

    def _register_delivery_files(
        self, conversation_id: str, task_id: str, agent_id: str, attachments: list, now: float,
    ) -> list[tuple[dict, str]]:
        """登记已校验文件及预检时的环境；路径不能跨环境解释，调用方持有消息事务。"""
        files = []
        for attachment in attachments:
            record = {
                "id": "f_" + uuid4().hex, "name": attachment.name, "size": attachment.size,
                "media_type": attachment.media_type, "conversation_id": conversation_id,
                "agent_id": agent_id, "task_id": task_id, "created_at": now, "source": "agent",
                "remote_environment": attachment.remote_environment,
            }
            self._connection.execute(
                "INSERT INTO files (id, path, remote_environment, name, size, media_type, conversation_id,"
                " agent_id, task_id, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent')",
                (record["id"], attachment.path, attachment.remote_environment, attachment.name,
                 attachment.size, attachment.media_type, conversation_id, agent_id, task_id, now),
            )
            files.append((record, attachment.requested_path or attachment.path))
        return files

    def _file_produced_events(self, message: Event, files: list[tuple[dict, str]]) -> list[Event]:
        # 文件通知与正文拥有相同展示范围；不能让成员附件单独泄漏到根时间线或首页。
        scope = {key: message.data[key] for key in ("task_id", "timeline_ids") if key in message.data}
        return [
            self._insert(message.conversation_id, "file.produced",
                         {"file": record, "message_id": str(message.seq), **scope}, None, message.at)
            for record, _ in files
        ]

    def create_upload(
        self, identity: str, conversation_id: str, agent_id: str, filename: str, filetype: str, length: int, metadata: str,
    ) -> dict:
        """Persist the upload identity before exposing its URL; its file id is immutable."""
        with self._connection:
            self._connection.execute(
                "INSERT INTO uploads (id, conversation_id, agent_id, filename, filetype, length, metadata, offset, created_at, file_id)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                (identity, conversation_id, agent_id, filename, filetype, length, metadata, time.time(), "f_" + uuid4().hex),
            )
        return self.upload(identity)

    def upload(self, identity: str) -> dict | None:
        row = self._connection.execute(
            "SELECT id, conversation_id, agent_id, filename, filetype, length, offset, created_at,"
            " destination, file_id, completed, metadata, terminating FROM uploads WHERE id = ?", (identity,),
        ).fetchone()
        return dict(zip(("id", "conversation_id", "agent_id", "filename", "filetype", "length", "offset",
                         "created_at", "destination", "file_id", "completed", "metadata", "terminating"), row)) if row else None

    def pending_uploads(self) -> list[str]:
        return [row[0] for row in self._connection.execute("SELECT id FROM uploads WHERE completed = 0 AND terminating = 0")]

    def terminating_uploads(self) -> list[str]:
        return [row[0] for row in self._connection.execute("SELECT id FROM uploads WHERE terminating = 1")]

    def completed_uploads(self) -> list[str]:
        return [row[0] for row in self._connection.execute("SELECT id FROM uploads WHERE completed = 1 AND terminating = 0")]

    def expired_uploads(self, cutoff: float) -> list[str]:
        return [row[0] for row in self._connection.execute(
            "SELECT id FROM uploads WHERE completed = 0 AND terminating = 0 AND created_at < ?", (cutoff,),
        )]

    def advance_upload(self, identity: str, offset: int) -> None:
        with self._connection:
            self._connection.execute("UPDATE uploads SET offset = ? WHERE id = ?", (offset, identity))

    def reserve_upload_destination(self, identity: str, destination: str) -> None:
        with self._connection:
            self._connection.execute(
                "UPDATE uploads SET destination = ? WHERE id = ?", (destination, identity),
            )

    def finish_upload(self, identity: str, destination: str) -> dict:
        """File row and completed marker commit together after the filesystem link is durable."""
        with self._connection:
            upload = self.upload(identity)
            if upload["completed"]:
                return self.file(upload["file_id"])[0]
            conversation = self.conversation(upload["conversation_id"])
            agent = self.agent(upload["agent_id"])
            record = {
                "id": upload["file_id"], "name": Path(destination).name, "size": upload["length"],
                "media_type": upload["filetype"], "conversation_id": upload["conversation_id"] if conversation else None,
                "agent_id": upload["agent_id"] if agent else None, "task_id": upload["conversation_id"],
                "created_at": time.time(), "source": "user_upload", "remote_environment": None,
            }
            self._connection.execute(
                "INSERT INTO files (id, path, name, size, media_type, conversation_id,"
                " agent_id, task_id, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (record["id"], destination, record["name"], record["size"], record["media_type"],
                 record["conversation_id"], record["agent_id"], record["task_id"], record["created_at"], record["source"]),
            )
            self._connection.execute("UPDATE uploads SET completed = 1 WHERE id = ?", (identity,))
            return record

    def mark_upload_terminating(self, identity: str) -> None:
        """Commit deletion intent before the spool or staging link can disappear."""
        with self._connection:
            self._connection.execute("UPDATE uploads SET terminating = 1 WHERE id = ?", (identity,))

    def remove_upload(self, identity: str) -> None:
        with self._connection:
            self._connection.execute("DELETE FROM uploads WHERE id = ?", (identity,))

    def user_uploads(self, conversation_id: str, identities: list[str]) -> list[tuple[dict, str]]:
        """Accept only registered user uploads of this live conversation, in request order."""
        rows = []
        for identity in identities:
            file = self.file(identity)
            if file is None or file[0]["source"] != "user_upload" or file[0]["conversation_id"] != conversation_id:
                raise ValueError("附件必须是本对话已完成的用户上传")
            rows.append(file)
        return rows

    def file(self, identity: str) -> tuple[dict, str] | None:
        row = self._connection.execute(
            "SELECT id, path, name, size, media_type, conversation_id, agent_id, task_id, created_at, source, remote_environment"
            " FROM files WHERE id = ?", (identity,)
        ).fetchone()
        if row is None:
            return None
        identity, path, name, size, media_type, conversation_id, agent_id, task_id, created_at, source, remote_environment = row
        return ({
            "id": identity, "name": name, "size": size, "media_type": media_type,
            "conversation_id": conversation_id, "agent_id": agent_id,
            "task_id": task_id, "created_at": created_at, "source": source,
            "remote_environment": remote_environment,
        }, path)

    def search(self, query: str, agent_id: str | None, limit: int, offset: int) -> dict:
        """统一 LIKE 字面子串搜索、稳定的跨类别分页；返回当前事件快照编号。"""
        pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query_sql = r"""
                SELECT 0 AS category, 'agent' AS kind, a.id, a.name AS title,
                       a.description AS text, NULL AS conversation_id, a.id AS agent_id,
                       0 AS seq, a.rowid AS recent
                  FROM agents a
                 WHERE (a.name LIKE ? ESCAPE '\' OR a.description LIKE ? ESCAPE '\')
                   AND (? IS NULL OR a.id = ?)
                UNION ALL
                SELECT 1, 'conversation', c.id, c.title, '', c.id, c.agent_id, 0, c.created_at
                  FROM conversations c
                 WHERE c.title LIKE ? ESCAPE '\' AND (? IS NULL OR c.agent_id = ?)
                   AND NOT EXISTS (SELECT 1 FROM deleting_conversations d WHERE d.id = c.id)
                UNION ALL
                SELECT 2, 'message', CAST(e.seq AS TEXT), COALESCE(t.title, c.title),
                       json_extract(e.data, '$.text'), c.id, COALESCE(t.agent_id, c.agent_id), e.seq, e.seq
                  FROM events e JOIN conversations c ON c.id = e.conversation_id
                  LEFT JOIN task_conversations t ON t.task_id = json_extract(e.data, '$.task_id')
                 WHERE e.type IN ('message.user', 'message.agent', 'message.task')
                   AND json_extract(e.data, '$.text') LIKE ? ESCAPE '\'
                   AND (? IS NULL OR COALESCE(t.agent_id, c.agent_id) = ?)
                   AND NOT EXISTS (SELECT 1 FROM deleting_conversations d WHERE d.id = c.id)
                UNION ALL
                SELECT 3, 'file', f.id, f.name, '', f.conversation_id, f.agent_id,
                       0, f.created_at
                  FROM files f
                 WHERE f.name LIKE ? ESCAPE '\'
                   AND (? IS NULL OR f.agent_id = ?)
            """
        params = (pattern, pattern, agent_id, agent_id, pattern, agent_id, agent_id,
                  pattern, agent_id, agent_id, pattern, agent_id, agent_id)
        total = self._connection.execute(
            "SELECT COUNT(*) FROM (" + query_sql + ")", params
        ).fetchone()[0]
        rows = self._connection.execute(
            "SELECT kind, id, title, text, conversation_id, agent_id, seq,"
            " (SELECT json_extract(e.data, '$.task_id') FROM events e WHERE e.seq = items.seq) FROM ("
            + query_sql + ") items ORDER BY category, recent DESC, id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        results = []
        for kind, identity, title, text, conversation_id, source_agent, seq, task_id in rows:
            if kind == "agent":
                results.append({"kind": kind, "id": identity, "title": title, "text": text})
            elif kind == "conversation":
                results.append({"kind": kind, "id": identity, "title": title, "agent_id": source_agent})
            elif kind == "message":
                results.append({
                    "kind": kind, "id": identity, "title": title, "text": text,
                    "conversation_id": conversation_id, "agent_id": source_agent, "seq": seq,
                    **({"task_id": task_id} if task_id is not None else {}),
                })
            else:
                results.append({"kind": kind, "id": identity, "title": title, "file": self.file(identity)[0]})
        return {"results": results, "total": total, "as_of_seq": self.last_seq()}

    def finish_delete(self, identity: str) -> Event:
        """移除对话及其历史，保留不属于对话的全局墓碑；同一事务提交。"""
        with self._connection:
            if (event := self.deleted_event(identity)) is not None:
                return event
            row = self._connection.execute(
                "SELECT agent_id FROM conversations WHERE id = ? AND EXISTS"
                " (SELECT 1 FROM deleting_conversations WHERE id = ?)", (identity, identity)
            ).fetchone()
            if row is None:
                raise LookupError(identity)
            self._connection.execute("DELETE FROM browser_tasks WHERE root_id = ?", (identity,))
            self._connection.execute("DELETE FROM events WHERE conversation_id = ?", (identity,))
            self._connection.execute("DELETE FROM deleting_conversations WHERE id = ?", (identity,))
            self._connection.execute("DELETE FROM conversations WHERE id = ?", (identity,))
            event = self._insert(
                None, "conversation.deleted", {"id": identity, "agent_id": row[0]}, None, time.time()
            )
            self._connection.execute(
                "INSERT INTO deleted_conversations (id, event_seq) VALUES (?, ?)", (identity, event.seq)
            )
            return event

    def conversation(self, identity: str) -> dict | None:
        rows = self._conversations("WHERE c.id = ?", (identity,))
        return rows[0] if rows else None

    def conversations(self, agent_id: str | None = None) -> list[dict]:
        """全部对话，或只列某个入口 Agent 的；不存在的 Agent 得到空列表（由调用方决定是否当作错误）。"""
        if agent_id is None:
            return self._conversations("", ())
        return self._conversations("WHERE c.agent_id = ?", (agent_id,))

    def _conversations(self, where: str, params: tuple) -> list[dict]:
        # 未读：存在已读位置之后的 Agent 消息。最后一条摘要取最近的用户或 Agent 消息。
        rows = self._connection.execute(
            "SELECT c.id, c.agent_id, c.title, c.created_at, c.updated_at, c.read_seq, c.status,"
            " c.source, c.schedule_origin,"
            " EXISTS (SELECT 1 FROM events e WHERE e.conversation_id = c.id"
            "  AND e.type = 'message.agent' AND json_extract(e.data, '$.timeline_ids') IS NULL AND e.seq > c.read_seq),"
            " (SELECT e.data FROM events e WHERE e.conversation_id = c.id"
            "  AND json_extract(e.data, '$.timeline_ids') IS NULL"
            "  AND e.type IN ('message.user', 'message.agent') ORDER BY e.seq DESC LIMIT 1)"
            f" FROM conversations c {where} ORDER BY c.updated_at DESC",
            params,
        ).fetchall()
        return [
            {
                "id": identity,
                "agent_id": agent_id,
                "title": title,
                "created_at": created_at,
                "source": source,
                "schedule_origin": json.loads(schedule_origin) if schedule_origin else None,
                "updated_at": updated_at,
                "read_seq": read_seq,
                "status": status,
                "unread": bool(unread),
                "last_text": json.loads(last)["text"] if last else None,
            }
            for identity, agent_id, title, created_at, updated_at, read_seq, status, source,
            schedule_origin, unread, last in rows
        ]

    # ---- 浏览器任务：租约状态与全局事件同一事务提交 ----

    def browser_labels(self, root_id: str, entry_agent_id: str, agent_id: str) -> tuple[str, str, str] | None:
        """Display labels are gateway-owned and may change while a lease remains open."""
        return self._connection.execute(
            "SELECT c.title, entry.name, holder.name FROM conversations c"
            " LEFT JOIN agents entry ON entry.id = ? LEFT JOIN agents holder ON holder.id = ?"
            " WHERE c.id = ?", (entry_agent_id, agent_id, root_id),
        ).fetchone()

    def browser_task(self, identity: str) -> dict | None:
        row = self._connection.execute(
            "SELECT snapshot FROM browser_tasks WHERE id = ?", (identity,)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def browser_tasks(self, agent_id: str | None = None, entry_agent_id: str | None = None) -> list[dict]:
        filters = []
        params = []
        if agent_id is not None:
            filters.append("agent_id = ?")
            params.append(agent_id)
        if entry_agent_id is not None:
            filters.append("entry_agent_id = ?")
            params.append(entry_agent_id)
        rows = self._connection.execute(
            "SELECT snapshot FROM browser_tasks"
            + (" WHERE " + " AND ".join(filters) if filters else "")
            + " ORDER BY updated_at DESC, rowid DESC", params,
        )
        return [json.loads(snapshot) for (snapshot,) in rows]

    def record_browser_task(self, snapshot: dict) -> Event | None:
        """运行时事件与当前投影原子写入；删除意图之后不再产生属于旧对话的事件。"""
        root_id = snapshot["root_id"]
        with self._connection:
            if self._connection.execute(
                "SELECT 1 FROM conversations WHERE id = ? AND NOT EXISTS"
                " (SELECT 1 FROM deleting_conversations WHERE id = ?)",
                (root_id, root_id),
            ).fetchone() is None:
                return None
            current = self.browser_task(snapshot["id"])
            if current == snapshot:
                return None
            now = time.time()
            self._connection.execute(
                "INSERT INTO browser_tasks"
                " (id, task_id, root_id, agent_id, entry_agent_id, state, snapshot, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id,"
                " state = excluded.state, snapshot = excluded.snapshot, updated_at = excluded.updated_at",
                (snapshot["id"], snapshot["task_id"], root_id, snapshot["agent_id"],
                 snapshot["entry_agent_id"], snapshot["state"],
                 json.dumps(snapshot, ensure_ascii=False), now),
            )
            # Transition metadata belongs to the durable event, not the snapshot:
            # title/URL updates while requested must not count as new activity.
            data = {**snapshot, "entered_requested": snapshot["state"] == "requested"
                    and (current is None or current["state"] != "requested")}
            return self._insert(root_id, "browser_task.updated", data, None, now)

    def record_takeover_end(self, data: dict) -> Event | None:
        """交还文字属于根对话的聊天历史，而不是只推临时通知。"""
        root_id = data["root_id"]
        with self._connection:
            if self._connection.execute(
                "SELECT 1 FROM conversations WHERE id = ? AND NOT EXISTS"
                " (SELECT 1 FROM deleting_conversations WHERE id = ?)",
                (root_id, root_id),
            ).fetchone() is None:
                return None
            now = time.time()
            return self._insert(root_id, "takeover.ended", data, None, now)

    def invalidate_browser_tasks(self) -> int:
        """网关新进程启动时旧运行时的活跃租约全部失效，保留结束原因并可续传。"""
        with self._connection:
            rows = self._connection.execute(
                "SELECT snapshot FROM browser_tasks WHERE state != 'released' ORDER BY rowid"
            ).fetchall()
            for (serialized,) in rows:
                snapshot = json.loads(serialized)
                snapshot.update(state="released", epoch=snapshot["epoch"] + 1,
                                pages=[], current=None, reason="网关重启，浏览器任务已结束", requested_reason=None)
                now = time.time()
                self._connection.execute(
                    "UPDATE browser_tasks SET state = 'released', snapshot = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(snapshot, ensure_ascii=False), now, snapshot["id"]),
                )
                self._insert(snapshot["root_id"], "browser_task.updated", snapshot, None, now)
            return len(rows)

    def replay_browser_command(self, client_id: str, identity: str, action: str) -> dict | None:
        row = self._connection.execute(
            "SELECT browser_task_id, action, response FROM browser_command_results WHERE client_id = ?",
            (client_id,),
        ).fetchone()
        if row is not None:
            if row[:2] != (identity, action):
                raise ClientIdConflict("client_id 已用于其他浏览器命令")
            return json.loads(row[2])
        if self.by_client_id(client_id) is not None:
            raise ClientIdConflict("client_id 已用于其他命令")
        return None

    def record_browser_command(self, client_id: str, identity: str, action: str, snapshot: dict) -> None:
        with self._connection:
            self._connection.execute(
                "INSERT INTO browser_command_results (client_id, browser_task_id, action, response)"
                " VALUES (?, ?, ?, ?)",
                (client_id, identity, action, json.dumps({"browser_task": snapshot}, ensure_ascii=False)),
            )

    def set_status(self, conversation_id: str, status: str) -> Event | None:
        """更新当前状态并记录 conversation.status；状态没变时不写。

        状态列与事件同一事务提交：列表给出当前值，事件流给出变化，两者不会对不上。
        """
        current = self._connection.execute(
            "SELECT status FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()[0]
        if current == status:
            return None
        now = time.time()
        with self._connection:
            self._connection.execute(
                "UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?",
                (status, now, conversation_id),
            )
            return self._insert(conversation_id, "conversation.status", {"status": status}, None, now)

    def record_compaction(self, conversation_id: str, task_id: str, payload: dict) -> tuple[Event | None, bool]:
        """仅给未删除的根会话追加压缩通知；成功按检查点事件身份去重且不改变会话活动。"""
        kind = "context.compacted" if payload["status"] == "completed" else "context.compaction_failed"
        event_id = payload.get("event_id") if kind == "context.compacted" else None
        with self._connection:
            if event_id is not None:
                row = self._connection.execute(
                    "SELECT e.seq, e.conversation_id, e.type, e.data, e.at, e.client_id"
                    " FROM compaction_events AS c JOIN events AS e ON e.seq = c.event_seq"
                    " WHERE c.task_id = ? AND c.event_id = ?", (task_id, event_id),
                ).fetchone()
                if row is not None:
                    existing = _event(row)
                    if existing.conversation_id != conversation_id:
                        raise RuntimeError("压缩事件与根对话归属不一致")
                    return existing, False
            alive = self._connection.execute(
                "SELECT 1 FROM conversations WHERE id = ? AND NOT EXISTS"
                " (SELECT 1 FROM deleting_conversations WHERE id = ?)",
                (conversation_id, conversation_id),
            ).fetchone()
            if alive is None:
                return None, False
            now = time.time()
            event = self._insert(conversation_id, kind, payload, None, now)
            if event_id is not None:
                self._connection.execute(
                    "INSERT INTO compaction_events (task_id, event_id, event_seq) VALUES (?, ?, ?)",
                    (task_id, event_id, event.seq),
                )
            return event, True

    def append(
        self,
        conversation_id: str,
        type: str,
        data: dict,
        *,
        client_id: str | None = None,
    ) -> tuple[Event, bool]:
        """追加持久事件，返回 (事件, 是否新写入)。client_id 已存在时返回原事件，不再写入。"""
        if client_id is not None and (existing := self.by_client_id(client_id)) is not None:
            if existing.conversation_id != conversation_id or existing.type != type:
                raise ClientIdConflict("client_id 已用于其他对话或其他命令")
            return existing, False
        now = time.time()
        with self._connection:
            event = self._insert(conversation_id, type, data, client_id, now)
            self._connection.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id)
            )
        return event, True

    def _insert(self, conversation_id, type, data, client_id, at) -> Event:
        cursor = self._connection.execute(
            "INSERT INTO events (conversation_id, type, data, at, client_id) VALUES (?, ?, ?, ?, ?)",
            (conversation_id, type, json.dumps(data, ensure_ascii=False), at, client_id),
        )
        return Event(cursor.lastrowid, conversation_id, type, data, at, client_id)

    def message_at(self, conversation_id: str, seq: int) -> Event | None:
        """按全局 seq 查本对话的消息；与分页历史无关，旧卡片始终可提交。"""
        row = self._connection.execute(
            "SELECT seq, conversation_id, type, data, at, client_id FROM events"
            " WHERE conversation_id = ? AND seq = ? AND type = 'message.agent'",
            (conversation_id, seq),
        ).fetchone()
        return _event(row) if row else None

    def ui_submission(self, conversation_id: str, message_seq: int, block: int) -> Event | None:
        """用已有 message.user 事件判定同一块是否已提交，不受时间线分页大小限制。"""
        row = self._connection.execute(
            "SELECT seq, conversation_id, type, data, at, client_id FROM events"
            " WHERE conversation_id = ? AND type = 'message.user'"
            " AND json_extract(data, '$.ui_submission.message_seq') = ?"
            " AND json_extract(data, '$.ui_submission.block') = ? ORDER BY seq LIMIT 1",
            (conversation_id, message_seq, block),
        ).fetchone()
        return _event(row) if row else None

    def by_client_id(self, client_id: str) -> Event | None:
        if self._connection.execute(
            "SELECT 1 FROM browser_command_results WHERE client_id = ?", (client_id,)
        ).fetchone() is not None:
            raise ClientIdConflict("client_id 已用于浏览器命令")
        row = self._connection.execute(
            "SELECT seq, conversation_id, type, data, at, client_id FROM events WHERE client_id = ?",
            (client_id,),
        ).fetchone()
        return _event(row) if row else None

    def after(self, seq: int, limit: int = 500) -> list[Event]:
        """全局事件流续传：seq 之后的持久事件，按 seq 升序。"""
        rows = self._connection.execute(
            "SELECT seq, conversation_id, type, data, at, client_id FROM events"
            " WHERE seq > ? ORDER BY seq LIMIT ?",
            (seq, limit),
        ).fetchall()
        return [_event(row) for row in rows]

    def history(
        self, conversation_id: str, *, before: int | None = None, limit: int = 50,
        timeline_id: str | None = None,
    ) -> list[Event]:
        """聊天历史向前翻页：before 之前最近的 limit 条，按 seq 升序返回。"""
        rows = self._connection.execute(
            "SELECT seq, conversation_id, type, data, at, client_id FROM events"
            " WHERE conversation_id = ? AND seq < ?"
            " AND ((json_extract(data, '$.timeline_ids') IS NULL AND ? = conversation_id)"
            " OR EXISTS (SELECT 1 FROM json_each(data, '$.timeline_ids') WHERE value = ?))"
            " ORDER BY seq DESC LIMIT ?",
            (conversation_id, before if before is not None else 2**63 - 1,
             timeline_id or conversation_id, timeline_id or conversation_id, limit),
        ).fetchall()
        return [_event(row) for row in reversed(rows)]

    def last_seq(self) -> int:
        return self._connection.execute("SELECT COALESCE(MAX(seq), 0) FROM events").fetchone()[0]

    def mark_read(self, conversation_id: str, seq: int) -> Event | None:
        """已读位置只前进不后退，且不能超过最新事件；前进时记录 conversation.read，让其他设备的红点同步。

        允许指向未来会让之后的新消息一直不算未读，而位置又不能后退，错误无法自行纠正。
        """
        if seq > self.last_seq():
            raise InvalidReadPosition(f"已读位置 {seq} 超过最新事件 {self.last_seq()}")
        current = self._connection.execute(
            "SELECT read_seq FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()[0]
        if seq <= current:
            return None
        now = time.time()
        with self._connection:
            self._connection.execute(
                "UPDATE conversations SET read_seq = ? WHERE id = ?", (seq, conversation_id)
            )
            # 已读不改变对话的更新时间，否则读一下就会把对话顶到列表最前。
            return self._insert(conversation_id, "conversation.read", {"seq": seq}, None, now)

    def close(self) -> None:
        self._connection.close()


def _event(row) -> Event:
    seq, conversation_id, type, data, at, client_id = row
    return Event(seq, conversation_id, type, json.loads(data), at, client_id)
