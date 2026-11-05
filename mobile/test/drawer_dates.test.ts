import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupDrawerConversations as group, type DrawerConversationGroup } from '../src/lib/drawer-dates.ts';

const at = (day: number, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute).getTime() / 1000;
const now = new Date(2026, 9, 30, 15);
const ids = (groups: DrawerConversationGroup<{ id: string; activityAt: number | null }>[]) => groups.map(item => [item.date, item.conversations.map(row => row.id)]);

test('conversation-drawer.B1 E4 本地今天、昨天、更早按日界分组，保留每组产品顺序', () => {
  const rows = [{ id: 'today', activityAt: at(30) }, { id: 'late-receipt', activityAt: at(30, 10) }, { id: 'yesterday', activityAt: at(29, 23, 59) }, { id: 'older', activityAt: at(28) }];
  assert.deepEqual(ids(group(rows, now)), [['today', ['today', 'late-receipt']], ['yesterday', ['yesterday']], ['older', ['older']]]);
  assert.equal(group(rows, now)[0].conversations[0], rows[0]);
});
test('conversation-drawer.E7 无确认活动的发送中和失败行在今天最前，沿用彼此次序且不编时间', () => {
  const pending = { id: 'pending', activityAt: null };
  const failed = { id: 'failed', activityAt: null };
  const rows = [{ id: 'today', activityAt: at(30) }, { id: 'older', activityAt: at(20) }, pending, failed];
  const projected = group(rows, now);
  assert.deepEqual(ids(projected), [['today', ['pending', 'failed', 'today']], ['older', ['older']]]);
  assert.equal(projected[0].conversations[0], pending);
  assert.equal(pending.activityAt, null);
});
test('conversation-drawer.P9 有内容但没有排序活动的行归“更早”、不编时间，与未确认行区分', () => {
  const rows = [{ id: 'today', activityAt: at(30) }, { id: 'pending', activityAt: null }, { id: 'reply-only', activityAt: null, unranked: true }];
  assert.deepEqual(ids(group(rows, now)), [['today', ['pending', 'today']], ['older', ['reply-only']]]);
  assert.deepEqual(ids(group([{ id: 'reply-only', activityAt: null, unranked: true }], now)), [['older', ['reply-only']]]);
});
test('conversation-drawer.B1 分界精确到本地零点，轻微未来活动归今天', () => {
  const rows = [{ id: 'midnight', activityAt: at(30, 0) }, { id: 'just-before', activityAt: at(30, 0) - 1 }, { id: 'yesterday-midnight', activityAt: at(29, 0) }, { id: 'older', activityAt: at(29, 0) - 1 }, { id: 'future', activityAt: at(31) }];
  assert.deepEqual(ids(group(rows, now)), [['today', ['midnight', 'future']], ['yesterday', ['just-before', 'yesterday-midnight']], ['older', ['older']]]);
});
test('conversation-drawer.B1 跨午夜只换投影，未确认仍在今天，旧今天变昨天', () => {
  const rows = [{ id: 'late', activityAt: at(30, 23, 59) }, { id: 'yesterday', activityAt: at(29) }, { id: 'pending', activityAt: null }];
  assert.deepEqual(ids(group(rows, new Date(2026, 9, 30, 23, 59))), [['today', ['pending', 'late']], ['yesterday', ['yesterday']]]);
  assert.deepEqual(ids(group(rows, new Date(2026, 9, 31, 0, 0))), [['today', ['pending']], ['yesterday', ['late']], ['older', ['yesterday']]]);
});
test('conversation-drawer.E2 空列表不显示日期标题', () => {
  assert.deepEqual(group([], now), []);
});

for (const [label, month, day] of [['春季 23 小时', 2, 9], ['秋季 25 小时', 10, 2]] as const) {
  test(`conversation-drawer.B1 ${label}日之后，昨天仍按设备本地日历而非减 86400 秒`, () => {
    const timezone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const rows = [
        { id: 'early-yesterday', activityAt: new Date(2026, month, day - 1, 0, 30).getTime() / 1000 },
        { id: 'late-older', activityAt: new Date(2026, month, day - 2, 23, 30).getTime() / 1000 },
      ];
      assert.deepEqual(ids(group(rows, new Date(2026, month, day, 0, 30))), [['yesterday', ['early-yesterday']], ['older', ['late-older']]]);
    } finally {
      if (timezone === undefined) delete process.env.TZ;
      else process.env.TZ = timezone;
    }
  });
}
