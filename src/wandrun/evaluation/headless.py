"""无人值守运行入口：单条 instruction、确定的生命周期和机器可读结果。"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from time import monotonic
from uuid import uuid4

from wandrun.integrations.codex_subscription import ReasoningEffort, is_retryable_model_error
from wandrun.metrics import RunMetrics
from wandrun.runtime.session import RuntimeCleanupError, open_runtime
from wandrun.runtime.workspace import Workspace
from wandrun.runtime.workers import WorkerManager


class LifecycleError(RuntimeError):
    """Agent 已停止推进，但不满足一次无人值守运行的结束条件。"""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def _wandrun_version() -> str:
    try:
        return version("wandrun")
    except PackageNotFoundError:
        return "unknown"


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)


def _describe(error: BaseException, *, with_type: bool = True) -> str:
    """异常正文连同附注（如打开环境失败时的清理问题）。"""
    text = f"{type(error).__name__}: {error}" if with_type else str(error)
    return "\n".join([text, *getattr(error, "__notes__", ())])


def _error_kind(error: BaseException) -> str:
    if isinstance(error, LifecycleError):
        return error.kind
    message = f"{type(error).__name__}: {error}".lower()
    if "凭据" in message or "http 401" in message or "http 403" in message:
        return "auth_failed"
    if is_retryable_model_error(error) or any(
        marker in message for marker in ("http 408", "http 409", "http 429", "http 5")
    ):
        return "network_failed"
    if any(
        marker in message
        for marker in (
            "connecterror",
            "connecttimeout",
            "readtimeout",
            "remoteprotocolerror",
            "network",
            "dns",
            "ssl",
            "sse 提前结束",
        )
    ):
        return "network_failed"
    return "agent_failed"


async def _wait_for_root(
    manager: WorkerManager, root_id: str, processes_pending=lambda: False
) -> dict:
    notifications_drained = False
    while True:
        root = manager.get(root_id)
        snapshot = manager.snapshot()
        status = root["status"]
        if status == "completed":
            live_workers = [item for item in snapshot["running"] if item != root_id]
            working = [item for item in live_workers if item not in snapshot["finishing"]]
            if working:
                raise LifecycleError(
                    "lifecycle_error",
                    "根任务完成时仍有运行中的 Worker: " + ", ".join(working),
                )
            if live_workers:
                notifications_drained = False
                # 最终回信先于发送方图的检查点提交；只等待收尾，不放宽工作中判定。
                await asyncio.sleep(0.05)
                continue
            if root_id in snapshot["queued"] or root_id in snapshot["inflight"]:
                raise LifecycleError("lifecycle_error", "根任务完成时仍有未处理消息")
            if not notifications_drained:
                # Task 已结束不代表它的 done callback 已执行。让已排队的失败/取消
                # 通知先唤醒调用方，再重新判断全局终态，不能把旧的根结果算作成功。
                notifications_drained = True
                await asyncio.sleep(0)
                continue
            return root
        notifications_drained = False
        if status == "failed":
            raise RuntimeError(root.get("error", "根任务失败"))
        if status == "cancelled":
            raise LifecycleError("cancelled", "根任务被取消")
        if (
            status == "waiting"
            and not snapshot["running"]
            and not snapshot["queued"]
            and not snapshot["inflight"]
            # 后台执行结算时把结果投递给 owner；仍有待交付结果的执行就不算卡死（ADR-0017）。
            and not processes_pending()
        ):
            raise LifecycleError("stalled", "所有任务均已停止，但根任务仍处于 wait")
        await asyncio.sleep(0.05)


async def run_headless(
    instruction: str,
    *,
    workspace: Path,
    state_dir: Path,
    output_dir: Path,
    result_path: Path,
    agents_config: Path,
    mcps_config: Path | None = None,
    environments_config: Path | None = None,
    model_name: str | None = None,
    reasoning_effort: ReasoningEffort | None = None,
    task_timeout: float,
    model_timeout: float,
    model_max_retries: int,
    cleanup_grace: float,
    max_model_requests: int,
    thread_id: str,
) -> tuple[dict, int]:
    started = monotonic()
    selected_workspace = Workspace(workspace)
    workspace = selected_workspace.root
    agents_config = agents_config.resolve()
    mcps_config = (mcps_config or agents_config.parent / "mcps.toml").resolve()
    environments_config = (
        environments_config or agents_config.parent / "environments.toml"
    ).resolve()
    state_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = state_dir / "checkpoints.sqlite"
    metrics = RunMetrics(output_dir / "runs")
    shown: list[dict] = []
    compacted_event_ids: set[str] = set()

    def on_compaction(_task_id: str, event: dict) -> None:
        # Only checkpoint-confirmed successes count; failures follow the existing
        # task outcome and never become a human delivery.
        if event["status"] == "completed":
            compacted_event_ids.add(event["event_id"])

    status = "agent_failed"
    error_text: str | None = None
    root_result: dict | None = None
    exit_code = 1
    main_agent: str | None = None
    agent_models: dict[str, dict[str, str | None]] = {}

    try:
        async with open_runtime(
            selected_workspace,
            metrics=metrics,
            on_human=lambda sender, text, attachments, draft_id: shown.append(
                {"sender": sender, "message": text,
                 "attachments": [
                     {"path": item.path, "name": item.name, "size": item.size, "media_type": item.media_type}
                     for item in attachments
                 ]}
            ),
            on_compaction=on_compaction,
            agents_config=agents_config,
            mcps_config=mcps_config,
            environments_config=environments_config,
            checkpoint_path=checkpoint_path,
            model_name=model_name,
            reasoning_effort=reasoning_effort,
            model_timeout=model_timeout,
            model_max_retries=model_max_retries,
            max_model_requests=max_model_requests,
            cleanup_timeout=cleanup_grace,
        ) as runtime:
            main_agent = runtime.main_agent
            agent_models = runtime.agent_models
            try:
                async with asyncio.timeout(task_timeout):
                    runtime.workers.start(instruction, thread_id, agent_name=main_agent)
                    root_result = await _wait_for_root(
                        runtime.workers, thread_id, runtime.processes_pending
                    )
                    if not any(item["sender"] == thread_id for item in shown):
                        raise LifecycleError(
                            "missing_final_output", "根任务完成但没有向 human 交付结果"
                        )
                status = "completed"
                exit_code = 0
            except TimeoutError:
                status = "timeout"
                error_text = f"任务超过 {task_timeout:g} 秒"
                exit_code = 124
            except Exception as error:  # 保存统计后再由退出码表达失败。
                status = _error_kind(error)
                error_text = _describe(error)
                exit_code = 4 if status == "stalled" else 1
    except RuntimeCleanupError as error:
        # 清理超时或远端清理未确认：保留原因与调用 ID。已有失败时保留原状态，把清理事实附在后面。
        if status == "completed":
            status = "cleanup_failed"
            error_text = _describe(error, with_type=False)
            exit_code = 1
        else:
            cleanup = f"清理：{_describe(error, with_type=False)}"
            error_text = f"{error_text}\n{cleanup}" if error_text else cleanup
    except Exception as error:
        status = _error_kind(error)
        error_text = _describe(error)
        exit_code = 1
    finally:
        usage = metrics.summary()
        result = {
            "schema_version": 1,
            "wandrun_version": _wandrun_version(),
            "wandrun_package_spec": os.environ.get("WANDRUN_PACKAGE_SPEC"),
            "status": status,
            "error": error_text,
            "thread_id": thread_id,
            "run_id": metrics.run_id,
            "workspace": str(workspace),
            "model": agent_models.get(main_agent, {}).get("model"),
            "reasoning_effort": agent_models.get(main_agent, {}).get("reasoning_effort"),
            "agent_models": agent_models,
            "main_agent": main_agent,
            "agents_config": str(agents_config),
            "mcps_config": str(mcps_config),
            "environments_config": str(environments_config),
            "task_timeout_seconds": task_timeout,
            "model_timeout_seconds": model_timeout,
            "model_max_retries": model_max_retries,
            "max_model_requests": max_model_requests,
            "elapsed_seconds": round(monotonic() - started, 3),
            "messages": shown,
            "compaction_count": len(compacted_event_ids),
            "root_result": root_result,
            "usage": usage,
            "metrics_summary_path": str(metrics.summary_path),
            "checkpoint_path": str(checkpoint_path),
        }
        _write_json(result_path, result)
    return result, exit_code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="wandrun")
    parser.add_argument("--version", action="version", version=_wandrun_version())
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run", help="无人值守执行一个任务")
    instruction = run.add_mutually_exclusive_group(required=True)
    instruction.add_argument("--instruction")
    instruction.add_argument("--instruction-file", type=Path)
    run.add_argument("--workspace", type=Path, required=True)
    run.add_argument("--state-dir", type=Path)
    run.add_argument("--output-dir", type=Path)
    run.add_argument("--result-json", type=Path)
    run.add_argument("--thread-id")
    run.add_argument("--model")
    run.add_argument(
        "--reasoning-effort",
        choices=("none", "minimal", "low", "medium", "high", "xhigh", "max"),
    )
    run.add_argument("--task-timeout-seconds", type=float, default=1200)
    run.add_argument("--model-timeout-seconds", type=float, default=90)
    run.add_argument("--model-max-retries", type=int, default=2)
    run.add_argument("--cleanup-grace-seconds", type=float, default=10)
    run.add_argument("--max-model-requests", type=int, default=120)
    run.add_argument("--agents-config", type=Path)
    run.add_argument("--mcps-config", type=Path)
    run.add_argument("--environments-config", type=Path)
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    selected_workspace = Workspace(args.workspace)
    workspace = selected_workspace.root
    invocation_id = uuid4().hex
    base = selected_workspace.evaluations_dir / invocation_id
    state_dir = (args.state_dir or base / "state").resolve()
    output_dir = (args.output_dir or base / "output").resolve()
    result_path = (args.result_json or output_dir / "result.json").resolve()
    if args.instruction_file is not None:
        instruction = args.instruction_file.read_text(encoding="utf-8")
    else:
        instruction = args.instruction
    if not instruction or not instruction.strip():
        raise SystemExit("instruction 不能为空")
    for name in (
        "task_timeout_seconds",
        "model_timeout_seconds",
        "cleanup_grace_seconds",
        "max_model_requests",
    ):
        if getattr(args, name) <= 0:
            raise SystemExit(f"--{name.replace('_', '-')} 必须大于 0")
    if args.model_max_retries < 0:
        raise SystemExit("--model-max-retries 不能小于 0")
    result, exit_code = asyncio.run(
        run_headless(
            instruction,
            workspace=workspace,
            state_dir=state_dir,
            output_dir=output_dir,
            result_path=result_path,
            agents_config=args.agents_config or selected_workspace.agents_config,
            mcps_config=args.mcps_config,
            environments_config=args.environments_config,
            model_name=args.model,
            reasoning_effort=args.reasoning_effort,
            task_timeout=args.task_timeout_seconds,
            model_timeout=args.model_timeout_seconds,
            model_max_retries=args.model_max_retries,
            cleanup_grace=args.cleanup_grace_seconds,
            max_model_requests=args.max_model_requests,
            thread_id=args.thread_id or uuid4().hex,
        )
    )
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(exit_code)
