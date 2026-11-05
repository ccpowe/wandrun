import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { LegendList } from '@legendapp/list/react-native';
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import type { GatewayEvent } from '../src/gateway/api';
import { chatRowsEqual, rowLayout } from '../src/lib/chat-row-equality';
import type { ChatRow } from '../src/lib/chat-timeline';

// chat.C9 / extraData: the REAL list caches a row's render by (key, data, extraData) and never by index, so the
// leading space that depends on the index must come through extraData (rowLayout). The page's list double re-maps every
// row on each render and cannot show this; this file uses the real LegendList and the same comparator.
const row = (key: string): ChatRow => ({ kind: 'agent', phase: 'final', key, event: { type: 'message.agent', seq: 1, data: { text: key } } as unknown as GatewayEvent });
const spacing = (_items: ChatRow[], index: number) => (index > 0 ? 12 : 0);

const STABLE = { constant: true };
function Harness({ items, withLayout }: { items: ChatRow[]; withLayout: boolean }) {
  // Like the page: a memoized extraData object that changes only when its content does.
  const layoutKey = rowLayout(items);
  const extra = useMemo(() => withLayout ? { layout: layoutKey } : STABLE, [withLayout, layoutKey]);
  return <View style={{ height: 800, width: 400 }}><LegendList data={items} keyExtractor={item => item.key} estimatedItemSize={100} recycleItems={false}
    itemsAreEqual={chatRowsEqual} extraData={extra}
    renderItem={({ item, index }) => <View testID={`row-${item.key}`} style={{ height: 100, paddingTop: spacing(items, index) }}><Text>{`${item.key}:${index}`}</Text></View>} /></View>;
}
async function layout() {
  for (const scroll of screen.container.queryAll(node => node.type === 'RCTScrollView' && typeof node.props.onLayout === 'function')) {
    await fireEvent(scroll, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 650 } } });
  }
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}
const top = (key: string) => (screen.getByTestId(`row-${key}`).props.style as { paddingTop: number }).paddingTop;

test('前插更早历史后，原来的首行得到上间距（间距经 extraData 的 rowLayout 失效）', async () => {
  const [a, b, c] = ['k0', 'k1', 'k2'].map(row);
  const view = await render(<Harness items={[a, b, c]} withLayout />); await layout();
  expect(top('k0')).toBe(0);
  await view.rerender(<Harness items={[row('older'), a, b, c]} withLayout />);
  expect(top('k0')).toBe(12);
});

test('对照：extraData 不含布局时，真实列表确实保留旧行渲染（所以必须把 rowLayout 放进 extraData）', async () => {
  const [a, b, c] = ['k0', 'k1', 'k2'].map(row);
  const view = await render(<Harness items={[a, b, c]} withLayout={false} />); await layout();
  await view.rerender(<Harness items={[row('older'), a, b, c]} withLayout={false} />);
  expect(top('k0')).toBe(0);
});
