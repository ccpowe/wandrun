"""Core native chains; the existing runner owns services, device guards and fixture cleanup."""
import json
from uuid import uuid4

import collaboration


def prepare_chat(runner, env):
    nav = runner.create_owned_agent("E2E navigation " + runner.run_id)
    env["NAV_AGENT"] = nav
    collaboration.prepare(runner, env)
    # The profile's member tap opens an independent root, not the delegated task.
    blank = runner.api("/conversations", "POST", {"client_id": uuid4().hex, "agent_id": env["COLLAB_MEMBER"]})["id"]
    runner.fixtures.append(blank)


def action(runner, env, name):
    if name == "navigation":
        runner.home()
        first = 'id=' + json.dumps("agent-row-" + env["NAV_AGENT"])
        runner.ad("wait", first, "10000")
        runner.replay_steps("chat", env, source="""appId: host.exp.exponent
---
- swipe:
    from:
      id: agent-row-${NAV_AGENT}
    direction: LEFT
""")
        edit = 'label=' + json.dumps("编辑 " + runner.api(runner.agent_path(env["NAV_AGENT"]))["name"])
        runner.ad("press", edit, "--settle")
        runner.ad("wait", 'id="editor-name"', "10000")
        runner.ad("press", 'id="editor-name"', "--settle")
        assert runner.ad("keyboard", "status")["visible"], "Editor did not show the real IME"
        runner.dismiss_keyboard()
        runner.ad("scroll", "bottom", "--settle")
        runner.ad("wait", 'id="editor-save" hittable=true', "10000")
        runner.ad("press", 'id="editor-back"', "--settle")
        runner.ad("press", first, "--settle")
        runner.ad("wait", 'id="profile-name"', "10000")
        runner.ad("press", 'id="profile-close"', "--settle")
        runner.ad("wait", 'id="agent-list-screen"', "10000")
        runner.ad("screenshot", str(runner.OUT / "01-agent-profile-return.png"))
        runner.open_new_chat(env["NAV_AGENT"])
    elif name == "reply":
        roots = collaboration.wait_for(lambda: [
            row for row in runner.api("/conversations")["conversations"] if row["agent_id"] == env["NAV_AGENT"]
        ], bool)
        assert len(roots) == 1, "First native send must create exactly one root"
        root = roots[0]["id"]
        runner.fixtures.append(root)
        env["NAV_ROOT"] = root
        events = collaboration.wait_for(lambda: collaboration.events(runner, root), lambda rows: any(
            row["type"] == "message.agent" and "CORE-HELLO" in row["data"].get("text", "") for row in rows))
        assert not any(row["type"] == "turn.failed" for row in events), "Real chat turn failed"
        runner.ad("wait", 'text="CORE-HELLO"', "30000")
        runner.ad("screenshot", str(runner.OUT / "02-real-chat-keyboard.png"))
        runner.dismiss_keyboard()
        # One OS Back must close the actual drawer, without leaving this root.
        runner.ad("gesture", "swipe", "right")
        runner.ad("wait", 'id="drawer-agents"', "10000")
        runner.ad("back", "--system")
        runner.ad("wait", "absent", 'label="关闭对话列表"', "10000")
        runner.ad("wait", 'id="composer-input"', "10000")
        (runner.OUT / "real-chat-events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2))
    elif name == "profile":
        runner.open_root(env["COLLAB_ROOT"])
        runner.open_agent_profile()
        runner.ad("press", 'id="profile-tab-members"', "--settle")
        runner.ad("press", 'id=' + json.dumps("profile-member-" + env["COLLAB_MEMBER"]), "--settle")
        runner.ad("wait", 'id="chat-agent-name" text=' + json.dumps(env["COLLAB_MEMBER_NAME"]), "10000")
        runner.ad("back", "--system")
        runner.ad("wait", 'id="profile-name"', "10000")
        runner.ad("press", 'id="profile-close"', "--settle")
        runner.ad("wait", 'id="chat-agent-name" text=' + json.dumps(env["COLLAB_PARENT_NAME"]), "10000")
    elif name == "summary":
        root = env["NAV_ROOT"]
        runner.api("/e2e/scene", "POST", {"conversation_id": root, "scene": "summary"})
        event = next(row for row in reversed(collaboration.events(runner, root)) if row["type"] == "context.compacted")
        env["SUMMARY_SEQ"] = event["seq"]
        runner.open_root(root)
        runner.ad("wait", 'id=' + json.dumps("context-compacted-" + str(event["seq"])), "10000")
        runner.ad("press", 'id=' + json.dumps("context-compacted-" + str(event["seq"])), "--settle")
        runner.ad("wait", 'text="SUMMARY TOP"', "10000")
        runner.ad("screenshot", str(runner.OUT / "04-summary-top.png"))
    else:
        raise ValueError("Unknown core action: " + name)


def prepare_schedule(runner, env):
    identity = runner.create_owned_agent("E2E schedule " + runner.run_id)
    root = runner.api("/conversations", "POST", {"client_id": uuid4().hex, "agent_id": identity})["id"]
    runner.fixtures.append(root)
    zone = runner.api(runner.agent_path(identity) + "/schedules")["default_timezone"] or "Asia/Shanghai"
    env.update(SCHEDULE_AGENT_ID=identity, SCHEDULE_CHAT_ID=root, SCHEDULE_ZONE=zone,
               AGENT_SCHEDULE_NAME="E2E once " + runner.run_id)


def schedule_action(runner, env, name):
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    identity = env["SCHEDULE_AGENT_ID"]
    if name == "created":
        when = (datetime.now(ZoneInfo(env["SCHEDULE_ZONE"])) + timedelta(minutes=2)).replace(second=0, microsecond=0)
        local_at = when.strftime("%Y-%m-%dT%H:%M")
        runner.api(runner.conversation_path(env["SCHEDULE_CHAT_ID"]) + "/messages", "POST", {
            "client_id": "e2e-schedule-" + runner.run_id,
            "text": f"现在调用 create_schedule 为你自己创建一个单次定时，不要只回复文字。名称精确为 {env['AGENT_SCHEDULE_NAME']}，执行内容为“只回复好的”，local_at 精确为 {local_at}，时区 {env['SCHEDULE_ZONE']}。成功后只回复定时 id。",
        })
        rows = collaboration.wait_for(lambda: runner.api(runner.agent_path(identity) + "/schedules")["schedules"],
            lambda items: any(row["name"] == env["AGENT_SCHEDULE_NAME"] for row in items))
        row = next(row for row in rows if row["name"] == env["AGENT_SCHEDULE_NAME"])
        assert row["rule"] == {"kind": "once", "local_at": local_at}
        env["AGENT_SCHEDULE_ID"] = row["id"]
    elif name == "triggered":
        schedule_id = env["AGENT_SCHEDULE_ID"]
        runs = collaboration.wait_for(lambda: runner.api("/schedules/" + schedule_id + "/runs")["runs"],
            lambda rows: any(row["status"] == "completed" and row["conversation_id"] for row in rows), timeout=240)
        run = next(row for row in runs if row["status"] == "completed")
        root = run["conversation_id"]
        runner.fixtures.append(root)
        events = collaboration.events(runner, root)
        assert any(row["type"] == "message.agent" and "好的" in row["data"].get("text", "") for row in events)
        env.update(SCHEDULE_RUN_ID=run["id"], SCHEDULE_CONVERSATION_ID=root,
            SCHEDULE_TRIGGER_SEQ=next(row["seq"] for row in events if row["type"] == "schedule.triggered"))
        (runner.OUT / "schedule-run.json").write_text(json.dumps({"run": run, "events": events}, ensure_ascii=False, indent=2))
    else:
        raise ValueError("Unknown schedule action: " + name)
