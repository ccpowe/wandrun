"""Real-model task conversations; the runner owns all Agents and the root branch."""
import json
import time
from uuid import uuid4


def prepare(runner, env):
    child_name = "E2E member " + runner.run_id
    child = runner.create_owned_agent(child_name, system_prompt=(
        "Follow the user's collaboration acceptance instructions. On the FIRST delegation, "
        "send human exactly COLLAB READY, then next=wait without reporting to the creator. "
        "On a user interjection, compute the requested product and send the answer to BOTH "
        "human and the original creator task, then next=done. Preserve the original creator identity."
    ))
    parent_name = "E2E parent " + runner.run_id
    parent = runner.create_owned_agent(parent_name, [child], system_prompt=(
        "Delegate the initial request to your only member, then next=wait. "
        "After its final result arrives, relay the numerical answer to human and finish."
    ))
    root = runner.api("/conversations", "POST", {"agent_id": parent})["id"]
    runner.fixtures.append(root)
    env.update(COLLAB_ROOT=root, COLLAB_PARENT=parent, COLLAB_MEMBER=child,
               COLLAB_PARENT_NAME=parent_name, COLLAB_MEMBER_NAME=child_name)


def wait_for(read, matches, timeout=180):
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if matches(value):
            return value
        if time.monotonic() >= deadline:
            raise AssertionError("Collaboration condition timed out: " + json.dumps(value, ensure_ascii=False))
        time.sleep(0.5)


def events(runner, identity, task=False):
    return runner.api(("/tasks/" if task else "/conversations/") + identity + "/events?limit=200")["events"]


def action(runner, env, name):
    root = env["COLLAB_ROOT"]
    if name == "generate":
        runner.api("/conversations/" + root + "/messages", "POST", {
            "client_id": uuid4().hex,
            "text": "Delegate to your member now; it must wait for my correction before computing anything.",
        })
        tasks = wait_for(lambda: runner.api("/agents/" + env["COLLAB_PARENT"] + "/collaborations")["conversations"],
                         lambda rows: any(row["root_id"] == root for row in rows))
        child = next(row["id"] for row in tasks if row["root_id"] == root)
        env["COLLAB_TASK"] = child
        history = wait_for(lambda: events(runner, child, True),
                           lambda rows: any(e["type"] == "message.agent" and e["data"]["text"] == "COLLAB READY" for e in rows))
        env["COLLAB_INCOMING"] = next(e["seq"] for e in history if e["type"] == "message.task")
        preview = next(e for e in events(runner, root) if e["type"] == "message.task_preview")
        env["COLLAB_PREVIEW"] = preview["seq"]
        env["COLLAB_MESSAGE"] = preview["data"]["message_seq"]
    elif name in ("corrected", "resumed"):
        expected = "323" if name == "corrected" else "667"
        child = env["COLLAB_TASK"]
        history = wait_for(lambda: events(runner, child, True), lambda rows: any(
            e["type"] == "message.task" and e["data"].get("sender_task_id") == child
            and expected in e["data"].get("text", "") for e in rows))
        wait_for(lambda: runner.api("/tasks/" + child), lambda task: task["status"] == "completed")
        root_history = wait_for(lambda: events(runner, root), lambda rows: any(
            e["type"] == "message.agent" and expected in e["data"].get("text", "") for e in rows))
        assert sum(e["type"] == "message.user" for e in root_history) == 1, "Interjection leaked into root"
        assert all(e["data"].get("task_id") != child for e in root_history if e["type"] == "message.agent")
        assert runner.api("/tasks/" + child)["root_id"] == root
        (runner.OUT / (name + "-events.json")).write_text(json.dumps({"member": history, "root": root_history}, ensure_ascii=False, indent=2))
    elif name == "delete":
        runner.api("/conversations/" + root, "DELETE")
        for path in ("/agents/" + env["COLLAB_PARENT"] + "/collaborations",
                     "/agents/" + env["COLLAB_MEMBER"] + "/conversations"):
            assert all(row.get("root_id") != root for row in runner.api(path)["conversations"])
    elif name == "home":
        runner.home()
    elif name == "compose":
        runner.dismiss_known_dev_overlay()
    else:
        raise ValueError("Unknown collaboration action: " + name)
