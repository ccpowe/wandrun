import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExecutionEnvironment } from "../src/gateway/api.ts";
import {
  COLLAPSE_THRESHOLD, environmentState, environmentSubtitle, filterEnvironments, mainPageEnvironments, parseEnvironmentFilter,
  serverEnvironmentRows, type ServerEnvironmentRow,
} from "../src/lib/server-environments.ts";

const local: ExecutionEnvironment = { id: "local", name: "Local", type: "local", status: null };
const box = (id: string, status: string | null, name = id): ExecutionEnvironment => ({ id, name, type: "instabox", machine_id: id, status });
const task = (environment_id: string, pages: number, state: "agent" | "released" = "agent") =>
  ({ environment_id, state, pages: Array.from({ length: pages }, (_, i) => ({ id: `p${i}`, url: "", title: "" })) });

test("settings-computer C 映射：Instabox 全部 state 落到四个状态词，未知值不当作可用", () => {
  const cases: [string | null, string][] = [
    ["running", "running"], ["creating", "starting"], ["starting", "starting"], ["resuming", "starting"],
    ["suspending", "paused"], ["suspended", "paused"], ["stopping", "paused"], ["stopped", "paused"],
    ["error", "unavailable"], ["deleting", "unavailable"], ["deleted", "unavailable"], [null, "unavailable"], ["mystery", "unavailable"],
  ];
  for (const [status, state] of cases) assert.equal(environmentState(box("m", status)), state, String(status));
  assert.equal(environmentState(local), "local");
});

test("C1 / C6 副标题：本机不写状态词；无 Agent 写“没有 Agent 在用”；Agent 列表未知时只写状态词", () => {
  assert.equal(environmentSubtitle({ state: "local", agents: ["wand", "test"] }), "wand、test 在用");
  assert.equal(environmentSubtitle({ state: "running", agents: ["wand"] }), "运行中 · wand 在用");
  assert.equal(environmentSubtitle({ state: "paused", agents: [] }), "已暂停 · 没有 Agent 在用");
  assert.equal(environmentSubtitle({ state: "starting", agents: null }), "启动中");
  assert.equal(environmentSubtitle({ state: "local", agents: null }), undefined);
});

test("C1 / C3 / C7 派生：本机改名、按状态排序且同组保留网关顺序、Agent 与浏览器页面按环境归属", () => {
  const rows = serverEnvironmentRows(
    [local, box("p1", "suspended"), box("bad", "error"), box("r1", "running"), box("s1", "resuming"), box("r2", "running")],
    [{ name: "wand", environment: "r1" }, { name: "test", environment: "local" }, { name: "x", environment: "gone" }, { name: "w2", environment: "r1" }],
    [task("r1", 2), task("r1", 1), task("local", 1), task("p1", 3, "released"), task("gone", 1)],
  );
  assert.deepEqual(rows.map(row => [row.id, row.state, row.agents, row.browserPages]), [
    ["local", "local", ["test"], 1], ["r1", "running", ["wand", "w2"], 3], ["r2", "running", [], 0],
    ["s1", "starting", [], 0], ["bad", "unavailable", [], 0], ["p1", "paused", [], 0],
  ]);
  assert.equal(rows[0]!.name, "本机");
  assert.equal(serverEnvironmentRows([local], null, [])[0]!.agents, null);
});

const row = (id: string, state: ServerEnvironmentRow["state"], browserPages = 0): ServerEnvironmentRow => ({ id, name: id, state, agents: [], browserPages });

test("C2 需要关注：不超过阈值全列；超过时已暂停且无浏览器页面的收起并计数", () => {
  const few = [row("local", "local"), ...Array.from({ length: COLLAPSE_THRESHOLD - 1 }, (_, i) => row(`p${i}`, "paused"))];
  assert.deepEqual(mainPageEnvironments(few), { shown: few, hiddenPaused: 0 });
  const many = [row("local", "local"), row("r", "running"), row("s", "starting"), row("u", "unavailable"), row("pb", "paused", 2),
    ...Array.from({ length: 35 }, (_, i) => row(`p${i}`, "paused"))];
  const main = mainPageEnvironments(many);
  assert.deepEqual(main.shown.map(item => item.id), ["local", "r", "s", "u", "pb"]);
  assert.equal(main.hiddenPaused, 35);
});

test("E2 搜索与筛选：运行中含本机；名称不区分大小写、去首尾空格；两者同时生效；非法筛选按全部", () => {
  const rows = [row("本机", "local"), row("Wand-Box", "running"), row("wand-old", "paused"), row("ci", "starting"), row("gpu", "unavailable")];
  assert.deepEqual(filterEnvironments(rows, "running", "").map(item => item.id), ["本机", "Wand-Box"]);
  assert.deepEqual(filterEnvironments(rows, "all", "  WAND ").map(item => item.id), ["Wand-Box", "wand-old"]);
  assert.deepEqual(filterEnvironments(rows, "paused", "wand").map(item => item.id), ["wand-old"]);
  assert.deepEqual(filterEnvironments(rows, "starting", "wand"), []);
  assert.equal(parseEnvironmentFilter("paused"), "paused");
  assert.equal(parseEnvironmentFilter(undefined), "all");
  assert.equal(parseEnvironmentFilter("bogus"), "all");
});
