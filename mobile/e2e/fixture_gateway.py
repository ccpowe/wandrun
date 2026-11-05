"""Real isolated gateway plus authenticated display fixtures; no model is used to copy UI samples.

Run with the normal gateway flags. Only /e2e/scene is added in this test process;
production code, pairing, tools, model execution, storage and SSE remain unchanged.
"""
import hmac
import json
from datetime import datetime, timezone
from uuid import uuid4

from starlette.responses import JSONResponse
from starlette.routing import Route

from wandrun.gateway import app as gateway_app
from wandrun.gateway.http import create_app

import native_rich
import audio_native


SUMMARY = "\n\n".join([
    "# SUMMARY TOP\n\n固定长摘要仅验证原生滚动与返回，不评判压缩模型。",
    *[f"## 核对条目 {index:02d}\n\n保留原始资料、当前结论、未解决问题和下一步动作。每项都说明状态由谁创建、谁修改、谁读取，以及何时结束。" for index in range(1, 13)],
    "## SUMMARY BOTTOM\n\n这是最后一条事实，滑到底部才能看见。",
])


def fixture_app(gateway, token=None, **kwargs):
    app = create_app(gateway, token, **kwargs)

    async def scene(request):
        if not token or not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + token):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        body = await request.json()
        root = body["conversation_id"]
        conversation = gateway.store.conversation(root)
        if conversation is None:
            return JSONResponse({"error": "conversation not found"}, status_code=404)
        agent = gateway.store.agent(conversation["agent_id"])
        if not agent or not agent["name"].startswith("E2E "):
            return JSONResponse({"error": "fixture requires an owned E2E Agent"}, status_code=409)
        name = body["scene"]
        if name == "summary":
            gateway.on_compaction(root, {
                "status": "completed", "agent_name": conversation["agent_id"],
                "event_id": "e2e-" + uuid4().hex, "generation": 1, "reason": "threshold", "cutoff_index": 20,
                "summary_text": SUMMARY, "archive_path": "/e2e/display-only-summary.md",
                "created_at": datetime.now(timezone.utc).isoformat(), "keep_tokens": 384,
                "retained_tokens": 400, "retention_reason": "target", "summary_model": "display-fixture", "summary_usage": {},
            })
        elif name == "audio":
            audio_native.publish(gateway, root)
        elif name in native_rich.SCENARIOS:
            text = "```wandrun-ui\n" + json.dumps(native_rich.SCENARIOS[name], ensure_ascii=False) + "\n```"
            if name == "math":
                text += "\n\n行内公式 $v=at$ 与块公式：\n\n$$\nE=mc^2\n$$"
            gateway.on_human(root, text, [])
        else:
            return JSONResponse({"error": "unknown display scene"}, status_code=400)
        return JSONResponse({"conversation_id": root, "scene": name, "as_of_seq": gateway.store.last_seq()})

    app.routes.append(Route("/e2e/scene", scene, methods=["POST"]))
    return app


if __name__ == "__main__":
    gateway_app.create_app = fixture_app
    gateway_app.main()
