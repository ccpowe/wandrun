"""Thread-local execution placement, checkpointed together with its runtime notice.

Observation happens at the model boundary, not when configuration is saved. The latest
complete snapshot is an anchor in compaction's effective view; it is not replayed as a
new environment switch, and observing it never wakes a remote machine.
"""

import json

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage

from wandrun.runtime.communication.messages import runtime_message
from wandrun.runtime.execution.environments import Environment


def recovery_feedback_applies(
    message: HumanMessage, current_identity: dict[str, str] | None,
) -> bool:
    """Admit queued recovery only for the current physical machine and workspace.

    Runtime provenance, not user wording, identifies facts. Other message kinds pass
    unchanged; already consumed history is outside this mailbox admission boundary.
    """
    if (message.additional_kwargs.get("source") != "runtime"
            or not isinstance(message.content, str)
            or not message.content.startswith("[运行时反馈]\n")):
        return True
    try:
        payload = json.loads(message.content.split("\n", 1)[1])
    except ValueError:
        return True
    environment = payload.get("execution_environment") if isinstance(payload, dict) else None
    if not isinstance(environment, dict) or environment.get("status") != "recovered":
        return True
    identity = environment.get("identity")
    return (
        isinstance(identity, dict)
        and set(identity) == {"type", "location", "workspace"}
        and all(isinstance(value, str) and value for value in identity.values())
        and identity == current_identity
    )


def environment_snapshot_index(state) -> int | None:
    """Locate the complete runtime message backing the checkpoint's current marker."""
    snapshot = state.get("observed_environment")
    if snapshot is None:
        return None
    messages = state["messages"]
    return next((
        index for index in range(len(messages) - 1, -1, -1)
        if isinstance(messages[index], HumanMessage)
        and messages[index].additional_kwargs.get("source") == "runtime"
        and messages[index].additional_kwargs.get("environment_snapshot") == snapshot
    ), None)


class ObservedEnvironmentMiddleware(AgentMiddleware):
    """Persist placement and its full notice in one before-model state update.

    Failure/cancellation after preparation may retain both, never only an acknowledged
    marker. No successful model response is required: the marker describes prepared
    context, not whether a remote model consumed or acted upon that context.
    """

    def __init__(self, environment: Environment):
        self.environment = environment

    async def abefore_model(self, state, runtime):
        identity = self.environment.context_identity()
        previous = state.get("observed_environment")
        unchanged = previous is not None and previous["identity"] == identity
        snapshot = {
            "identity": identity,
            "description": self.environment.description or (
                f"执行环境：文件、终端命令和技能脚本在 "
                f"{'Local 本机' if identity['type'] == 'local' else 'Instabox 远端机器'}运行，"
                f"工作区是 {identity['workspace']}。"
            ),
        }
        if self.environment.type == "instabox":
            configured = self.environment.browser is not None
            snapshot["browser"] = {
                "configured": configured,
                "availability": "未探测，实际使用时确认" if configured else "未配置浏览器",
                "startup": (
                    '浏览器不可达时，在当前任务终端运行 python3 "$WANDRUN_BROWSER_START"；'
                    "默认 headless，Chrome 是环境级资源，任务结束不关闭 Chrome。"
                    if configured else "需先配置浏览器并选择 browser 技能。"
                ),
            }
        if previous == snapshot and environment_snapshot_index(state) is not None:
            return None
        status = "current" if unchanged else "initial" if previous is None else "changed"
        payload = {
            "kind": "当前执行环境" if status != "changed" else "执行环境变更",
            "execution_environment": {"status": status, **snapshot},
            "note": (
                "这是此 thread 当前完整环境快照，以此解释文件路径和后续执行；"
                "旧环境中的文件、进程和服务不能假定在这里存在。"
                "配置绑定变化不代表机器重启，真正恢复和结果未知另由运行时反馈。"
            ),
        }
        if status == "changed":
            payload["previous_environment"] = previous["identity"]
        message = runtime_message(payload)
        message.additional_kwargs["environment_snapshot"] = snapshot
        return {"observed_environment": snapshot, "messages": [message]}
