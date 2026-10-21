// 对话列表抽屉的切换与防重（纯 JS）。动画 worklet 不在 Node 里运行，那部分只能真机验证。

import assert from "node:assert/strict";
import { test } from "node:test";

import { DrawerFlow, drawerTransition } from "../src/lib/drawer-flow.ts";

function setup(blank: () => Promise<string> = async () => "blank", hasConversation: (id: string) => boolean = () => true) {
  const log: string[] = [];
  const failures: unknown[] = [];
  const flow = new DrawerFlow({
    currentId: "cur",
    blankConversation: blank,
    hasConversation,
    navigate: (id) => log.push(`go:${id}`),
    setOpen: (open) => log.push(open ? "open" : "close"),
    failed: (error) => failures.push(error),
  });
  return { flow, log, failures };
}

function deferred() {
  let resolve!: (id: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("选另一个对话：先关抽屉，关闭动画结束后才导航", () => {
  const { flow, log } = setup();
  flow.show();
  flow.select("other");
  assert.deepEqual(log, ["open", "close"]); // 动画还没结束，不导航
  flow.onClosed();
  assert.deepEqual(log, ["open", "close", "go:other"]);
});

test("选当前对话：只关闭，不导航", () => {
  const { flow, log } = setup();
  flow.show();
  flow.select("cur");
  flow.onClosed();
  assert.deepEqual(log, ["open", "close"]);
});

test("关闭动画进行中的重复点击被忽略，只导航一次", () => {
  const { flow, log } = setup();
  flow.show();
  flow.select("a");
  flow.select("b");
  flow.select("a");
  flow.onClosed();
  assert.deepEqual(log, ["open", "close", "go:a"]);
});

test("关闭后再次打开，防重重置，可以再选", () => {
  const { flow, log } = setup();
  flow.show();
  flow.select("cur");
  flow.onClosed();
  flow.show();
  flow.select("a");
  flow.onClosed();
  assert.deepEqual(log.slice(-2), ["close", "go:a"]);
});

test("新对话：连点只创建 / 导航一次，目标是当前对话时（复用空对话）不导航", async () => {
  let calls = 0;
  const { flow, log } = setup(async () => (++calls, "cur"));
  flow.show();
  await Promise.all([flow.newConversation(), flow.newConversation()]);
  flow.onClosed();
  assert.equal(calls, 1);
  assert.deepEqual(log, ["open", "close"]);
});

test("新对话成功：关闭动画结束后导航到新对话", async () => {
  const { flow, log } = setup(async () => "fresh");
  flow.show();
  await flow.newConversation();
  assert.deepEqual(log, ["open", "close"]);
  flow.onClosed();
  assert.deepEqual(log, ["open", "close", "go:fresh"]);
});

for (const mode of ["select", "new"] as const) {
  test(`${mode}：动画中删除目标则留在原对话，仍存在的目标可正常切换`, async () => {
    const conversations = new Set(["cur", "removed"]);
    let target = "removed";
    const { flow, log } = setup(
      async () => {
        conversations.add(target);
        return target;
      },
      (id) => conversations.has(id),
    );
    const choose = async () => {
      if (mode === "select") flow.select(target);
      else await flow.newConversation();
    };
    flow.show();
    await choose();
    assert.deepEqual(log, ["open", "close"]);
    conversations.delete("removed");
    flow.onClosed();
    assert.deepEqual(log, ["open", "close"]);

    target = "valid";
    conversations.add(target);
    flow.show();
    await choose();
    flow.onClosed();
    assert.deepEqual(log, ["open", "close", "open", "close", "go:valid"]);
  });
}

test("创建期间用户关掉抽屉：这次切换作废，不导航", async () => {
  let resolve!: (id: string) => void;
  const { flow, log } = setup(() => new Promise<string>((r) => (resolve = r)));
  flow.show();
  const creating = flow.newConversation();
  flow.requestClose();
  flow.onClosed();
  resolve("fresh");
  await creating;
  flow.onClosed();
  assert.deepEqual(log, ["open", "close"]);
});

test("创建失败：提示错误，抽屉保持打开且可以再操作", async () => {
  let fail = true;
  const { flow, log, failures } = setup(async () => {
    if (fail) throw new Error("503");
    return "fresh";
  });
  flow.show();
  await flow.newConversation();
  assert.equal(failures.length, 1);
  assert.deepEqual(log, ["open"]);
  fail = false;
  await flow.newConversation();
  flow.onClosed();
  assert.deepEqual(log, ["open", "close", "go:fresh"]);
});

test("点遮罩关闭后不导航；对话切换动作不会泄漏到下一次打开", () => {
  const { flow, log } = setup();
  flow.show();
  flow.select("a");
  flow.requestClose();
  flow.onClosed();
  assert.deepEqual(log, ["open", "close", "close"]);
  flow.show();
  flow.select("b");
  flow.onClosed();
  assert.deepEqual(log.slice(-3), ["open", "close", "go:b"]);
});

test("过期失败不清除新操作的 busy，也不提示错误", async () => {
  const old = deferred();
  const current = deferred();
  let calls = 0;
  const { flow, log, failures } = setup(() => (++calls === 1 ? old.promise : current.promise));
  flow.show();
  const first = flow.newConversation();
  flow.requestClose();
  flow.onClosed();
  flow.show();
  const second = flow.newConversation();
  old.reject(new Error("old"));
  await first;
  flow.select("wrong");
  await flow.newConversation();
  assert.equal(calls, 2);
  assert.deepEqual(failures, []);
  assert.deepEqual(log, ["open", "close", "open"]);
  current.resolve("fresh");
  await second;
  flow.onClosed();
  assert.deepEqual(log.slice(-2), ["close", "go:fresh"]);
});

test("关闭重开共用创建请求：失败只提示一次，当前操作可以重试", async () => {
  const shared = deferred();
  let request = shared.promise;
  const { flow, log, failures } = setup(() => request);
  flow.show();
  const first = flow.newConversation();
  flow.requestClose();
  flow.onClosed();
  flow.show();
  const second = flow.newConversation();
  const error = new Error("offline");
  shared.reject(error);
  await Promise.all([first, second]);
  assert.deepEqual(failures, [error]);
  assert.deepEqual(log, ["open", "close", "open"]);
  request = Promise.resolve("retry");
  await flow.newConversation();
  flow.onClosed();
  assert.deepEqual(log.slice(-2), ["close", "go:retry"]);
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`Flow 失效后创建 ${outcome}：不改界面、不弹窗、不导航`, async () => {
    const request = deferred();
    const { flow, log, failures } = setup(() => request.promise);
    flow.show();
    const creating = flow.newConversation();
    flow.dispose();
    if (outcome === "resolve") request.resolve("fresh");
    else request.reject(new Error("offline-after-unmount"));
    await creating;
    flow.onClosed();
    assert.deepEqual(log, ["open"]);
    assert.deepEqual(failures, []);
  });
}

test("Flow 销毁清除待导航动作，旧界面的关闭通知和交互均无副作用", async () => {
  let calls = 0;
  const { flow, log } = setup(async () => (++calls, "fresh"));
  flow.show();
  flow.select("a");
  flow.dispose();
  flow.dispose();
  flow.onClosed();
  flow.show();
  flow.requestClose();
  flow.select("b");
  await flow.newConversation();
  assert.equal(calls, 0);
  assert.deepEqual(log, ["open", "close"]);
});

test("覆盖层打开及退出期间持续可见，当前动画完成后才释放底层", () => {
  const initial = { open: false, visible: false, generation: 0 };
  const opened = drawerTransition(initial, { type: "target", open: true });
  assert.equal(opened.visible, true);
  const closing = drawerTransition(opened, { type: "target", open: false });
  assert.equal(closing.open, false);
  assert.equal(closing.visible, true);
  const closed = drawerTransition(closing, { type: "closed", generation: closing.generation });
  assert.equal(closed.visible, false);
});

test("重开后旧关闭通知不能释放覆盖层，再次关闭须等本次动画完成", () => {
  const opened = drawerTransition({ open: false, visible: false, generation: 0 }, { type: "target", open: true });
  const firstClose = drawerTransition(opened, { type: "target", open: false });
  const reopened = drawerTransition(firstClose, { type: "target", open: true });
  const stale = { type: "closed", generation: firstClose.generation } as const;
  assert.deepEqual(drawerTransition(reopened, stale), reopened);
  const secondClose = drawerTransition(reopened, { type: "target", open: false });
  assert.deepEqual(drawerTransition(secondClose, stale), secondClose);
  assert.equal(drawerTransition(secondClose, { type: "closed", generation: secondClose.generation }).visible, false);
});
