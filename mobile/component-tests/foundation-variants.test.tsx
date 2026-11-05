import { composeStories } from '@storybook/react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ArrowUp } from 'lucide-react-native';

import { ScreenBar } from '../src/components/screen-bar';
import { Button } from '../src/components/ui/button';
import { Icon } from '../src/components/ui/icon';
import { Text } from '../src/components/ui/text';
import * as banners from '../src/components/status-banner.stories';

const { Light: BannersLight } = composeStories(banners);

test('就地提示：横幅内 × 关闭本条，读取横幅不带操作且仍是单个 alert', async () => {
  await render(<BannersLight />);
  expect(screen.getByText('无法读取所选文件')).toBeOnTheScreen();
  // A read banner without an action stays one grouped alert; the notice with a control is not grouped.
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  // Read banners carry no action; the in-place notice owns exactly one close control.
  expect(screen.getAllByRole('button', { name: '关闭提示' })).toHaveLength(1);
  await fireEvent.press(screen.getByRole('button', { name: '关闭提示' }));
  expect(screen.queryByText('无法添加附件')).toBeNull();
  expect(screen.getByText('连接断开，正在重连…')).toBeOnTheScreen();
  await fireEvent.press(screen.getByText('再次显示就地提示'));
  expect(screen.getByText('无法添加附件')).toBeOnTheScreen();
});

test('icon-sm：默认把 32 视觉补到 48 触区，调用方可覆盖；禁用时不响应', async () => {
  const onPress = jest.fn();
  await render(<>
    <Button intent="quiet" size="icon-sm" accessibilityLabel="默认触区" onPress={onPress}><Icon as={ArrowUp} /></Button>
    <Button intent="quiet" size="icon-sm" hitSlop={4} accessibilityLabel="覆盖触区"><Icon as={ArrowUp} /></Button>
    <Button intent="quiet" size="icon-sm" accessibilityLabel="禁用发送" disabled onPress={onPress}><Icon as={ArrowUp} /></Button>
  </>);
  expect(screen.getByRole('button', { name: '默认触区' }).props.hitSlop).toBe(8);
  expect(screen.getByRole('button', { name: '覆盖触区' }).props.hitSlop).toBe(4);
  const disabled = screen.getByRole('button', { name: '禁用发送' });
  expect(disabled).toBeDisabled();
  await fireEvent.press(disabled);
  expect(onPress).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: '默认触区' }));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('ScreenBar：中间自定义内容替代标题与副标题，左右槽位保持', async () => {
  await render(<ScreenBar title="不应显示" subtitle="也不应显示"
    left={<Text>左</Text>} center={<Text>资讯主编</Text>} right={<Text>右</Text>} />);
  expect(screen.getByText('资讯主编')).toBeOnTheScreen();
  expect(screen.queryByText('不应显示')).toBeNull();
  expect(screen.queryByText('也不应显示')).toBeNull();
  expect(screen.getByText('左')).toBeOnTheScreen();
  expect(screen.getByText('右')).toBeOnTheScreen();
});
