import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, Fragment } from "react";
import { createRoot } from "test-renderer";
import { readFileSync } from "node:fs";

import { parseRichSpec } from "../src/components/rich-message/spec.ts";
import { useUiDraft } from "../src/components/rich-message/use-ui-draft.ts";
import { GatewayError, type GatewayEvent } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { authorizedImageFiles, splitAgentMessage } from "../src/lib/agent-message.ts";
import { parseMessageMarkdown } from "../src/lib/agent-message-markdown.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fenceCases = JSON.parse(readFileSync(new URL("../../tests/fixtures/ui_fences.json", import.meta.url), "utf8")) as
  { text: string; blocks: { block: number; closed: boolean; source: string }[] }[];
const markdownImageCases = JSON.parse(readFileSync(new URL("../../tests/fixtures/ui_markdown_images.json", import.meta.url), "utf8")) as
  { text: string; urls: string[] }[];

test("Markdown image positions are stable across UI fences, quotes, footnotes and code", () => {
  for (const { text, urls } of markdownImageCases) {
    const parsed = parseMessageMarkdown(splitAgentMessage(text));
    const seen: { src: string; index: number }[] = [];
    const walk = (tokens: typeof parsed.tail) => {
      for (const token of tokens) {
        if (token.type === "image") seen.push({ src: token.attrGet("src") || "", index: token.meta.wandrunMediaIndex });
        else if (token.children) walk(token.children);
      }
    };
    for (const tokens of parsed.chunks.values()) walk(tokens);
    walk(parsed.tail);
    assert.deepEqual(seen, urls.map((src, index) => ({ src, index })));
  }
});

test("共享围栏向量和网关保持相同 UI block 身份、闭合状态及原文", () => {
  for (const { text, blocks } of fenceCases) {
    assert.deepEqual(splitAgentMessage(text).filter((segment) => segment.kind === "ui"), blocks.map((part) => ({ kind: "ui", ...part })));
  }
});
test("图片授权只接受当前消息 image 附件的精确路径与 file id", () => {
  const attachments = [
    { id: "img-1", media_type: "image/png" },
    { id: "doc-1", media_type: "application/pdf" },
  ];
  const status = { valid: true, files: {
    "dir/照片.png": "img-1", "dir/照片.PNG": "doc-1",
    "dir/照片.png/": "missing", "other.png": "img-1",
  } };
  assert.deepEqual({ ...authorizedImageFiles(status, attachments) }, {
    "dir/照片.png": "img-1", "other.png": "img-1",
  });
  assert.equal(authorizedImageFiles({ ...status, valid: false }, attachments), undefined);
  assert.equal(authorizedImageFiles(status, undefined), undefined);
  assert.deepEqual({ ...authorizedImageFiles(status, [{ id: "img-1", media_type: "video/mp4" }]) }, {});
});


const ui = '{"root":"card","elements":{}}';
const event = (seq: number, type: string, data: Record<string, unknown>, clientId?: string): GatewayEvent =>
  ({ seq, type, conversation_id: "conversation", at: 1_761_000_000 + seq, data, client_id: clientId });
const userSubmission = (seq: number, messageSeq: number, block: number, values: Record<string, unknown>): GatewayEvent =>
  event(seq, "message.user", { text: `提交 ${seq}`, attachments: [], ui_submission: { message_seq: messageSeq, block, values } }, `client-${seq}`);

function sessionWith(fetchImpl: typeof fetch): ChatSession {
  const session = new ChatSession({ baseUrl: "https://gateway.test", token: "dev" }, fetchImpl);
  session.agents.close();
  session.conversations.set("conversation", {
    id: "conversation", agent_id: "agent", title: "对话", source: "user", schedule_origin: null,
    created_at: 1, updated_at: 1, read_seq: 0, status: "idle", unread: false, last_text: null,
    activity: null, lastTextSeq: 0, lastActivityAt: null, lastAgentSeq: 0,
  });
  return session;
}

