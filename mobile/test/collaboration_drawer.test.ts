import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { ChatSession } from "../src/gateway/session.ts";
import type { BrowserTask } from "../src/gateway/api.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "expo-router") return { url: "data:text/javascript,export const router={setParams(){}}", shortCircuit: true };
  if (specifier === "react-native") return { url: "data:text/javascript,export const Alert={alert(){}}", shortCircuit: true };
  if (specifier.startsWith("@/")) return next(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
  return next(specifier, context);
} });
// Static import would load unavailable native modules before registerHooks installs hosts.
const { useConversationDrawer } = await import("../src/lib/use-conversation-drawer.ts");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("requested leases merge with unread attention on root and member rows, never on the selected row", async () => {
  const session = new ChatSession({ baseUrl: "http://drawer", token: "test" }, async () => new Response("{}"));
  session.agents.close();
  session["reset"]([{ id: "root", agent_id: "parent", title: "Root", status: "idle", unread: false,
    read_seq: 0, last_agent_seq: 0, created_at: 1, updated_at: 1, last_text: null, source: "user", schedule_origin: null }], 1);
  session["apply"]({ seq: 2, at: 2, type: "task.created", conversation_id: "root", data: {
    task_id: "child", creator_task_id: "root", creator_agent_id: "parent", agent_id: "member", title: "Child", status: "waiting",
    timeline_ids: ["root", "child"],
  } });
  session.tasks.get("child")!.unread = false;
  const lease: BrowserTask = { id: "lease", task_id: "child", root_id: "root", agent_id: "member", entry_agent_id: "parent",
    conversation_title: "Root", entry_agent_name: "Parent", state: "requested", epoch: 1, pages: [], current: null,
    max_pages: 3, reason: null, requested_reason: "需要确认" };
  session.browserTasks.set(lease.id, lease);
  const root = createRoot();
  function Probe({ currentId, agentId }: { currentId: string; agentId: string }) {
    const { drawerProps } = useConversationDrawer(session, currentId, agentId, false);
    return createElement("Drawer", drawerProps);
  }
  const render = async (currentId: string, agentId = "parent") => {
    await act(async () => root.render(createElement(Probe, { currentId, agentId })));
    return root.container.queryAll((node) => node.type === "Drawer")[0].props;
  };
  try {
    let props = await render("other");
    assert.equal(props.conversations[0].unread, true);
    assert.equal(props.collaborations[0].unread, true);
    props = await render("root");
    assert.equal(props.conversations[0].unread, false);
    assert.equal(props.collaborations[0].unread, true);
    props = await render("child", "member");
    assert.equal(props.conversations[0].unread, false);
    lease.state = "human";
    props = await render("other");
    assert.equal(props.conversations[0].unread, false);
    assert.equal(props.collaborations[0].unread, false);
    session.tasks.get("child")!.unread = true;
    props = await render("other");
    assert.equal(props.collaborations[0].unread, true, "ending takeover does not clear unread messages");
    session.tasks.get("child")!.unread = false;
    session.tasks.get("child")!.status = "failed";
    props = await render("other");
    assert.equal(props.collaborations[0].unread, true, "failure remains actionable without a requested lease");
  } finally { await act(async () => root.unmount()); await session.close(); }
});

test("协作抽屉的发起方、接收方和标题在目录失败或删除后都不回退随机 ID", async () => {
  const session = new ChatSession({ baseUrl: "http://drawer-names", token: "test" }, async () => new Response("{}"));
  session.agents.close();
  const parent = "a_11111111111111111111111111111111";
  const member = "a_22222222222222222222222222222222";
  session["apply"]({ seq: 1, at: 1, type: "task.created", conversation_id: "root", data: {
    task_id: "child", creator_task_id: "root", creator_agent_id: parent, agent_id: member,
    title: "核查官网", status: "completed", timeline_ids: ["root", "child"],
  } });
  const root = createRoot();
  function Probe({ agentId }: { agentId: string }) {
    return createElement("Drawer", useConversationDrawer(session, "other", agentId, false).drawerProps);
  }
  try {
    for (const state of ["loading", "failed", "named", "deleted"] as const) {
      session.agents.loaded = state === "named" || state === "deleted";
      session.agents.error = state === "failed" ? "目录不可用" : null;
      session.agents.agents = state === "named" ? [[parent, "规划员"], [member, "核查员"]].map(([id, name]) => ({
        id, name, avatar: 0, description: "", workers: [], home: true, latest_conversation: null, unread: false,
      })) : [];
      for (const outgoing of [true, false]) {
        await act(async () => root.render(createElement(Probe, { agentId: outgoing ? parent : member })));
        const props = root.container.queryAll(node => node.type === "Drawer")[0].props;
        const row = (outgoing ? props.collaborations : props.conversations)[0];
        const fallback = state === "deleted" ? "已删除的 Agent" : "Agent";
        assert.equal(props.agentName, state === "named" ? outgoing ? "规划员" : "核查员" : fallback);
        assert.equal(row.counterpart.name, state === "named" ? outgoing ? "核查员" : "规划员" : fallback);
        assert.equal(row.id, "child", "display fallback must not change navigation identity");
      }
    }
  } finally {
    await act(async () => root.unmount());
    await session.close();
  }
});
