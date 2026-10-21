"""本机环境的命令工具：等待与执行分离，结果恰好交付一次（ADR-0017）。

exec_command 在等待期限内结算就直接返回结果；否则返回 process_id，执行继续由环境的执行表管理，
结算时把结果作为运行时反馈投递给 owner。等待到期和打断都只停止等待，不停止命令。
"""

import asyncio
from collections import Counter
from collections.abc import Callable
from pathlib import Path

from langchain.agents.middleware import AgentMiddleware
from langchain.tools import tool
from langchain_core.runnables import RunnableConfig

from wandrun.integrations.local_processes import Execution, ProcessTable
from wandrun.runtime.browser import BrowserRejected

DEFAULT_YIELD_SECONDS = 30
MAX_YIELD_SECONDS = 3600
# 通知里只放输出尾部；完整输出在日志中。
NOTICE_TAIL = 2000


class _Delivery:
    """结果交付规则的唯一所有者：结算时有工具调用在等，就由它们返回；没有人等，就通知 owner。

    一个工具调用停止等待（期限到、被取消）时，若执行恰好已结算而结果还没交给任何人，由这里补发通知。
    """

    def __init__(self, manager):
        self._manager = manager
        self._waiting: Counter[str] = Counter()

    def on_settled(self, execution: Execution) -> None:
        if not self._waiting[execution.process_id]:
            self._manager.notify(
                execution.owner,
                {"background_process": execution.result(tail_only=NOTICE_TAIL)},
            )

    def on_log_error(self, execution: Execution) -> None:
        self._manager.notify(execution.owner, {"background_process_log_error": {
            "process_id": execution.process_id,
            "log": str(execution.log_path),
            "note": "日志写入失败，之后的输出被丢弃；命令仍在运行。",
        }})

    async def wait(
        self,
        execution: Execution,
        timeout: float | None,
        *,
        on_interrupted: Callable[[], None] | None = None,
    ) -> dict | None:
        """等待结算，最多 timeout 秒；返回结果，期限到时返回 None。

        被取消时：已结算则交给通知（本调用不再返回它）；仍在运行则调用 on_interrupted，再传播取消。
        """
        process_id = execution.process_id
        self._waiting[process_id] += 1
        try:
            await asyncio.wait({execution.settled}, timeout=timeout)
        except asyncio.CancelledError:
            self._stop_waiting(process_id)
            if execution.settled.done():
                self.on_settled(execution)
            elif on_interrupted is not None:
                on_interrupted()
            raise
        self._stop_waiting(process_id)
        return execution.settled.result() if execution.settled.done() else None

    def _stop_waiting(self, process_id: str) -> None:
        self._waiting[process_id] -= 1
        if not self._waiting[process_id]:
            del self._waiting[process_id]


def _owner(config: RunnableConfig) -> str:
    owner = config.get("configurable", {}).get("thread_id")
    if not isinstance(owner, str) or not owner.strip():
        raise ValueError("命令工具需要调用方的 thread_id")
    return owner


def process_tools(manager, table: ProcessTable, *, files=None, browser=None) -> list:
    delivery = _Delivery(manager)

    @tool
    async def exec_command(
        command: str, config: RunnableConfig, yield_seconds: float = DEFAULT_YIELD_SECONDS
    ) -> dict:
        """在工作区运行 shell 命令，最多等待 yield_seconds 秒（默认 30，可为 0）。

        期限内结束：返回输出、exit_code 和清理情况。仍在运行：返回 process_id、已有输出和日志路径，
        命令继续运行，结束时结果会作为运行时反馈自动送达，不要轮询；用 read_file/grep 读日志，
        用 kill_process 停止。
        - 要让服务一直运行，直接用本工具启动它，不要在命令中加 `&`。shell 退出时，同一进程组中
          剩余的进程（包括 `cmd &`、`nohup cmd &`）会被终止。
        - 需要限时用 `timeout --foreground N 命令`；不带 --foreground 的 timeout 会脱离清理范围。
        - process_id 只在本次运行内有效。运行重启后旧句柄失效，旧进程可能仍存活，重新执行前先检查。
        """
        owner = _owner(config)
        if not 0 <= yield_seconds <= MAX_YIELD_SECONDS:
            return {"error": f"yield_seconds 必须在 0 到 {MAX_YIELD_SECONDS} 之间"}
        manager.ensure_active(owner)
        try:
            browser_env = await browser.command_environment(owner) if browser is not None else None
        except BrowserRejected as exc:
            return {"error": f"浏览器命令被拒绝：{exc}"}
        execution = table.start(
            command, owner, on_settled=delivery.on_settled, on_log_error=delivery.on_log_error,
            cwd=Path(files.directory(owner)) if files is not None and files.conversation_workdirs else None,
            env=browser_env,
        )

        def interrupted() -> None:
            if not manager.is_stopped(owner):
                # 打断只结束等待：续轮时告诉模型命令仍在运行（停止 owner 时命令随之收尾，不说明）。
                manager.add_feedback(owner, {"background_process": {
                    "process_id": execution.process_id,
                    "status": execution.state,
                    "log": str(execution.log_path),
                    "note": "等待被打断，命令仍在运行；结束时结果会自动送达，可用 kill_process 停止。",
                }})

        result = await delivery.wait(execution, yield_seconds, on_interrupted=interrupted)
        if result is not None:
            return result
        return {
            **execution.result(),
            "note": "命令仍在运行；结束时结果会自动送达，不要轮询。",
        }

    @tool
    async def kill_process(process_id: str, config: RunnableConfig) -> dict:
        """停止自己用 exec_command 启动、仍在运行的命令（终止其整个进程组），返回最终结果。"""
        owner = _owner(config)
        execution = table.get(process_id)
        if execution is None or execution.owner != owner:
            return {"process_id": process_id, "error": "未知或已结束的 process_id（只能停止自己启动的命令）"}
        if execution.state == "settled":
            return {"process_id": process_id, "error": "该命令已结算，结果已经交付"}
        execution.request_stop("kill_process")
        return await delivery.wait(execution, None)

    return [exec_command, kill_process]


class CommandMiddleware(AgentMiddleware):
    """每张角色图持有一对工具及其交付状态；借用执行表，不管理它的生命周期。"""

    def __init__(self, manager, table: ProcessTable, *, files=None, browser=None):
        super().__init__()
        self.tools = process_tools(manager, table, files=files, browser=browser)