test("精确 wandrun-ui 围栏分段，保持普通代码与段落顺序及完整内容", () => {
  const message = `引言\n\n\`\`\`tsx\n<Widget />\n\`\`\`\n\n   ~~~~wandrun-ui\n${ui}\n   ~~~~ \t\n尾声\n\n\`\`\`wandrun-ui\n${ui}\n\`\`\`\n结束`;
  assert.deepEqual(splitAgentMessage(message), [
    { kind: "markdown", text: "引言\n\n```tsx\n<Widget />\n```\n\n" },
    { kind: "ui", source: `${ui}\n`, block: 0, closed: true },
    { kind: "markdown", text: "尾声\n\n" },
    { kind: "ui", source: `${ui}\n`, block: 1, closed: true },
    { kind: "markdown", text: "结束" },
  ]);
});

test("普通 fence 屏蔽内嵌 UI，extra info 不算 UI；未闭合 UI 占 block 且必须 fallback", () => {
  const ordinary = `\`\`\`js\n\`\`\`wandrun-ui\n${ui}\n\`\`\`\n`;
  const unfinished = `~~~~wandrun-ui\n${ui}\n   ~~~\n`;
  assert.deepEqual(splitAgentMessage(ordinary + unfinished), [
    { kind: "markdown", text: ordinary },
    { kind: "ui", source: `${ui}\n   ~~~\n`, block: 0, closed: false },
  ]);
  assert.deepEqual(splitAgentMessage(`    \`\`\`wandrun-ui\n${ui}\n    \`\`\``), [
    { kind: "markdown", text: `    \`\`\`wandrun-ui\n${ui}\n    \`\`\`` },
  ]);
  assert.deepEqual(splitAgentMessage(`\`\`\`wandrun-ui\`bad\n${ui}\n\`\`\``), [
    { kind: "markdown", text: `\`\`\`wandrun-ui\`bad\n${ui}\n\`\`\`` },
  ]);
  assert.deepEqual(splitAgentMessage(`~~~wandrun-ui extra\n${ui}\n~~~`), [
    { kind: "markdown", text: `~~~wandrun-ui extra\n${ui}\n~~~` },
  ]);
  assert.deepEqual(splitAgentMessage(`~~~ wandrun-ui  \r\n${ui}\r\n~~~\r\n\`\`\`wandrun-ui\n${ui}`), [
    { kind: "ui", source: `${ui}\r\n`, block: 0, closed: true },
    { kind: "ui", source: ui, block: 1, closed: false },
  ]);
});

test("整条消息解析跨 UI 块的链接与脚注定义，保留同一脚注正文", () => {
  const text = "请读[文档][guide]并参考脚注[^note]。\n\n```wandrun-ui\n{}\n```\n\n[guide]: https://example.com/docs\n\n[^note]: 来自周报";
  const segments = splitAgentMessage(text);
  const { chunks, tail } = parseMessageMarkdown(segments);
  const first = chunks.get(0)!;
  const inline = first.find((token) => token.type === "inline")!;
  assert.equal(inline.children?.find((token) => token.type === "link_open")?.attrGet("href"), "https://example.com/docs");
  assert.equal(inline.children?.find((token) => token.type === "footnote_ref")?.meta.label, "note");
  assert.equal(tail.length, 0);
  const last = chunks.get(2)!;
  assert.ok(last.some((token) => token.type === "footnote_block_open"));
  assert.ok(last.some((token) => token.type === "inline" && token.content === "来自周报"));
});

test("末尾 UI 块后仍绘制整条消息的脚注尾注", () => {
  const segments = splitAgentMessage("[^source]: 发布说明\n\n见脚注[^source]\n\n```wandrun-ui\n{}\n```");
  const { chunks, tail } = parseMessageMarkdown(segments);
  assert.ok(chunks.get(0)?.some((token) => token.type === "inline" && token.children?.some((child) => child.type === "footnote_ref")));
  assert.ok(tail.some((token) => token.type === "inline" && token.content === "发布说明"));
});

