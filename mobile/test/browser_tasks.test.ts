import assert from "node:assert/strict";
import { test } from "node:test";

import type { BrowserTask } from "../src/gateway/api.ts";
import { activeBrowserPages, groupBrowserPages, prioritizeBrowserPages } from "../src/lib/browser-tasks.ts";

function lease(id: string, over: Partial<BrowserTask> = {}): BrowserTask {
  return {
    id, task_id: `task-${id}`, root_id: `root-${id}`, agent_id: "delegate", entry_agent_id: "team",
    conversation_title: "本周新闻", entry_agent_name: "自媒体团队", state: "agent", epoch: 1,
    pages: [{ id: `${id}-one`, title: "登录 X", url: "https://x.com/login" }], current: `${id}-one`,
    max_pages: 4, reason: null, requested_reason: null, ...over,
  };
}

test("入口 Agent 包含委派成员的多页，释放租约/零页面不计数", () => {
  const tasks = [
    lease("a", { pages: [
      { id: "one", title: "X", url: "https://x.com" },
      { id: "two", title: "新闻", url: "https://example.com" },
    ] }),
    lease("b", { entry_agent_id: "other", entry_agent_name: "代码团队" }),
    lease("c", { state: "released" }),
    lease("d", { pages: [] }),
  ];
  assert.deepEqual(activeBrowserPages(tasks, "team").map(({ page }) => page.id), ["one", "two"]);
  const groups = groupBrowserPages(activeBrowserPages(tasks));
  assert.deepEqual(groups.map(({ agentId, pages }) => [agentId, pages.length]), [["team", 2], ["other", 1]]);
  assert.equal(groups[0].agentName, "自媒体团队");
  assert.equal(groups[0].pages[0].task.agent_id, "delegate");
});

test("资料优先突出请求接管的当前页，同时不遗漏其它页面", () => {
  const tasks = [
    lease("idle"),
    lease("request", { state: "requested", current: "later", pages: [
      { id: "first", title: "首页", url: "https://example.com" },
      { id: "later", title: "登录", url: "https://example.com/login" },
    ] }),
  ];
  assert.deepEqual(prioritizeBrowserPages(activeBrowserPages(tasks)).map(({ page }) => page.id), ["later", "first", "idle-one"]);
});
