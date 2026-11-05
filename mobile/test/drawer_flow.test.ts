// Native animation is outside this L1; tickets prove which visit can complete navigation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DrawerFlow, DrawerTransition } from '../src/lib/drawer-flow.ts';

function setup(hasConversation: (id: string) => boolean = () => true, dismissKeyboard = () => Promise.resolve()) {
  const log: string[] = [];
  const navigations: string[] = [];
  const flow = new DrawerFlow({
    hasConversation,
    dismissKeyboard,
    navigate: id => { log.push(`go:${id}`); navigations.push(id); },
  });
  let open = false;
  flow.subscribe(() => { const next = flow.getSnapshot().open; if (next !== open) { log.push(next ? 'open' : 'close'); open = next; } });
  return { flow, log, navigations, openNew: () => { log.push('go:new'); navigations.push('new'); } };
}

test('选另一个对话：先关抽屉，关闭动画和键盘收起后才导航', async () => {
  const { flow, log } = setup();
  flow.show(); flow.select('other', 'cur');
  assert.deepEqual(log, ['open', 'close']);
  flow.getSnapshot().closeTicket!.complete();
  await Promise.resolve();
  assert.deepEqual(log, ['open', 'close', 'go:other']);
});

test('选当前对话只关闭；关闭中重复点击不替换目的地', async () => {
  const { flow, navigations } = setup();
  flow.show(); flow.select('cur', 'cur'); flow.select('wrong', 'cur');
  flow.getSnapshot().closeTicket!.complete();
  assert.deepEqual(navigations, []);
  flow.show(); flow.select('a', 'cur'); flow.select('b', 'cur');
  flow.getSnapshot().closeTicket!.complete();
  await Promise.resolve();
  assert.deepEqual(navigations, ['a']);
});

test('conversation-drawer.N1 新对话只在关闭后进入本地页，同一帧连点只导航一次', async () => {
  const { flow, log, openNew } = setup();
  flow.show(); flow.newConversation(openNew); flow.newConversation(openNew); flow.select('wrong', 'cur');
  assert.deepEqual(log, ['open', 'close']);
  const ticket = flow.getSnapshot().closeTicket!;
  ticket.complete(); ticket.complete();
  await Promise.resolve();
  assert.deepEqual(log, ['open', 'close', 'go:new']);
});

test('conversation-drawer.N1 顶部新对话无需打开抽屉，同一访问不能重复导航', async () => {
  const { flow, navigations, openNew } = setup();
  flow.newConversation(openNew); flow.newConversation(openNew);
  await Promise.resolve();
  assert.deepEqual(navigations, ['new']);
});

test('顶部新对话在抽屉正关闭时等待本轮关闭完成', async () => {
  const { flow, navigations, openNew } = setup();
  flow.show(); flow.requestClose(); flow.newConversation(openNew);
  assert.deepEqual(navigations, []);
  flow.getSnapshot().closeTicket!.complete();
  await Promise.resolve();
  assert.deepEqual(navigations, ['new']);
});

test('关闭动画中删除目标不进入失效页，也不锁死随后新对话入口', async () => {
  const ids = new Set(['cur', 'removed', 'valid']);
  const { flow, navigations, openNew } = setup(id => ids.has(id));
  flow.show(); flow.select('removed', 'cur'); ids.delete('removed');
  flow.getSnapshot().closeTicket!.complete();
  await Promise.resolve();
  assert.deepEqual(navigations, []);
  flow.newConversation(openNew);
  await Promise.resolve();
  assert.deepEqual(navigations, ['new']);
  flow.show(); flow.select('valid', 'cur'); flow.getSnapshot().closeTicket!.complete();
  await Promise.resolve();
  assert.deepEqual(navigations, ['new', 'valid']);
});

test('显式关闭撤销尚未完成的选择，后续访问不继承目的地', async () => {
  const { flow, navigations } = setup();
  flow.show(); flow.select('a', 'cur'); flow.requestClose(); flow.getSnapshot().closeTicket!.complete();
  assert.deepEqual(navigations, []);
  flow.show(); flow.select('b', 'cur'); flow.getSnapshot().closeTicket!.complete();
  await Promise.resolve();
  assert.deepEqual(navigations, ['b']);
});

test('失焦撤销旧关闭票据；新访问不被旧动画完成', async () => {
  const { flow, navigations, openNew } = setup();
  flow.show(); flow.select('old', 'cur'); const old = flow.getSnapshot().closeTicket!;
  flow.deactivate(); flow.select('ignored', 'cur'); flow.newConversation(openNew); old.complete();
  assert.deepEqual(navigations, []);
  flow.activate(); flow.show(); flow.select('current', 'cur');
  old.complete(); assert.deepEqual(navigations, []);
  flow.getSnapshot().closeTicket!.complete();
  await Promise.resolve();
  assert.deepEqual(navigations, ['current']);
});

test('conversation-drawer.T14 重开之后旧票据不能结算新的关闭', async () => {
  const { flow, navigations } = setup();
  flow.show(); flow.select('old', 'cur'); const old = flow.getSnapshot().closeTicket!;
  flow.show(); flow.select('new', 'cur'); const next = flow.getSnapshot().closeTicket!;
  old.complete(); assert.deepEqual(navigations, []);
  next.complete(); old.complete(); next.complete();
  await Promise.resolve();
  assert.deepEqual(navigations, ['new']);
});

test('conversation-drawer.T14 原生动画结束只完成开始时捕获的 Flow', async () => {
  const old = setup(); const next = setup(); const transition = new DrawerTransition();
  old.flow.show(); old.flow.select('old-target', 'cur'); transition.start(true, old.flow.getSnapshot().closeTicket);
  old.flow.deactivate(); next.flow.show(); next.flow.select('new-target', 'cur'); transition.end(true);
  assert.deepEqual(old.navigations, []); assert.deepEqual(next.navigations, []);
  transition.start(true, next.flow.getSnapshot().closeTicket); transition.end(true); transition.end(true);
  await Promise.resolve();
  assert.deepEqual(next.navigations, ['new-target']);
});

test('chat.O14 顶栏新对话等待键盘收起回执才改变目标', async () => {
  const { promise: hidden, resolve: hide } = Promise.withResolvers<void>();
  const { flow, navigations, openNew } = setup(() => true, () => hidden);
  flow.newConversation(openNew);
  assert.deepEqual(navigations, []);
  hide();
  await hidden;
  assert.deepEqual(navigations, ['new']);
});

for (const revoke of ['blur', 'reopen', 'target'] as const) {
  test(`chat.O14 等待收键盘时 ${revoke} 撤销旧换目标命令`, async () => {
    const { promise: hidden, resolve: hide } = Promise.withResolvers<void>();
    const { flow, navigations, openNew } = setup(() => true, () => hidden);
    flow.newConversation(openNew);
    if (revoke === 'blur') flow.deactivate();
    else if (revoke === 'reopen') flow.show();
    else flow.reset();
    hide();
    await hidden;
    assert.deepEqual(navigations, []);
    flow.activate();
    flow.newConversation(openNew);
    if (flow.getSnapshot().closing) flow.getSnapshot().closeTicket!.complete();
    await Promise.resolve();
    assert.deepEqual(navigations, ['new']);
  });
}
