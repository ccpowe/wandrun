import assert from "node:assert/strict";
import { test } from "node:test";

import { buildChatNotices } from "../src/lib/chat-notices.ts";

test("concurrent page failures stack connectivity, history, stop, collaboration, target without dropping recovery context", () => {
  const notices = buildChatNotices({
    target: "目标消息加载失败", collaboration: "这个协作已无法继续\n连接中断",
    stop: "停止未确认，工作可能仍在继续", history: "历史消息加载失败", offline: "连接已断开",
  });
  assert.deepEqual(notices, [
    { kind: "offline", message: "连接已断开" },
    { kind: "history", message: "历史消息加载失败" },
    { kind: "stop", message: "停止未确认，工作可能仍在继续" },
    { kind: "collaboration", message: "这个协作已无法继续\n连接中断" },
    { kind: "target", message: "目标消息加载失败" },
  ]);
});

test("recovery removes only resolved cards while remaining errors keep their priority", () => {
  assert.deepEqual(buildChatNotices({ offline: null, history: undefined, stop: "Stop not confirmed", collaboration: "", target: "Target failed" }), [
    { kind: "stop", message: "Stop not confirmed" },
    { kind: "target", message: "Target failed" },
  ]);
  assert.deepEqual(buildChatNotices({}), []);
});
