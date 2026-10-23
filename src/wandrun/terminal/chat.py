"""终端只负责输入、命令和状态展示，执行仍由 WorkerManager 管理。"""

import asyncio
import json

from wandrun.runtime.files import ResolvedAttachment
from wandrun.runtime.workers import SchedulerFailure, WorkerManager
from wandrun.metrics import RunMetrics



class TerminalOutput:
    """展示 human 消息和压缩通知；只有 human 消息改变下一条输入的回复目标。"""

    def __init__(self) -> None:
        self.reply_to: str | None = None

    def on_human(self, sender: str, text: str, attachments: list[ResolvedAttachment], draft_id: str | None = None) -> None:
        self.reply_to = sender
        print(f"\n[{sender} → human] {text}", flush=True)
        for file in attachments:
            print(f"  附件: {file.name} ({file.size} bytes, {file.media_type}) — {file.path}", flush=True)

    def on_compaction(self, task_id: str, event: dict) -> None:
        """显示已提交压缩或失败，不把系统通知送回 Worker 的收件箱。"""
        def one_line(value: object) -> str:
            return " ".join(str(value).splitlines())

        identity = f"Agent {one_line(event['agent_name'])}，任务 {one_line(task_id)}"
        if event["status"] == "completed":
            path = event.get("archive_path")
            archive = f"；历史：{one_line(path)}" if path else ""
            print(f"[系统] 已压缩上下文（{identity}）{archive}", flush=True)
        else:
            reason = f"{one_line(event['error'])}: {one_line(event['message'])}"
            print(f"[系统] 压缩未完成（{identity}）：{reason}", flush=True)


async def read_line() -> str:
    return await asyncio.to_thread(input, "用户消息：")


async def chat(
    manager: WorkerManager,
    thread_id: str,
    *,
    output: TerminalOutput,
    metrics: RunMetrics | None = None,
) -> None:
    """终端输入和状态展示；仅清理自身通知任务，不关闭调用方持有的 manager。"""
    print(
        "普通消息：启动或排队；/interrupt <消息>：打断并插入；/status：查询；/tokens：用量；/cancel：停止当前会话全部任务；/exit：退出；/help：帮助"
    )
    # 这些 Task 只等待并展示状态，不执行 Agent，也不管理它的调度。
    notices: set[asyncio.Task] = set()

    async def report_finished(target_id: str) -> None:
        status = await manager.wait(target_id)
        detail = f" {status['error']}" if "error" in status else ""
        print(f"\n[{status['status']}]{detail}", flush=True)

    async def report_failure() -> None:
        # 存储失败可能发生在后台（例如根任务已在 wait 时子任务提交失败），立即告诉用户。
        error = await manager.wait_failure()
        print(f"\n[failed] {error}：{error.__cause__}；请输入 /exit 退出后检查调度存储。", flush=True)

    async def report_cancel() -> None:
        print(json.dumps(await manager.cancel(thread_id), ensure_ascii=False), flush=True)


    notices.add(asyncio.create_task(report_failure()))
    try:
        while True:
            try:
                user_input = await read_line()
            except EOFError:
                return
            target_id = output.reply_to or thread_id
            command = user_input.strip()
            if not command:
                continue
            if command in {"exit", "/exit"}:
                return
            if command == "/cancel":
                output.reply_to = thread_id
                await report_cancel()
                continue
            if command == "/help":
                print(
                    "/status 查询当前回复目标；/tokens 查询本次运行用量；/cancel 停止根任务及全部后代并等待清理，回复目标重置为根任务；/exit 退出终端。"
                )
                print(
                    "运行中普通消息排队；本轮正常结束后若仍有消息，会自动启动下一轮。"
                )
                print(
                    "/interrupt <消息> 打断回复目标当前的执行（不停止它创建的任务），清理后带着这条消息继续。"
                )
                print(
                    "取消或失败不会清空消息；再次发送普通消息，会整理历史并重新运行。"
                )
                continue
            if command == "/status":
                print(json.dumps(manager.get(target_id), ensure_ascii=False))
                continue
            if command == "/tokens":
                if metrics is None:
                    print("当前入口未启用用量统计。")
                else:
                    print(json.dumps(metrics.summary(), ensure_ascii=False, indent=2))
                continue
            submit = manager.start
            if command == "/interrupt" or command.startswith("/interrupt "):
                user_input = command.removeprefix("/interrupt").strip()
                if not user_input:
                    print("用法：/interrupt <消息>")
                    continue
                submit = manager.interrupt
            elif command.startswith("/"):
                print("未知命令，请输入 /help。")
                continue

            try:
                launched = submit(user_input, target_id, direct_user=True)
            except ValueError as error:
                print(f"[rejected] {error}")
                continue
            except SchedulerFailure as error:
                print(f"[failed] {error}：{error.__cause__}；退出后检查调度存储。")
                return
            if launched.get("interrupted"):
                # 已有的完成提示会跟随打断后的续轮，不另建。
                print("[interrupted] 正在停止当前执行，之后带着这条消息继续。")
            elif launched.get("queued"):
                print(
                    "[queued] 已排队，将在下次模型调用前注入，或在本轮正常结束后自动续轮。"
                )
            else:
                print(f"[running] {target_id}")
                notice = asyncio.create_task(report_finished(target_id))
                notices.add(notice)
                notice.add_done_callback(notices.discard)
            # 不等待 Worker，立即读取下一条输入。
    finally:
        for notice in notices:
            notice.cancel()
        await asyncio.gather(*notices, return_exceptions=True)
