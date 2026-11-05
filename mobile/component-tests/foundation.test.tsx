import { composeStories } from '@storybook/react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ListRow } from '../src/components/list-row';
import { Text } from '../src/components/ui/text';
import * as groups from '../src/components/list-group.stories';
import * as dialogs from '../src/components/ui/dialog.stories';

const { InsetLight } = composeStories(groups);
const { BottomLight } = composeStories(dialogs);

test('分组行：展开状态与内容同步，单选切换不残留旧选中，开关不嵌套整行按钮', async () => {
  await render(<InsetLight />);
  const disclosure = screen.getByRole('button', { name: '高级设置', expanded: false });
  expect(screen.queryByText('超时时间')).toBeNull();
  await fireEvent.press(disclosure);
  expect(screen.getByRole('button', { name: '高级设置', expanded: true })).toBeOnTheScreen();
  expect(screen.getByText('超时时间')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '高级设置' }));
  expect(screen.queryByText('超时时间')).toBeNull();

  expect(screen.getByRole('radio', { name: '无需认证', selected: true, checked: true })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('radio', { name: '密钥请求头' }));
  expect(screen.getByRole('radio', { name: '密钥请求头', selected: true, checked: true })).toBeOnTheScreen();
  expect(screen.getByRole('radio', { name: '无需认证', selected: false, checked: false })).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: '通知' })).toBeNull();
  expect(screen.getByRole('switch', { name: '通知' })).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: '服务器版本（只读）' })).toBeNull();
});

test('贴底使用者弹层保留无障碍名称，不显示标题，遮罩或选择后可关闭并重新打开', async () => {
  await render(<BottomLight />);
  expect(screen.getByLabelText('使用它的 Agent')).toBeOnTheScreen();
  expect(screen.queryByText('使用它的 Agent')).toBeNull();
  await fireEvent.press(screen.getByTestId('foundation-dialog-backdrop'));
  expect(screen.queryByLabelText('使用它的 Agent')).toBeNull();
  await fireEvent.press(screen.getByText('打开对话框'));
  expect(screen.getByLabelText('使用它的 Agent')).toBeOnTheScreen();
  await fireEvent.press(screen.getByText('小万'));
  expect(screen.queryByLabelText('使用它的 Agent')).toBeNull();
});

test('紧凑行读屏保留状态和副标题，只有显式标签才替换合并内容', async () => {
  await render(<>
    <ListRow title="开发电脑" meta="在线" subtitle={<Text>本机执行环境</Text>} onPress={jest.fn()} />
    <ListRow title="远端电脑" meta="离线" subtitle={<Text>远端执行环境</Text>} accessibilityLabel="需要重新连接的电脑" onPress={jest.fn()} />
  </>);
  expect(screen.getByRole('button', { name: /开发电脑.*在线.*本机执行环境/ })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: '需要重新连接的电脑' })).toBeOnTheScreen();
});
