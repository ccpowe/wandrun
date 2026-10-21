import assert from "node:assert/strict";
import { test } from "node:test";

import { messageText, messageTextForItem, prependQuote, quotePreview } from "../src/lib/message-actions.ts";
import { buildItems } from "../src/lib/chat-timeline.ts";
import type { GatewayEvent } from "../src/gateway/api.ts";
import type { Pending } from "../src/gateway/session.ts";

const ui = (spec: unknown) => `\`\`\`wandrun-ui\n${JSON.stringify(spec)}\n\`\`\``;
const rich = {
  root: "card", state: { secret: "private state" },
  elements: {
    card: { type: "Card", props: { title: "出行建议" }, children: ["text", "choice", "image"] },
    text: { type: "Text", props: { text: "带好雨伞" } },
    choice: { type: "ChoiceGroup", props: { label: "目的地", stateKey: "secret", options: [{ value: "internal-id", label: "西湖", description: "两日游" }] } },
    image: { type: "Image", props: { url: "https://private.invalid/image", alt: "路线图" } },
    unused: { type: "Text", props: { text: "未展示节点" } },
  },
};
function event(type: string, text = "消息", attachments: unknown[] = []): GatewayEvent {
  return { seq: 1, type, conversation_id: "c", at: 1, data: { text, attachments } };
}

test("copy preserves exact Markdown; quotes flatten emphasis, paragraphs, links and code", () => {
  const source = "# 标题\n\n**第一段**与[链接](https://example.com)\n\n第二段 `x()`\n\n```py\nprint(1)\n```\n";
  assert.deepEqual(messageText(source), {
    copy: source,
    quote: "标题\n\n第一段与链接\n\n第二段 x()\n\nprint(1)",
  });
  assert.deepEqual(messageText("我的 **原文**", [], false), { copy: "我的 **原文**", quote: "我的 **原文**" });
});

test("UI blocks become reachable display summaries, without JSON, state, bindings or URLs", () => {
  const result = messageText(`前文\n\n${ui(rich)}\n\n**后文**`, [{ name: "方案.pdf" }]);
  assert.equal(result.quote, "前文\n\n出行建议\n带好雨伞\n目的地\n西湖\n两日游\n路线图\n\n后文\n\n方案.pdf");
  assert.ok(result.copy.includes("**后文**"));
  for (const hidden of ["wandrun-ui", "private state", "stateKey", "internal-id", "private.invalid", "未展示节点"]) {
    assert.ok(!result.copy.includes(hidden), hidden);
  }
});

test("malformed, incomplete and textless UI blocks are skipped, not leaked as JSON", () => {
  for (const block of ["```wandrun-ui\n{broken\n```", "```wandrun-ui\n{secret", ui({ root: "x", elements: { x: { type: "Spacer", props: { size: "lg" } } } }), ui(null)]) {
    assert.deepEqual(messageText(block, [{ name: "image.png" }]), { copy: "image.png", quote: "image.png" });
  }
  assert.equal(messageText(ui({ root: "x", elements: { x: { props: { text: "可读" }, children: ["x"] } } })).quote, "可读");
});

test("ordinary code fences shield literal UI examples and reference links resolve across UI blocks", () => {
  const source = "````md\n```wandrun-ui\n{example}\n```\n````";
  assert.equal(messageText(source).copy, source);
  assert.ok(messageText(source).quote.includes("{example}"));
  assert.equal(messageText(`[站点][site]\n\n${ui(rich)}\n\n[site]: https://example.com`).quote.startsWith("站点\n\n出行建议"), true);
});

test("attachment-only messages copy names in delivery order, never metadata", () => {
  const item = { key: "e1", event: event("message.agent", "", [{ id: "secret-id", name: "甲.pdf", size: 200 }, { name: "乙.png" }]) };
  assert.deepEqual(messageTextForItem(item), { copy: "甲.pdf\n乙.png", quote: "甲.pdf\n乙.png" });
});

test("quotes keep all lines inside the block and preserve the typed draft", () => {
  assert.equal(prependQuote("  解释原因\n下一行", "第一段\n\n第二段\r\n> 已引用"), "> 第一段\n> \n> 第二段\n> > 已引用\n\n  解释原因\n下一行");
  assert.equal(prependQuote("草稿", null), "草稿");
  assert.equal(prependQuote("草稿", " \n "), "草稿");
  assert.equal(prependQuote("", "附件.pdf"), "> 附件.pdf\n\n");
  assert.equal(prependQuote("答复", "a\u2028b\rc"), "> a\n> b\n> c\n\n答复");
});

test("quote truncation counts Unicode code points, includes an ellipsis and is idempotent", () => {
  assert.equal(quotePreview("😀".repeat(2000)), "😀".repeat(2000));
  const truncated = quotePreview("😀".repeat(2001));
  assert.equal(truncated, "😀".repeat(1999) + "…");
  assert.equal(quotePreview(truncated), truncated);
  assert.equal(prependQuote("问题", "😀".repeat(2001)), `> ${truncated}\n\n问题`);
});

test("persisted user/Agent messages and pending/failed sends retain actions", () => {
  for (const type of ["message.user", "message.agent"]) {
    assert.deepEqual(messageTextForItem({ key: "e1", event: event(type) }), { copy: "消息", quote: "消息" });
  }
  for (const status of ["sending", "failed"] as const) {
    const pending: Pending = { clientId: "p", conversationId: "c", text: "未发送", status, error: "离线", retryable: false };
    assert.deepEqual(messageTextForItem({ key: "p", pending }), { copy: "未发送", quote: "未发送" });
  }
});

