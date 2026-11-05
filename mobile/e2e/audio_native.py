"""Owned audio fixture and native-only seek/drawer evidence for attachments.yaml.

No model call, synthetic Slider event, or application gesture implementation here.
"""
import json
import re
import sqlite3
import time
import wave
from contextlib import closing
from uuid import uuid4


def publish(gateway, root):
    from wandrun.runtime.execution.files import ResolvedAttachment

    source = gateway.workspace_root / "e2e-audio" / root / "e2e-audio.wav"
    source.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(source), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\0\0" * (8000 * 16))
    gateway.on_human(root, "E2E native audio gesture", [
        ResolvedAttachment(str(source), source.name, source.stat().st_size, "audio/wav"),
    ])


def prepare(runner, env):
    agent = runner.create_owned_agent("E2E audio " + runner.run_id)
    conversation = runner.api("/conversations", "POST", {"client_id": uuid4().hex, "agent_id": agent})["id"]
    runner.fixtures.append(conversation)
    # Record ownership before publishing, so failed preparation is still cleaned.
    env["AUDIO_CONVERSATION_ID"] = conversation
    runner.api("/e2e/scene", "POST", {"conversation_id": conversation, "scene": "audio"})
    events = runner.api(runner.conversation_path(conversation) + "/events?limit=200")["events"]
    files = [file for event in events if event["type"] == "message.agent"
             for file in event["data"].get("attachments", []) if file["name"] == "e2e-audio.wav"]
    assert len(files) == 1, events
    env["AUDIO_FILE_ID"] = files[0]["id"]


def _time(nodes):
    values = set()
    for node in nodes:
        match = re.search(r"(?<!\d)(\d+):(\d{2})\s*/\s*(\d+):(\d{2})(?!\d)",
                          str(node.get("label") or node.get("text") or ""))
        if match:
            minute, second, total_minute, total_second = map(int, match.groups())
            values.add((minute * 60 + second, total_minute * 60 + total_second))
    assert len(values) == 1, f"Expected one visible audio clock, got {values}"
    return next(iter(values))


def _drawer_open(nodes):
    return any(node.get("label") == "关闭对话列表" and node.get("hittable") for node in nodes)


def action(runner, env, name):
    evidence = runner.OUT / "audio-gesture.json"
    if name == "open":
        runner.ad("open", runner.EXPO.rstrip("/") + "/--/chat?id=" + env["AUDIO_CONVERSATION_ID"], "--foreground")
        runner.ad("wait", 'id="attachment-audio-' + env["AUDIO_FILE_ID"] + '"', "30000")
        runner.dismiss_known_dev_overlay()
        return
    details = json.loads(evidence.read_text()) if evidence.exists() else {}
    nodes = runner.ad("snapshot")["nodes"]
    assert not _drawer_open(nodes), "Drawer must be closed before the native contact"
    slider = next(node for node in nodes if node.get("label") == "音频进度" and node.get("hittable"))
    rect = slider["rect"]
    if name == "seek":
        before, total = _time(nodes)
        assert total == 16 and before < total * 0.3, (before, total)
        contact = [round(rect["x"] + rect["width"] * 0.2), round(rect["y"] + rect["height"] / 2),
                   round(rect["width"] * 0.6), 0, 700]
        details["seek"] = {"before_seconds": before, "total_seconds": total, "slider": rect, "pan": contact}
        evidence.write_text(json.dumps(details, ensure_ascii=False, indent=2))
        runner.ad("gesture", "pan", *map(str, contact))
        deadline = time.monotonic() + 8
        while True:
            after_nodes = runner.ad("snapshot")["nodes"]
            after, _ = _time(after_nodes)
            drawer = _drawer_open(after_nodes)
            details["seek"].update(after_seconds=after, drawer_open=drawer)
            evidence.write_text(json.dumps(details, ensure_ascii=False, indent=2))
            assert not drawer, "Slider drag opened the drawer"
            if after >= total * 0.6 and after - before >= 3:
                break
            assert time.monotonic() < deadline, f"Native seek did not change the clock: {details}"
            time.sleep(0.2)
    elif name == "edge":
        root = max((node["rect"] for node in nodes if node.get("rect") and
                    node.get("bundleId") == "host.exp.exponent"), key=lambda item: item["width"] * item["height"])
        # Stay near the left edge but outside Android's system Back band.
        # On this 1280px phone, 4% (51px) navigated Back; 8% is 102px.
        x, y = round(root["x"] + root["width"] * 0.08), round(root["y"] + root["height"] * 0.2)
        assert not (rect["x"] <= x <= rect["x"] + rect["width"] and rect["y"] <= y <= rect["y"] + rect["height"])
        contact = [x, y, round(root["width"] * 0.7), 0, 700]
        details["edge"] = {"root": root, "pan": contact}
        evidence.write_text(json.dumps(details, ensure_ascii=False, indent=2))
        runner.ad("gesture", "pan", *map(str, contact))
        runner.ad("wait", 'label="关闭对话列表"', "10000")
        details["edge"]["drawer_open"] = _drawer_open(runner.ad("snapshot")["nodes"])
        evidence.write_text(json.dumps(details, ensure_ascii=False, indent=2))
        assert details["edge"]["drawer_open"], "Edge drag did not open the drawer"
    else:
        raise ValueError("Unknown audio native action: " + name)


def cleanup(runner, env):
    identity = env.get("AUDIO_CONVERSATION_ID")
    if identity is None:
        return
    assert identity in runner.fixtures
    assert all(row["id"] != identity for row in runner.api("/conversations")["conversations"])
    source = runner.WORKSPACE / "e2e-audio" / identity / "e2e-audio.wav"
    with closing(sqlite3.connect(runner.WORKSPACE / ".wandrun/state/gateway.sqlite")) as db, db:
        db.execute("DELETE FROM files WHERE conversation_id=? AND path=? AND source='agent'", (identity, str(source)))
    source.unlink(missing_ok=True)
    if source.parent.exists():
        source.parent.rmdir()
