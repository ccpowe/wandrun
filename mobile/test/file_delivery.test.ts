import assert from "node:assert/strict";
import { test } from "node:test";

import type { FileRecord, SearchResult } from "../src/gateway/api.ts";
import { cacheName, previewKind, searchDestination, TEXT_PREVIEW_BYTES } from "../src/lib/file-delivery.ts";

const file: FileRecord = {
  id: "opaque/id", name: "report.md", size: 100, media_type: "text/markdown",
  conversation_id: "source", agent_id: "entry", task_id: "task", created_at: 100,
  remote_environment: null,
};

test("原文件仅以可安全呈现的内容类型预览，不将 PDF、HTML、SVG 或不明格式冒充文本", () => {
  assert.equal(previewKind(file), "text");
  assert.equal(previewKind({ media_type: "application/json; charset=utf-8" }), "text");
  assert.equal(previewKind({ media_type: "image/png" }), "image");
  for (const media_type of ["application/pdf", "text/html", "image/svg+xml", "application/octet-stream", "text/javascript"]) {
    assert.equal(previewKind({ media_type }), "other", media_type);
  }
  assert.equal(TEXT_PREVIEW_BYTES, 1024 * 1024);
});

test("搜索结果按真实来源导航：消息定位 seq，文件独立于可删除来源", () => {
  const results: SearchResult[] = [
    { kind: "agent", id: "entry", title: "Entry", text: "description" },
    { kind: "conversation", id: "source", title: "Title", agent_id: "entry" },
    { kind: "message", id: "msg", title: "Message", text: "content", conversation_id: "source", agent_id: "entry", seq: 42 },
    { kind: "file", id: file.id, title: file.name, file: { ...file, conversation_id: null, agent_id: null } },
  ];
  assert.deepEqual(results.map(searchDestination), [
    { pathname: "/agents/[id]", params: { id: "entry" } },
    { pathname: "/c/[id]", params: { id: "source" } },
    { pathname: "/c/[id]", params: { id: "source", message_seq: "42" } },
    { pathname: "/files/[id]", params: { id: "opaque/id" } },
  ]);
});

test("缓存短名不能变成设备路径，保留扩展名且原文件每次重新下载", () => {
  const original = { name: "../../report.md", media_type: "text/markdown" };
  const first = cacheName(original);
  const second = cacheName(original);
  assert.ok(!first.includes("/"));
  assert.ok(!first.includes("\\"));
  assert.notEqual(first, second);
  assert.ok(first.endsWith(".md"));
  const long = cacheName({ name: "报告".repeat(40) + ".txt", media_type: "text/plain" });
  assert.ok(Buffer.byteLength(long, "utf8") <= 255);
  assert.ok(long.endsWith(".txt"));
});
