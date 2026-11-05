"""One real PDF/model/original-file round trip; runner owns device and lifecycle.

Call prepare before replaying attachments.yaml. After deleting owned conversations,
call cleanup BEFORE cleanup_upload_fixture: the latter removes the shared directory.
Run in the project's Python environment for the checkpoint serializer. Only this
conversation's file-tool names, paths and statuses are exported, never its checkpoint.
"""
import hashlib
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import time
from urllib.parse import quote
from urllib.request import Request, urlopen


MANUAL_SAVE_SHARE = (
    "当前应停在交付 Markdown 的 App 预览页。人工操作并记录两个独立结果：\n"
    "1. 点右上下载（file-download），在系统目录选择器的 Download/下载中新建仅本次使用的 "
    "wandrun-e2e-<run_id> 目录，选择该目录并允许访问。回到 Expo，必须出现“已保存到所选位置”；"
    "人工用系统文件应用打开该目录下 <DELIVERY_NAME>，核对文件名和正文 <PDF_MARKER>。"
    "只见目录选择器或保存按钮不算保存成功。\n"
    "2. 人工回到 Expo 的同一预览页，点分享（file-share），核对系统面板显示 "
    "<DELIVERY_NAME>，选择一个能接收 Markdown 的应用；在接收方实际打开文件，核对原文件名与 "
    "<PDF_MARKER> 正文。只见系统接收方列表不算接收成功。\n"
    "3. 人工回到 Expo 的同一预览页，明确回复“保存通过；分享接收通过”，并给出保存目录与接收方。"
    "外部文件应用/接收方的查看与返回全部由人工执行，Agent 只操作 Expo；"
    "若没有可用接收方、目录权限失败或外部查看与设备限制冲突，报告阻塞，不记 PASS。"
    "人工删除刚创建的本次保存目录/接收副本，不触碰其他文件。"
)


def prepare(runner, env):
    """Reuse the tus fixture, then isolate the unread answer from every prompt/name."""
    runner.upload_fixture(env)
    name = f"e2e-delivery-{runner.run_id}.md"
    env.update(DELIVERY_NAME=name, DELIVERY_PATH=str(
        runner.WORKSPACE / "conversations" / env["UPLOAD_CONVERSATION_ID"] / name))
    prompt = (
        "Use fetch_upload for this message's upload reference if needed, then read the returned PDF path with read_file, not shell, code, grep, or text extraction. "
        "After reading it, use write_file to create exactly one Markdown original named "
        f"{name} in this conversation's working directory. Its full body must be "
        "'# PDF round trip\\n\\n' followed by the marker you actually saw in the PDF and "
        "one final newline. Then use SendMessage to human: message must contain that "
        f"marker, attachments must contain only the relative path {name}, and next=done. "
        "Do not merely mention the filename or paste Markdown instead of delivering the file. "
        "Use only fetch_upload, read_file and write_file; do not create any other file."
    )
    assert env["PDF_MARKER"] not in prompt
    env["UPLOAD_PROMPT"] = prompt
    saved = runner.api("/agents/" + quote(env["UPLOAD_AGENT_ID"], safe=""), "PATCH", {
        "system_prompt": (
            "Follow the user's PDF round-trip task. Inspect PDF contents ONLY with read_file. "
            "Never inspect them using shell, code, grep, or text extraction. After reading, "
            "write exactly the requested Markdown with write_file and deliver its original "
            "relative path through SendMessage.attachments to human. fetch_upload is allowed only to obtain this message's uploaded PDF; use no other tools."
        ),
        "code_mode": False,
    })
    assert saved["agent"]["code_mode"] is False


def _events(runner, env):
    return runner.api("/conversations/" + quote(env["UPLOAD_CONVERSATION_ID"], safe="")
                      + "/events?limit=200")["events"]


def _file_bytes(runner, identity):
    request = Request(runner.GATEWAY + "/files/" + quote(identity, safe="") + "/content",
                      headers={"Authorization": "Bearer " + runner.TOKEN})
    with urlopen(request, timeout=30) as response:
        assert response.status == 200
        return response.read()