test("system/generation rows and absent/empty content do not offer actions", () => {
  for (const type of ["context.compacted", "context.compaction_failed", "takeover.ended", "turn.failed", "turn.stopped", "conversation.status", "message.retracted"]) {
    assert.equal(messageTextForItem({ key: "e1", event: event(type) }), null);
  }
  assert.equal(messageTextForItem({ key: "empty" }), null);
  assert.equal(messageTextForItem({ key: "e1", event: event("message.agent", "  ") }), null);
  assert.equal(messageTextForItem({ key: "e1", event: event("message.agent", "```wandrun-ui\n{incomplete") }), null);
});

test("a later turn failure leaves already delivered content actionable", () => {
  const events = [event("message.agent", "已完成的内容"), { ...event("turn.failed"), seq: 2 }];
  assert.deepEqual(buildItems(events, []).map(messageTextForItem), [{ copy: "已完成的内容", quote: "已完成的内容" }, null]);
});

test("Table, Metrics and KeyValue copy their display values, not form option identifiers", () => {
  const cases = [
    { type: "Table", props: { columns: ["项目", "金额", "状态"], rows: [["房租", "3000元", { badge: { text: "已付", tone: "success" } }], ["电费", "200元", "待付"]] },
      expected: "项目\t金额\t状态\n房租\t3000元\t已付\n电费\t200元\t待付" },
    { type: "Metrics", props: { items: [{ label: "收入", value: "12800元", hint: "税后" }, { label: "结余", value: "9600元" }] },
      expected: "收入：12800元\n税后\n结余：9600元" },
    { type: "KeyValue", props: { items: [{ label: "截止日期", value: "2026-10-20" }] },
      expected: "截止日期：2026-10-20" },
    { type: "ChoiceGroup", props: { stateKey: "choice", options: [{ label: "公开方案", value: "private-id" }, { label: "另一方案", value: "other-id" }] },
      expected: "公开方案\n另一方案" },
  ];
  for (const { type, props, expected } of cases) {
    const text = ui({ root: "root", elements: { root: { type, props } }, state: { choice: "private-id" } });
    const result = messageTextForItem({ key: "e1", event: event("message.agent", text) });
    assert.ok(result, `${type} must remain actionable`);
    assert.equal(result.copy.trim(), expected);
    assert.equal(prependQuote("问题", quotePreview(result.quote)), `${expected.split("\n").map((line) => `> ${line}`).join("\n")}\n\n问题`);
  }
});

test("UI display text stays literal alongside document-wide Markdown references", () => {
  const literal = "文件名 __init__.py\n*literal* [link][site]\n# Heading\n> not a quote";
  const block = ui({ root: "root", elements: { root: { type: "Text", props: { text: literal } } } });
  const source = `**前文** [站点][site]\n\n${block}\n\n[后文][site]\n\n[site]: https://example.com`;
  const result = messageTextForItem({ key: "e1", event: event("message.agent", source) })!;
  assert.equal(result.quote, `前文 站点\n\n${literal}\n\n后文`);
  assert.ok(result.copy.includes(literal));
});

test("user and pending text preserve complete, broken and unfinished UI fences verbatim", () => {
  for (const text of [`  原文\n${ui(rich)}\n结束  `, "```wandrun-ui\n{broken}\n```", "```wandrun-ui\n{unfinished"]) {
    const attachments = [{ id: "f", name: "example.json", size: 1, media_type: "application/json" }];
    const items = [
      { key: "e1", event: event("message.user", text, attachments) },
      ...(["sending", "failed"] as const).map((status) => ({
        key: "p", pending: { clientId: "p", conversationId: "c", text, attachments, status, error: null, retryable: true },
      })),
    ];
    for (const item of items) {
      const expected = `${text}\n\nexample.json`;
      assert.deepEqual(messageTextForItem(item), { copy: expected, quote: expected });
    }
  }
});

test("the full Agent quote path preserves original and nested blockquote attribution", () => {
  const source = "> 原话\n>\n> 第二段\n>\n> > 更早的原话\n\n我的解释";
  const result = messageTextForItem({ key: "e1", event: event("message.agent", source) })!;
  assert.equal(prependQuote("为什么？", quotePreview(result.quote)),
    "> > 原话\n> > \n> > 第二段\n> > \n> > > 更早的原话\n> \n> 我的解释\n\n为什么？");
});

test("quote truncation applies after Agent blockquote projection without cutting emoji", () => {
  const result = messageTextForItem({ key: "e1", event: event("message.agent", `> ${"😀".repeat(2100)}\n\n解释`) })!;
  const preview = quotePreview(result.quote);
  assert.equal(Array.from(preview).length, 2000);
  assert.equal(prependQuote("继续", preview), `> > ${"😀".repeat(1997)}…\n\n继续`);
});

test("incoming and outgoing collaboration messages preserve copy Markdown and produce usable quotes with filenames", () => {
  for (const [sender, recipient] of [["root", "child"], ["child", "root"]]) {
    const entry = event("message.task", "**结果**：323\n\n[依据](https://example.com)", [{ name: "计算.txt" }]);
    Object.assign(entry.data, { sender_task_id: sender, recipient_task_id: recipient });
    const result = messageTextForItem({ key: "task-message", event: entry });
    assert.deepEqual(result, {
      copy: "**结果**：323\n\n[依据](https://example.com)\n\n计算.txt",
      quote: "结果：323\n\n依据\n\n计算.txt",
    });
    assert.equal(prependQuote("请复核", result!.quote), "> 结果：323\n> \n> 依据\n> \n> 计算.txt\n\n请复核");
  }
});
