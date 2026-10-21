// 页面集合状态（pages.ts）：列表、当前页、提示队列。node --test test/

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeNotice, addNotice, applyPages, collapseNotices, currentPage, dismissNotice, EMPTY_PAGES, hostOf, NOTICE_MS,
  pageLabel, type PageInfo, type PagesMessage,
} from "../src/takeover-lab/pages.ts";

const page = (id: string, title = "", url = `https://${id}.example.com/path`): PageInfo => ({ id, title, url });
const snapshot = (current: string | null, ...pages: PageInfo[]): PagesMessage => ({ t: "pages", current, vp: 1, pages });

test("快照替换列表与当前页，页面增删都体现在列表里", () => {
  let state = applyPages(EMPTY_PAGES, snapshot("a", page("a", "A")));
  assert.deepEqual(state.pages.map((p) => p.id), ["a"]);
  assert.equal(currentPage(state)?.title, "A");
  state = applyPages(state, snapshot("a", page("a", "A"), page("b", "B")));
  assert.deepEqual(state.pages.map((p) => p.id), ["a", "b"]);
  state = applyPages(state, snapshot("a", page("a", "A改")));
  assert.deepEqual(state.pages.map((p) => p.id), ["a"]);
  assert.equal(pageLabel(currentPage(state)), "A改");
});

test("关闭当前页：快照返回上一页；最后一页关闭后没有当前页", () => {
  let state = applyPages(EMPTY_PAGES, snapshot("b", page("a"), page("b")));
  state = applyPages(state, snapshot("a", page("a")));
  assert.equal(state.current, "a");
  state = applyPages(state, snapshot(null));
  assert.equal(state.current, null);
  assert.equal(currentPage(state), null);
});

test("新页面提示：入队、同页不重复、已是当前页不提示", () => {
  let state = applyPages(EMPTY_PAGES, snapshot("a", page("a")));
  state = addNotice(state, page("b", "B"), 1000);
  state = addNotice(state, page("b", "B"), 1100);
  assert.equal(state.notices.length, 1);
  state = addNotice(state, page("a"), 1200);
  assert.equal(state.notices.length, 1);
  state = addNotice(state, page("c", "C"), 2000);
  const active = activeNotice(state)!;
  assert.equal(active.page?.id, "c"); // 最新的一条在前，之前的算“还有”
  assert.equal(active.more, 1);
});


test("提示作废：切到该页、该页被关闭；手动关闭只去掉提示", () => {
  let state = applyPages(EMPTY_PAGES, snapshot("a", page("a"), page("b"), page("c")));
  state = addNotice(state, page("b"), 1000);
  state = addNotice(state, page("c"), 1000);
  state = applyPages(state, snapshot("b", page("a"), page("b"), page("c"))); // 切到 b
  assert.deepEqual(state.notices.map((n) => n.key), ["c"]);
  state = applyPages(state, snapshot("b", page("a"), page("b"))); // c 被关
  assert.equal(state.notices.length, 0);
  state = addNotice(state, page("d"), 3000);
  state = dismissNotice(state, "d");
  assert.equal(activeNotice(state), null);
});

test("自动收起：超时的提示收起，页面仍在列表里", () => {
  let state = applyPages(EMPTY_PAGES, snapshot("a", page("a"), page("b")));
  state = addNotice(state, page("b"), 1000);
  assert.equal(collapseNotices(state, 1000 + NOTICE_MS - 1), state);
  state = collapseNotices(state, 1000 + NOTICE_MS);
  assert.equal(activeNotice(state), null);
  assert.deepEqual(state.pages.map((p) => p.id), ["a", "b"]);
});


test("标签：标题优先，其次域名，再次空白页", () => {
  assert.equal(pageLabel(page("a", "标题")), "标题");
  assert.equal(pageLabel(page("a", " ", "https://docs.example.com:8080/x?y")), "docs.example.com:8080");
  assert.equal(pageLabel(page("a", "", "")), "空白页");
  assert.equal(hostOf("about:blank"), "about:blank");
});

