"""Gateway-backed native tool for scheduling a fresh Agent conversation."""

import asyncio
from hashlib import sha256
from typing import Annotated

from langchain.tools import BaseTool, InjectedToolCallId, tool
from langchain_core.runnables import RunnableConfig

from wandrun.gateway.schedules import InvalidSchedule
from wandrun.gateway.service import AgentConflict, Gateway
from wandrun.gateway.store import ClientIdConflict, UnknownAgent
from wandrun.runtime.workers import WorkerManager


def schedule_tools(gateway: Gateway, manager: WorkerManager) -> list[BaseTool]:
    """Bind schedule creation to the current runtime's task identities and Gateway."""

    @tool
    async def create_schedule(
        name: str,
        content: str,
        rule: dict,
        config: RunnableConfig,
        tool_call_id: Annotated[str, InjectedToolCallId],
        timezone: str | None = None,
    ) -> dict:
        """创建定时：到点后以当前 Agent 为入口新建对话，content 作为第一条消息。

        新对话不继承创建时的聊天历史，所以 content 必须包含未来完成任务所需的独立说明。
        rule 可为 {"kind":"once","local_at":"YYYY-MM-DDTHH:mm"}、
        {"kind":"daily","time":"HH:mm"}、
        {"kind":"weekly","time":"HH:mm","weekdays":[1,3,5]}（周一=1，周日=7），或
        {"kind":"cron","expression":"分 时 日 月 星期"}（标准五段 cron）。
        时间均按 timezone 的 IANA 时区解释；省略时使用电脑时区，无法识别时需明确传入。
        创建后即启用。每天/每周/cron 会自动安排后续触发，无需每次运行后重新创建。
        """
        task_id = config.get("configurable", {}).get("thread_id")
        if not isinstance(task_id, str) or not task_id.strip():
            raise ValueError("定时工具需要调用方的 thread_id")
        manager.ensure_active(task_id)
        if manager.get(task_id)["status"] != "running":
            raise asyncio.CancelledError()
        agent_id = manager.agent_name(task_id)
        client_id = "agent.schedule:" + sha256(
            f"{task_id}\0{tool_call_id}".encode("utf-8")
        ).hexdigest()
        fields = {"name": name, "content": content, "rule": rule}
        if timezone is not None:
            fields["timezone"] = timezone
        try:
            schedule, _, _ = gateway.create_schedule(agent_id, client_id, fields)
        except UnknownAgent:
            return {"error": "当前 Agent 已不存在或正在删除，不能创建定时"}
        except (InvalidSchedule, AgentConflict, ClientIdConflict) as error:
            return {"error": str(error)}
        return {
            "id": schedule["id"],
            "agent_id": schedule["agent_id"],
            "name": schedule["name"],
            "rule": schedule["rule"],
            "timezone": schedule["timezone"],
            "next_at": schedule["next_run_at"],
        }

    return [create_schedule]