test("消息行卸载重挂恢复草稿、在途身份及未知结果重试，权威事件清理会话草稿", async () => {
  const source = JSON.stringify({ root: "card", elements: {
    card: { type: "Card", props: {}, children: ["choice", "submit"] },
    choice: { type: "ChoiceGroup", props: { stateKey: "choice", options: [{ value: "A", label: "甲" }, { value: "B", label: "乙" }] }, children: [] },
    submit: { type: "Submit", props: { label: "确定" }, children: [] },
  }, state: { choice: "A" } });
  const spec = parseRichSpec(source)!;
  let fail!: (error: Error) => void;
  let offline = true;
  const requests: { client_id: string; values: Record<string, unknown> }[] = [];
  const winner = userSubmission(42, 3, 0, { choice: "B" });
  const session = sessionWith(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (offline) await new Promise<never>((_resolve, reject) => { fail = reject; });
    return Response.json({ event: winner, replayed: false });
  });
  const owner = { session, conversationId: "conversation", messageSeq: 3, block: 0 };
  let card!: ReturnType<typeof useUiDraft>;
  function Card() {
    card = useUiDraft(spec, session.submissionsFor("conversation", 3).get(0), owner,
      (values, clientId) => session.submitUi("conversation", 3, 0, values, clientId));
    return createElement("card");
  }
  const root = createRoot();
  try {
    session["apply"](event(3, "message.agent", { text: source }));
    await act(async () => { root.render(createElement(Card)); });
    await act(async () => { card.store.set("/choice", "B"); });
    assert.deepEqual(session.uiDraftFor("conversation", 3, 0)?.values, { choice: "B" });
    let first!: Promise<void>;
    await act(async () => { first = card.send(); });
    assert.equal(session.uiDraftFor("conversation", 3, 0)?.pending, true);
    await act(async () => { root.render(createElement(Fragment)); });
    await act(async () => { root.render(createElement(Card)); });
    assert.equal(card.store.getSnapshot().choice, "B");
    assert.equal(card.currentDraft.pending, true);
    assert.equal(card.disabled, true);
    await act(async () => { fail(new Error("connection lost")); await first; });
    assert.equal(card.currentDraft.error?.retryable, true);
    const retained = session.uiDraftFor("conversation", 3, 0)?.attempt;
    assert.deepEqual({ ...retained?.values }, { choice: "B" });
    await act(async () => { root.render(createElement(Fragment)); });
    await act(async () => { root.render(createElement(Card)); });
    assert.equal(card.currentDraft.attempt?.clientId, retained?.clientId);
    assert.equal(card.currentDraft.error?.retryable, true);
    offline = false;
    await act(async () => { await card.send(true); });
    assert.equal(requests[0].client_id, requests[1].client_id);
    assert.deepEqual(requests.map(({ values }) => values), [{ choice: "B" }, { choice: "B" }]);
    assert.equal(session.uiDraftFor("conversation", 3, 0), undefined);
    await act(async () => { root.render(createElement(Fragment)); });
    await act(async () => { root.render(createElement(Card)); });
    assert.equal(card.disabled, true);
  } finally {
    await act(async () => { root.unmount(); });
    await session.close();
  }
});

test("只接受指向本对话过去消息的 user 提交元数据，不把无关字段误作只读", async () => {
  const session = sessionWith(async () => { throw new Error("No HTTP expected"); });
  try {
    session["apply"](event(3, "message.agent", { text: ui }));
    session["apply"](event(4, "message.agent", { ui_submission: { message_seq: 3, block: 0, values: { choice: "wrong" } } }));
    session["apply"](userSubmission(5, 5, 0, { choice: "future" }));
    session["apply"](event(6, "message.user", { ui_submission: { message_seq: 3, block: 0, values: [] } }));
    assert.equal(session.submissionsFor("conversation", 3).size, 0);
  } finally {
    await session.close();
  }
});

