import argparse
import asyncio
import json
from pathlib import Path
from uuid import uuid4

from langchain.messages import AIMessage, ToolMessage

from wandrun.metrics import RunMetrics
from wandrun.runtime.session import open_runtime
from wandrun.runtime.workers import SchedulerFailure
from wandrun.runtime.workspace import Workspace
from wandrun.terminal.chat import TerminalOutput, chat


async def run_agent(
    thread_id: str | None = None,
    *,
    workspace: Path = Path("."),
    agents_config: Path | None = None,
    mcps_config: Path | None = None,
    environments_config: Path | None = None,
) -> None:
    workspace = Workspace(workspace)
    if workspace.ensure_config():
        print(f"已生成默认配置：{workspace.runtime_dir}")
    if thread_id is None:
        thread_id = uuid4().hex
    print(f"对话数据库：{workspace.checkpoint_path}；对话 ID：{thread_id}")
    metrics = RunMetrics(workspace.runs_dir)
    print(f"运行 ID：{metrics.run_id}；请求用量日志：{metrics.log_path}")
    output = TerminalOutput()

    def on_update(task_id: str, chunk: dict) -> None:
        if task_id == thread_id:
            print_update(chunk)

    try:
        async with open_runtime(
            workspace,
            metrics=metrics,
            on_human=output.on_human,
            on_compaction=output.on_compaction,
            agents_config=agents_config,
            mcps_config=mcps_config,
            environments_config=environments_config,
            on_update=on_update,
        ) as runtime:
            await chat(
                runtime.workers,
                thread_id,
                output=output,
                metrics=metrics,
            )
    finally:
        totals = metrics.summary()
        print(
            "Token 汇总："
            + json.dumps(
                {
                    key: value
                    for key, value in totals.items()
                    if not key.startswith("by_")
                },
                ensure_ascii=False,
            )
        )
        print(f"详细统计：{metrics.summary_path}")


def print_update(chunk) -> None:
    """仅负责展示，不负责启动或调度 Agent。"""
    if chunk["type"] != "updates":
        return
    for node, data in chunk["data"].items():
        if not isinstance(data, dict):
            continue
        messages = data.get("messages")
        if not messages:
            continue
        message = messages[-1]
        if isinstance(message, AIMessage) and message.tool_calls:
            for tool_call in message.tool_calls:
                print(f"[{node}] 调用工具: {tool_call['name']}")
                print(f"  参数: {tool_call['args']}")
        elif isinstance(message, ToolMessage):
            print(f"[{node}] 工具结果: {message.content}")
        # 结构化正文经 on_human 交给终端展示，不在流更新里重复打印。


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--thread-id", help="指定已有对话 ID 续聊；不传则生成新的 UUID")
    parser.add_argument(
        "--workspace", type=Path, default=Path("."),
        help="Agent 工作的目录，配置和状态在其中的 .wandrun；默认当前目录，不存在 .wandrun 时生成默认配置",
    )
    parser.add_argument("--agents-config", type=Path)
    parser.add_argument("--mcps-config", type=Path)
    parser.add_argument("--environments-config", type=Path)
    args = parser.parse_args(argv)
    try:
        asyncio.run(
            run_agent(
                args.thread_id,
                workspace=args.workspace,
                agents_config=args.agents_config,
                mcps_config=args.mcps_config,
                environments_config=args.environments_config,
            )
        )
    except SchedulerFailure as error:
        notes = "".join(f"\n{note}" for note in getattr(error, "__notes__", ()))  # 如远端清理未确认
        raise SystemExit(f"运行已停止：{error}：{error.__cause__}{notes}") from error


if __name__ == "__main__":
    main()
