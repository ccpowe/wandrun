import assert from "node:assert/strict";
import { test } from "node:test";

import { buildChatNotices } from "../src/lib/chat-notices.ts";

test("chat.G5 G6 未解决的错误按连接、历史、停止顺序逐个显露", () => {
  const messages = {
    offline: "Disconnected", history: "History failed", stop: "Stop not confirmed",
    collaboration: "Collaboration failed", target: "Target failed",
  };
  for (const kind of ["offline", "history", "stop", "collaboration", "target"] as const) {
    assert.deepEqual(buildChatNotices(messages), [{ kind, message: messages[kind] }]);
    messages[kind] = "";
  }
  assert.deepEqual(buildChatNotices(messages), []);
});