test("历史晚到的首条提交胜过 SSE 中较新的提交；重复 seq 去重，其他 block 独立", async () => {
  const first = userSubmission(8, 3, 0, { choice: "first" });
  const later = userSubmission(12, 3, 0, { choice: "later" });
  const secondBlock = userSubmission(13, 3, 1, { count: 2 });
  const session = sessionWith(async (url) => {
    if (String(url).includes("/events?")) return Response.json({ events: [first], as_of_seq: 13 });
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    session["apply"](event(3, "message.agent", { text: "````wandrun-ui\\n{}\\n````" }));
    session["apply"](later);
    session["apply"](secondBlock);
    assert.deepEqual(session.submissionsFor("conversation", 3).get(0)?.values, { choice: "later" });
    await session.loadOlder("conversation");
    assert.deepEqual(session.submissionsFor("conversation", 3).get(0), {
      seq: 8, values: { choice: "first" }, createdAt: new Date(first.at * 1000).toISOString(),
    });
    assert.deepEqual(session.submissionsFor("conversation", 3).get(1)?.values, { count: 2 });
    session["apply"](first);
    assert.equal(session.timeline("conversation").events.filter(({ seq }) => seq === 8).length, 1);
    assert.equal(session.conversations.get("conversation")!.last_text, "提交 13");
  } finally {
    await session.close();
  }
});

test("未知网络结果沿原 client_id 重放，响应合并后用户摘要/卡片只读仅出现一次", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let offline = true;
  const accepted = userSubmission(20, 3, 0, { choice: "B" });
  const session = sessionWith(async (url, init) => {
    requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
    if (offline) throw new Error("network unavailable");
    return Response.json({ event: accepted, replayed: true });
  });
  try {
    session["apply"](event(3, "message.agent", { text: ui }));
    await assert.rejects(session.submitUi("conversation", 3, 0, { choice: "B" }, "stable"),
      (error: unknown) => error instanceof GatewayError && error.status === 0);
    assert.equal(session.submissionsFor("conversation", 3).size, 0);
    offline = false;
    await session.submitUi("conversation", 3, 0, { choice: "B" }, "stable");
    session["apply"](accepted); // SSE raced with the command response.
    assert.deepEqual(requests, [
      { path: "/conversations/conversation/ui-submissions", body: { client_id: "stable", message_seq: 3, block: 0, values: { choice: "B" } } },
      { path: "/conversations/conversation/ui-submissions", body: { client_id: "stable", message_seq: 3, block: 0, values: { choice: "B" } } },
    ]);
    assert.deepEqual(session.submissionsFor("conversation", 3).get(0)?.values, { choice: "B" });
    assert.equal(session.conversations.get("conversation")?.last_text, "提交 20");
    assert.equal(session.timeline("conversation").events.filter(({ seq }) => seq === 20).length, 1);
  } finally {
    await session.close();
  }
});

test("409 直接合并历史窗口外的获胜事件，无需最新页请求", async () => {
  const winner = userSubmission(42, 3, 0, { choice: "other" });
  const calls: string[] = [];
  const session = sessionWith(async (url, init) => {
    calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
    if (init?.method === "GET") throw new Error("Unexpected history request");
    return Response.json({ error: { code: "ui_already_submitted", message: "已提交", details: { event: winner } } }, { status: 409 });
  });
  try {
    session["apply"](event(3, "message.agent", { text: ui }));
    session.timeline("conversation").oldest = 3;
    await assert.rejects(session.submitUi("conversation", 3, 0, { choice: "ours" }, "ours"),
      (error: unknown) => error instanceof GatewayError && error.code === "ui_already_submitted");
    assert.deepEqual(calls, ["POST /conversations/conversation/ui-submissions"]);
    assert.deepEqual(session.submissionsFor("conversation", 3).get(0)?.values, { choice: "other" });
    assert.equal(session.timeline("conversation").oldest, 3); // Winner at seq 42 is outside the newest page.
  } finally {
    await session.close();
  }
});

test("网关的 404/400 错误保留业务代码与字段原因供界面提示", async () => {
  for (const [status, code, details] of [
    [404, "ui_block_not_found", undefined],
    [400, "ui_invalid_values", { stateKey: "choice", reason: "选项已失效" }],
  ] as const) {
    const session = sessionWith(async () => Response.json({ error: { code, message: "拒绝", details } }, { status }));
    try {
      await assert.rejects(session.submitUi("conversation", 3, 0, { choice: "bad" }, "same"),
        (error: unknown) => {
          if (!(error instanceof GatewayError)) return false;
          assert.deepEqual(error.details, details);
          return error.status === status && error.code === code;
        });
      assert.equal(session.submissionsFor("conversation", 3).size, 0);
    } finally {
      await session.close();
    }
  }
});
