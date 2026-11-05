import { composeStories } from '@storybook/react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import * as stories from '../src/dev/settings-connectors.stories';
import { connectorListScenario, sampleConnector } from '../src/dev/connector-list-scenario';
jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
const Stories = composeStories(stories);
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const tick = async (ms = 0) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

test('connectors-home.H2 HT1 HT2 可用目录、搜索、切换已添加和详情导航', async () => {
  await render(<Stories.H2 />); await tick();
  expect(screen.getByTestId('catalog-notion')).toBeOnTheScreen();
  await fireEvent.changeText(screen.getByLabelText('搜索连接器'), '知识');
  expect(screen.queryByTestId('catalog-github')).toBeNull();
  await fireEvent.press(screen.getByRole('tab', { name: '已添加' })); await tick();
  expect(screen.getByText('团队知识库')).toBeOnTheScreen();
  expect(screen.queryByText(/个 Agent 使用/)).toBeNull();
  await fireEvent.press(screen.getByTestId('connector-knowledge')); await tick();
  await fireEvent.press(screen.getByRole('button', { name: '编辑' })); await tick();
  expect(screen.getByLabelText('连接器名称')).toHaveDisplayValue('团队知识库');
});
test('connectors-home.H3 健康摘要区分正常断开，不夹带旧元信息', async () => {
  await render(<Stories.H3 />); await tick();
  expect(screen.getByText('已连接 · 12 个工具')).toBeOnTheScreen();
  expect(screen.getByText('需要授权')).toBeOnTheScreen();
  expect(screen.getByText('连接失败')).toBeOnTheScreen();
  expect(screen.getByText('未连接')).toBeOnTheScreen();
  expect(screen.queryByText('无需授权')).toBeNull();
  expect(screen.queryByText('参数待重启生效')).toBeNull();
});
test('connectors-home.H1 HT3 延迟 300ms，成功前不显示空态', async () => {
  const peer = connectorListScenario('loading');
  await render(<Stories.H1 scenario={peer} />); await tick(299);
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByText('暂时没有可用的连接器')).toBeNull();
  await tick(1); expect(screen.getByRole('progressbar')).toBeOnTheScreen();
  await act(() => peer.release()); await tick();
  expect(screen.getByTestId('catalog-notion')).toBeOnTheScreen();
});
test('connectors-home.H4 加号不在内容区，空态仍可进入添加', async () => {
  await render(<Stories.H4 />); await tick();
  expect(screen.getByText('暂时没有可用的连接器')).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('添加连接器')); await tick();
  expect(screen.getByRole('button', { name: '远程地址' })).toBeOnTheScreen();
});
test('connectors-home.H5 HT3 自动重试不暴露原始原因，无读取重试按钮', async () => {
  const peer = connectorListScenario('failed');
  await render(<Stories.H5 scenario={peer} />); await tick();
  await tick(3000);
  expect(screen.getByRole('alert')).toBeOnTheScreen();
  expect(screen.getByText('无法加载连接器，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByText('private upstream detail')).toBeNull(); expect(screen.queryByText('重试')).toBeNull();
  await act(() => peer.recover()); await tick(1000);
  expect(screen.getByTestId('catalog-notion')).toBeOnTheScreen();
});
test('connectors-home.H5 刷新失败保留旧快照，不显示确定空态', async () => {
  const peer = connectorListScenario('ready');
  await render(<Stories.H3 scenario={peer} />); await tick();
  expect(screen.getByText('团队知识库')).toBeOnTheScreen();
  await act(() => peer.fail()); await tick();
  expect(screen.getByText('团队知识库')).toBeOnTheScreen();
  await tick(3000);
  expect(screen.getByText('内容可能不是最新的')).toBeOnTheScreen();
});
test('connectors-home.HT4 HT5 新 revision 取消初读，Agent 事件也刷新连接器', async () => {
  const peer = connectorListScenario('loading');
  await render(<Stories.H3 scenario={peer} />); await tick();
  await act(() => peer.release()); await tick();
  await act(() => peer.succeed([{ ...sampleConnector, name: '引用变化后的名称' }], 'agent')); await tick();
  expect(screen.getByText('引用变化后的名称')).toBeOnTheScreen();
  expect(screen.queryByText('团队知识库')).toBeNull();
});
test('connectors-home.HT6 失焦不读、返回聚焦刷新，不依赖资源事件', async () => {
  const peer = connectorListScenario('ready');
  await render(<Stories.H3 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('connector-knowledge')); await tick();
  const reads = peer.reads;
  await act(() => peer.succeed([{ ...sampleConnector, name: '失焦期间变化' }])); await tick();
  expect(peer.reads).toBe(reads);
  await fireEvent.press(screen.getByLabelText('返回')); await tick();
  expect(screen.getByText('失焦期间变化')).toBeOnTheScreen();
});

test.each(['notion', 'github'] as const)('connectors-home.H7 %s 品牌图标在目录、列表和详情一致，自定义连接器保留首字母', async appId => {
  const peer = connectorListScenario('ready');
  peer.gateway.state.connectors = [{ ...sampleConnector, id: 'brand', name: '重命名后的连接器', app_id: appId, icon: 'https://mcp.notion.com/notion-logo-block-sticker.svg', used_by: [] }, sampleConnector];
  await render(<Stories.H2 scenario={peer} />); await tick();
  expect(within(screen.getByTestId(`catalog-${appId}`)).queryByText(appId === 'notion' ? 'N' : 'G')).toBeNull();
  await fireEvent.press(screen.getByRole('tab', { name: '已添加' })); await tick();
  expect(within(screen.getByTestId('connector-brand')).queryByText('重')).toBeNull();
  const local = appId === 'notion' ? require('../assets/apps/notion.png') : require('../assets/apps/github.png');
  expect(within(screen.getByTestId('connector-brand')).getByTestId('connector-icon-image').props.source).toEqual(local);
  expect(within(screen.getByTestId('connector-knowledge')).getByText('团')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('connector-brand')); await tick();
  expect(screen.getByText('重命名后的连接器')).toBeOnTheScreen();
  expect(screen.queryByText('重')).toBeNull();
  expect(screen.getByTestId('connector-icon-image').props.source).toEqual(local);
});
