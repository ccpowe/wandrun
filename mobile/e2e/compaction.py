"""Drive real model turns until a checkpointed compaction appears in chat history.

The runner owns fixture deletion; this group neither appends synthetic events nor edits
runtime checkpoints. A completed gateway event (not a pending summary attempt) is the
source of the row's sequence and of the persisted API evidence.
"""

import json
import time
import shutil
from uuid import uuid4


# Long, varied task notes exercise ordinary history accumulation, not one oversized
# instruction or a provider overflow. The Agent is asked to acknowledge each note.
_NOTES = (
    "产品会议确认列表首先显示任务归属，详情页再显示完整来源和创建时间。",
    "离线恢复时先保留本地未提交草稿，重新连接后按服务器版本检查冲突。",
    "搜索结果需要同时保留命中上下文和跳转路径，不把摘要当成原始记录。",
    "交接材料应标明已验证事实、尚待核对事项和对应的负责人。",
    "附件预览只读取登记的原始文件，删除会话不应修改独立文件。",
    "界面状态变更应有可访问的文字说明，浅色与深色都要可辨认。",
    "检查流程先记录输入和操作时间，再记录期望结果与观察结果。",
    "时间线按照事件顺序展示，重新打开仍需恢复相同的历史内容。",
)


def prepare(runner, env):
    """Create an exclusively owned Agent and conversation for this group."""
    name = "E2E compaction " + runner.run_id
    agent_id = runner.create_owned_agent(
        name, context_window=32000, compaction_keep_tokens=384,
        system_prompt=(
            "For ordinary case-note messages, acknowledge with ACK and do not call tools. "
            "When asked to summarize the conversation, follow the summary instructions instead: "
            "write a substantive Chinese summary preserving the project identifier and decisions."
        ),
    )
    conversation = runner.api("/conversations", "POST", {"agent_id": agent_id})
    runner.fixtures.append(conversation["id"])
    env.update({"COMPACTION_AGENT_ID": agent_id,
                "COMPACTION_CONVERSATION_ID": conversation["id"],
                "COMPACTION_AGENT_NAME": name})


def _events(runner, env):
    return runner.api(runner.conversation_path(env["COMPACTION_CONVERSATION_ID"])
                      + "/events?limit=200")["events"]


def _idle(runner, env):
    return next(row for row in runner.api("/conversations")["conversations"]
                if row["id"] == env["COMPACTION_CONVERSATION_ID"])["status"] == "idle"


def _note(run_id, number):
    entries = [f"记录 {number}-{index}: {_NOTES[(index + number) % len(_NOTES)]}"
               for index in range(60)]
    return (f"这是同一个测试项目 {run_id} 的第 {number} 批工作记录。"
            "请阅读后只回复 ACK，不调用工具；下一批记录将继续发到本对话。\n"
            + "\n".join(entries))


def _generate(runner, env):
    path = runner.conversation_path(env["COMPACTION_CONVERSATION_ID"])
    completed = None
    events = []
    for number in range(1, 13):
        response = runner.api(path + "/messages", "POST", {
            "client_id": "e2e-compaction-" + uuid4().hex,
            "text": _note(runner.run_id, number),
        })
        user_seq = response["event"]["seq"]
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            events = _events(runner, env)
            if any(row["seq"] > user_seq and row["type"] == "turn.failed" for row in events):
                (runner.OUT / "compaction-events.json").write_text(
                    json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
                raise RuntimeError(f"Compaction Agent turn {number} failed; see event history: "
                                   f"{runner.OUT / 'compaction-events.json'}")
            replied = any(row["seq"] > user_seq and row["type"] == "message.agent"
                          for row in events)
            if replied and _idle(runner, env):
                break
            time.sleep(1)
        else:
            (runner.OUT / "compaction-events.json").write_text(
                json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
            raise RuntimeError(f"Compaction Agent turn {number} did not complete within 240 seconds")
        # Require several completed exchanges before accepting a checkpoint; an
        # oversized first request is not this regression's multi-turn scenario.
        if number >= 3:
            completed = next((row for row in events if row["type"] == "context.compacted"
                              and row["seq"] > user_seq
                              and row["data"].get("reason") == "threshold"), None)
            if completed:
                break
    (runner.OUT / "compaction-events.json").write_text(
        json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
    assert completed is not None, "No real threshold compaction after 3–12 completed model turns"
    data = completed["data"]
    assert (completed["conversation_id"] == env["COMPACTION_CONVERSATION_ID"]
            and data["status"] == "completed"
            and data["agent_id"] == env["COMPACTION_AGENT_ID"]
            and data["agent_name"] == env["COMPACTION_AGENT_NAME"]
            and data["event_id"] and data["generation"] >= 1
            and data["cutoff_index"] > 0 and data["keep_tokens"] == 384
            and runner.run_id in data["summary_text"]), "Invalid persisted compaction checkpoint"
    assert sum(row["type"] == "message.agent" and row["seq"] < completed["seq"]
               for row in events) >= 2, "Compaction preceded the multi-turn exchange"
    env["COMPACTION_SEQ"] = completed["seq"]
    env["COMPACTION_EVENT_ID"] = data["event_id"]
    # The runner injects every env value into each Maestro invocation. Keep the
    # potentially long model summary in the API artifact, not command arguments.


def _reopened(runner, env):
    """Check the same persisted row and complete summary after leaving/reopening chat."""
    events = _events(runner, env)
    matching = [row for row in events if row["type"] == "context.compacted"
                and row["data"].get("event_id") == env["COMPACTION_EVENT_ID"]]
    assert len(matching) == 1 and matching[0]["seq"] == env["COMPACTION_SEQ"]
    original = json.loads((runner.OUT / "compaction-events.json").read_text(encoding="utf-8"))
    baseline = next(row for row in original if row["seq"] == env["COMPACTION_SEQ"])
    assert matching[0]["data"]["summary_text"] == baseline["data"]["summary_text"]
    (runner.OUT / "compaction-reopened-events.json").write_text(
        json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")


def action(runner, env, name):
    """Dispatch YAML checkpoints; UI actions remain in the semantic YAML flow."""
    if name == "generate":
        _generate(runner, env)
    elif name == "reopened":
        _reopened(runner, env)
    else:
        raise RuntimeError("Unknown compaction action: " + name)


def cleanup(runner, env):
    """Remove only the exclusively owned root task's archive after the task is deleted."""
    identity = env.get("COMPACTION_CONVERSATION_ID")
    if not identity:
        return
    assert identity not in {row["id"] for row in runner.api("/conversations")["conversations"]}, (
        "Refusing archive cleanup while fixture conversation still exists")
    directory = (runner.WORKSPACE / ".wandrun" / "artifacts" / "compaction"
                 / runner.hashlib.sha256(identity.encode()).hexdigest())
    if directory.exists():
        shutil.rmtree(directory)