def _tool_evidence(runner, env):
    """Read only owned delta writes: prove PDF read_file and Markdown write_file."""
    from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

    serializer = JsonPlusSerializer()
    checkpoint = runner.WORKSPACE / ".wandrun" / "state" / "checkpoints.sqlite"
    with closing(sqlite3.connect(checkpoint.as_uri() + "?mode=ro", uri=True)) as db:
        writes = db.execute(
            "SELECT type, value FROM writes WHERE thread_id=? AND channel='messages' "
            "ORDER BY checkpoint_id, task_id, idx", (env["UPLOAD_CONVERSATION_ID"],),
        ).fetchall()
    calls, results = {}, {}
    for kind, value in writes:
        messages = serializer.loads_typed((kind, value))
        for message in messages if isinstance(messages, list) else [messages]:
            for call in getattr(message, "tool_calls", []):
                calls[call["id"]] = call
            if getattr(message, "type", None) == "tool":
                results[message.tool_call_id] = message
    assert calls, "No persisted file-tool calls for the real model turn"
    assert {call["name"] for call in calls.values()} <= {"fetch_upload", "read_file", "write_file"}, (
        "Model bypassed the required file tools: " + repr([call["name"] for call in calls.values()]))
    directory = Path(env["UPLOAD_PATH"]).parent
    evidence = []
    for identity, call in calls.items():
        result = results.get(identity)
        assert result is not None, "File tool result is missing: " + call["name"]
        row = {"name": call["name"], "status": result.status}
        if call["name"] == "fetch_upload":
            assert call["args"]["upload_id"] == env["UPLOAD_FILE_ID"], "Fetched a different upload"
            row["upload_id"] = call["args"]["upload_id"]
        else:
            path = Path(call["args"]["file_path"])
            path = path if path.is_absolute() else directory / path
            expected = Path(env["UPLOAD_PATH"] if call["name"] == "read_file" else env["DELIVERY_PATH"])
            if result.status == "success":
                assert path.resolve() == expected.resolve(), "Model accessed an unexpected file: " + str(path)
            row["file_path"] = str(path)
        evidence.append(row)
    assert {row["name"] for row in evidence if row["status"] == "success"} >= {"read_file", "write_file"}, evidence
    return evidence


def _await_delivery(runner, env):
    deadline = time.monotonic() + 240
    while True:
        events = _events(runner, env)
        if any(row["type"] == "turn.failed" for row in events):
            raise AssertionError("Attachment round-trip model turn failed; inspect gateway events")
        replies = [row["data"] for row in events if row["type"] == "message.agent"]
        files = [file for reply in replies for file in reply.get("attachments", [])]
        conversation = next(row for row in runner.api("/conversations")["conversations"]
                            if row["id"] == env["UPLOAD_CONVERSATION_ID"])
        if conversation["status"] != "working":
            assert len(files) == 1 and files[0]["name"] == env["DELIVERY_NAME"], (
                "Model must deliver exactly the requested Markdown original")
            assert any(env["PDF_MARKER"] in reply.get("text", "")
                       and files[0] in reply.get("attachments", []) for reply in replies), (
                "Delivered message did not echo the unread PDF marker")
            break
        if time.monotonic() >= deadline:
            raise AssertionError("Model did not complete PDF read and original-file delivery within 240s")
        time.sleep(1)
    file = files[0]
    env["DELIVERY_FILE_ID"] = file["id"]
    detail = runner.api("/files/" + quote(file["id"], safe=""))
    assert detail["available"] and detail["source"] == "agent"
    assert detail["name"] == env["DELIVERY_NAME"] and detail["media_type"] == "text/markdown"
    assert detail["conversation_id"] == env["UPLOAD_CONVERSATION_ID"]
    assert detail["agent_id"] == env["UPLOAD_AGENT_ID"]
    source = Path(env["DELIVERY_PATH"])
    assert source.is_file() and not source.is_symlink(), "Delivered original file is missing"
    expected = ("# PDF round trip\n\n" + env["PDF_MARKER"] + "\n").encode()
    original = source.read_bytes()
    assert original == expected, "Markdown original does not contain exactly the PDF marker"
    assert _file_bytes(runner, file["id"]) == original, "HTTP content differs from original bytes"
    evidence = {
        "conversation_id": env["UPLOAD_CONVERSATION_ID"], "file": detail,
        "source_exists": True, "http_matches_original": True,
        "size": len(original), "sha256": hashlib.sha256(original).hexdigest(),
        "tools": _tool_evidence(runner, env),
    }
    (runner.OUT / "attachments-delivery.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")


