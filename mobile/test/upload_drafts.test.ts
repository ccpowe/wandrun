import assert from "node:assert/strict";
import { test } from "node:test";

import { ChatSession } from "../src/gateway/session.ts";
import { composerAction } from "../src/lib/chat-timeline.ts";
import { UPLOAD_CHUNK_BYTES, boundedReadRange, latestDraft, mimeForFile, restoreDraft, sendReadiness, type UploadItem } from "../src/lib/upload-draft-state.ts";

const ready: UploadItem = {
  id: "local", name: "参考.pdf", mediaType: "application/pdf", size: 37,
  progress: 37, fileId: "file-A", uploadUrl: "http://gateway/uploads/u", error: null,
};

test("附件必须拿到服务器 ID；进度到 100% 或纯文本都不能绕过未完成上传", () => {
  assert.deepEqual(sendReadiness({ text: "", items: [] }), { enabled: false, reason: "输入消息或添加附件" });
  assert.equal(sendReadiness({ text: "写摘要", items: [{ ...ready, fileId: null }] }).enabled, false);
  assert.equal(sendReadiness({ text: "", items: [{ ...ready, error: "超时" }] }).enabled, false);
  assert.equal(sendReadiness({ text: "", items: [ready] }).enabled, true);
  assert.equal(composerAction(true, "", 1, true), "send"); // attachment-only interrupts running turn
  assert.equal(composerAction(true, "写摘要", 1, false), "disabled");
  assert.equal(composerAction(true, "", 1, false), "disabled");
  assert.equal(composerAction(true, "", 0), "stop");
});

test("重启保留网关、对话上传元数据和 URL，不把最后一次在途进度当成完成", () => {
  const stored = { text: " 阅读附件 ", items: [{ ...ready, fileId: null, progress: 37, error: null }] };
  const loaded = restoreDraft(stored);
  assert.equal(loaded.text, stored.text);
  assert.equal(loaded.items[0].uploadUrl, ready.uploadUrl);
  assert.equal(loaded.items[0].progress, 0);
  assert.equal(sendReadiness(loaded).enabled, false);
  assert.equal(mimeForFile("clip.MP4"), "video/mp4");
  assert.equal(mimeForFile("notes.unknown", null), "application/octet-stream");
});

test("附件消息离线重试复用同一 client_id 与附件 ID，不用新正文替代旧命令", async () => {
  const bodies: Record<string, unknown>[] = [];
  const mock: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (bodies.length === 1) throw new TypeError("offline");
    return Response.json({ event: {
      seq: 12, type: "message.user", conversation_id: "conversation-1", at: 12,
      client_id: body.client_id, data: { text: body.text, attachments: [ready] },
    }, replayed: false });
  };

  const session = new ChatSession({ baseUrl: "http://gateway", token: "secret" }, mock);
  await session.send("conversation-1", "", [{ id: ready.fileId!, name: ready.name, size: ready.size, media_type: ready.mediaType }]);
  const pending = session.pendingFor("conversation-1")[0];
  assert.equal(pending.status, "failed");
  assert.equal(pending.retryable, true);
  assert.deepEqual(pending.attachments?.map((file) => file.id), ["file-A"]);
  await session.retry(pending.clientId);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[1].attachments, ["file-A"]);
  assert.equal(bodies[1].text, "");
  assert.equal(session.pendingFor("conversation-1").length, 0);
  await session.close();
});

test("1 GiB 原文件每段最多读取 5 MiB，末段按剩余字节读取", () => {
  const size = 1024 ** 3;
  assert.deepEqual(boundedReadRange(size, 0, Infinity), { count: UPLOAD_CHUNK_BYTES, done: false });
  assert.deepEqual(boundedReadRange(size, size - 11, Infinity), { count: 11, done: true });
  assert.deepEqual(boundedReadRange(0, 0, UPLOAD_CHUNK_BYTES), { count: 0, done: true });
});


test("中断覆盖一个槽位仍从另一个有效快照恢复上传 URL", () => {
  const previous = { text: "说明", items: [{ ...ready, fileId: null }] };
  const committed = JSON.stringify({ generation: 18, draft: previous });
  const interrupted = '{\"generation\":19,\"draft\":';
  assert.deepEqual(latestDraft([committed, interrupted]), { generation: 18, draft: previous });
  assert.deepEqual(latestDraft([null, null]), { generation: 0, draft: { text: "", items: [] } });
  assert.throws(() => latestDraft([interrupted, null]), /草稿快照无法读取/);
});
