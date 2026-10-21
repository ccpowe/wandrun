import assert from "node:assert/strict";
import test from "node:test";

import { messagePreview } from "../src/lib/message-preview.ts";
import { homeRowText } from "../src/lib/agent-list.ts";
import { applyLanguage } from "../src/lib/locale-store.ts";
import type { AgentSummary } from "../src/gateway/api.ts";

// The brief supplies visible prefixes, not full production messages; use a minimal Spec fixture.
const card = '```wandrun-ui\n{"root":"heading","elements":{"heading":{"type":"Heading","props":{"text":"资讯速览"}}}}\n```';

test("reported homepage prefixes become readable previews without changing the source", () => {
  const agent: AgentSummary = {
    id: "editor", name: "资讯主编", avatar: 0, description: "编辑", workers: [], home: true, unread: false,
    latest_conversation: { id: "c", title: "资讯", last_text: card, last_activity_seq: 1, last_activity_at: 1, status: "idle" },
  };
  assert.deepEqual(homeRowText(agent, null), { kind: "plain", text: "[交互卡片]" });
  assert.equal(agent.latest_conversation?.last_text, card);
  agent.latest_conversation!.last_text = "可以，改成图标速览版。**MiniMax M3.1 Flash**";
  assert.equal(homeRowText(agent, null).text, "可以，改成图标速览版。MiniMax M3.1 Flash");
});

test("UI blocks yield to outside prose and never expose JSON, including incomplete blocks", () => {
  assert.equal(messagePreview(card), "[交互卡片]");
  assert.equal(messagePreview(`${card}\n**今日资讯**`), "今日资讯");
  assert.equal(messagePreview(`开头\n${card}\n结尾`), "开头 结尾");
  assert.equal(messagePreview(`${card}\n${card}`), "[交互卡片]");
  assert.equal(messagePreview('```wandrun-ui\n{"secret":"unfinished'), "[交互卡片]");
});

test("Markdown tokens retain labels, CJK emphasis, inline code and formula source", () => {
  assert.equal(messagePreview('# 标题\n\n- **中文**加粗\n- *斜体*和`代码`\n\n> 引用\n\n[说明](https://example.com/private)'), "标题 中文加粗 斜体和代码 引用 说明");
  assert.equal(messagePreview(`读[文档][ref]\n${card}\n[ref]: https://example.com/private`), "读文档");
  assert.equal(messagePreview("公式 $x^2$"), "公式 x^2");
});

test("code blocks use placeholders rather than fences or body, including nested UI-looking code", () => {
  assert.equal(messagePreview('之前\n\n```python\nprint("secret")\n```\n\n之后'), "之前 [代码] 之后");
  assert.equal(messagePreview("    indented code\n"), "[代码]");
  assert.equal(messagePreview(`\`\`\`\`text\n${card}\n\`\`\`\``), "[代码]");
});

test("images retain alt text, attachments retain names, and whitespace collapses", () => {
  assert.equal(messagePreview("![图示](https://example.com/image.png) ![](attachment:private-id)", [{ name: "报告.pdf" }]), "图示 [图片] 报告.pdf");
  assert.equal(messagePreview(" 第一行\n\n第二行\t 第三行 "), "第一行 第二行 第三行");
  assert.equal(messagePreview("", [{ name: "报告.pdf" }]), "报告.pdf");
  for (const empty of [null, undefined, "", " \n\t ", "---"]) assert.equal(messagePreview(empty), "");
});

test("placeholder localization changes without translating message content", () => {
  applyLanguage("en");
  try {
    assert.equal(messagePreview(card), "[Interactive card]");
    assert.equal(messagePreview("```js\nlet x = 1;\n```"), "[Code]");
    assert.equal(messagePreview("![](https://example.com/image.png)"), "[Image]");
    assert.equal(messagePreview("**工作中**"), "工作中");
  } finally {
    applyLanguage("zh");
  }
});
