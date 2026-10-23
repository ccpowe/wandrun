import assert from "node:assert/strict";
import { test } from "node:test";

import { chatSubtitle } from "../src/lib/chat-header.ts";

const t = (message: string, values: Record<string, string | number> = {}) =>
  message.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

test("browser subtitle shows only its hostname, dropping www and all page details", () => {
  assert.equal(chatSubtitle({ title: "MemCurrent 博客解读", browserUrl: "https://www.Databricks.com/blog/article?x=1#top" }, t), "databricks.com");
  assert.equal(chatSubtitle({ title: "Notes", browserUrl: "http://docs.example.org:8080/very/long/path" }, t), "docs.example.org");
  assert.equal(chatSubtitle({ title: "Notes", browserUrl: "https://web.example.org/" }, t), "web.example.org");
});

test("invalid and non-web browser addresses fall back to the localized conversation context", () => {
  for (const browserUrl of ["https://", "not a url", "javascript:alert(1)", "file:///tmp/test", ""]) {
    assert.equal(chatSubtitle({ title: "Research", browserUrl }, t), "Research");
    assert.equal(chatSubtitle({ title: "", source: "schedule", browserUrl }, t), "定时 · 新对话");
    assert.equal(chatSubtitle({ title: "ignored", collaboration: { creatorName: "Alice", rootTitle: "根对话" }, browserUrl }, t), "Alice 发起 · 根对话");
  }
  assert.equal(chatSubtitle({ title: "" }, t), "新对话");
  assert.equal(chatSubtitle({ title: "ignored", collaboration: { creatorName: "Alice", rootTitle: "" } }, t), "Alice 发起 · 新对话");
});