def action(runner, env, name):
    """Dispatch semantic checkpoints; save/share success remains explicitly human."""
    if name == "open":
        runner.open_root(env["UPLOAD_CONVERSATION_ID"])
    elif name == "keyboard":
        deadline = time.monotonic() + 5
        while not runner.ad("keyboard", "status")["visible"]:
            assert time.monotonic() < deadline, "Real keyboard did not open"
            time.sleep(0.1)
        rect = runner.ad("get", "attrs", 'id="composer-add"')["node"]["rect"]
        env["ATTACHMENT_COMPOSER_RECT"] = json.dumps(rect)
    elif name == "menu":
        assert runner.ad("keyboard", "status")["visible"], "Menu lost the raised keyboard"
        menu = runner.ad("get", "attrs", 'id="attachment-picker-menu"')["node"]
        item = runner.ad("get", "attrs", 'id="attachment-picker-file"')["node"]
        anchor = json.loads(env["ATTACHMENT_COMPOSER_RECT"])
        rect = menu["rect"]
        assert rect["y"] >= 0 and rect["y"] + rect["height"] <= anchor["y"], (
            "Attachment menu overlaps the keyboard-raised composer or clips offscreen")
        assert item.get("enabled") and item.get("hittable"), "Native file menu item is obscured"
        (runner.OUT / "attachments-keyboard-menu.json").write_text(json.dumps({
            "keyboard_visible": True, "menu": rect, "composer": anchor,
            "file_item": item["rect"], "file_item_hittable": True,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    elif name == "select":
        runner.select_upload_document(env)
    elif name == "sent":
        events = _events(runner, env)
        deadline = time.monotonic() + 15
        while not any(row["type"] == "message.user" for row in events) and time.monotonic() < deadline:
            time.sleep(0.25)
            events = _events(runner, env)
        messages = [row["data"] for row in events if row["type"] == "message.user"]
        assert len(messages) == 1 and messages[0]["text"] == env["UPLOAD_PROMPT"]
        files = messages[0]["attachments"]
        assert len(files) == 1 and files[0]["name"] == env["UPLOAD_NAME"]
        env["UPLOAD_FILE_ID"] = files[0]["id"]
        original = Path(env["UPLOAD_LOCAL_PATH"]).read_bytes()
        assert Path(env["UPLOAD_PATH"]).read_bytes() == original
        assert _file_bytes(runner, files[0]["id"]) == original, "tus PDF differs from selected original"
        detail = runner.api("/files/" + quote(files[0]["id"], safe=""))
        assert detail["available"] and detail["source"] == "user_upload"
        assert detail["conversation_id"] == env["UPLOAD_CONVERSATION_ID"]
    elif name == "delivered":
        _await_delivery(runner, env)
        runner.dismiss_keyboard()
    elif name == "returned":
        runner.ad("wait", 'id=' + json.dumps("attachment-markdown-" + env["DELIVERY_FILE_ID"]), "10000")
        agent = runner.api("/agents/" + quote(env["UPLOAD_AGENT_ID"], safe=""))
        runner.ad("wait", 'id="chat-agent-name" text=' + json.dumps(agent["name"]), "10000")
    else:
        raise ValueError("Unknown attachments action: " + name)


def cleanup(runner, env):
    """Delete only the owned delivery and registry, after chat deletion, before tus cleanup."""
    if "DELIVERY_PATH" not in env:
        return
    identity = env["UPLOAD_CONVERSATION_ID"]
    source = Path(env["DELIVERY_PATH"])
    assert identity in runner.fixtures and env["UPLOAD_AGENT_ID"] in runner.owned_agents
    assert source == runner.WORKSPACE / "conversations" / identity / f"e2e-delivery-{runner.run_id}.md"
    assert source.parent == Path(env["UPLOAD_PATH"]).parent
    assert not source.is_symlink(), "Refusing to clean an unexpected symlink"
    existing = {row["id"] for row in runner.api("/conversations")["conversations"]}
    assert identity not in existing, "Conversation must stop before delivery cleanup"
    with closing(sqlite3.connect(runner.WORKSPACE / ".wandrun" / "state" / "gateway.sqlite")) as db, db:
        rows = db.execute("SELECT conversation_id, agent_id FROM files WHERE path=? AND source='agent'",
                          (str(source),)).fetchall()
        assert all(conversation in (None, identity) and agent in (None, env["UPLOAD_AGENT_ID"])
                   for conversation, agent in rows), "Delivery registry ownership changed"
        db.execute("DELETE FROM files WHERE path=? AND source='agent'", (str(source),))
    source.unlink(missing_ok=True)
    # Keep the shared directory: cleanup_upload_fixture owns its final emptiness check.
