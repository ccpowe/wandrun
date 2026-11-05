import { act, fireEvent, screen } from '@testing-library/react-native';
import { focusManager } from '@tanstack/react-query';
import MemoryReaderRoute from '../src/app/memory-reader';
import MemoryDetailRoute from '../src/app/memory-detail';
import { FakeGateway, unavailable } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const path = '/agents/research/memory';
const ref = { path: `/.wandrun/memory/work/details/topic/${'a'.repeat(64)}.md`, sha256: 'a'.repeat(64) };
let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers(); focusManager.setFocused(true);
  peer = new FakeGateway(); seedGatewayAgent(peer);
  peer.state.memories.set(path, { scope: 'work', agent_id: 'research', content: `保留索引正文\n- [主题](${ref.path})`, version: 'v1', details: { topic: ref }, limit: 1000, updated_at: null, updated_by: null });
  peer.state.memoryBodies.set(`${path}/details/topic`, '原详情');
});
afterEach(() => { peer.disconnect(); focusManager.setFocused(undefined); jest.restoreAllMocks(); jest.useRealTimers(); });
async function review(content?: string) {
  await renderGateway(peer, MemoryReaderRoute, '/memory-reader', { '/memory-detail': MemoryDetailRoute }, '/memory-reader?scope=work&id=research');
  await fireEvent.press(screen.getByTestId('memory-index-detail-topic')); await tick();
  await fireEvent.press(screen.getByTestId('memory-detail-delete')); await tick();
  if (content !== undefined) await fireEvent.changeText(screen.getByTestId('memory-detail-delete-index'), content);
  await fireEvent.press(screen.getByTestId('memory-detail-delete-confirm')); await tick();
  expect(screen.getByTestId('memory-detail-delete-dialog')).toBeOnTheScreen();
}

test('agent-profile.G11 T15 删除已执行但回执缺失，只读核对完成前不允许重复删除，核对后返回实际索引', async () => {
  const gate = Promise.withResolvers<void>();
  let writes = 0, checks = 0;
  peer.overrides['DELETE /agents/:id/memory/details/:slug'] = async (_context, respond) => { writes++; await respond(); return unavailable(); };
  peer.overrides['GET /agents/:id/memory'] = async () => { if (writes) { checks++; await gate.promise; } };
  await review();
  await fireEvent.press(screen.getByTestId('memory-detail-delete-submit')); await tick();
  expect(screen.getByTestId('memory-save-unconfirmed')).toHaveTextContent(/删除结果未确认/);
  expect(screen.queryByTestId('memory-detail-delete-dialog')).toBeNull();
  expect(screen.getByTestId('memory-detail-delete-confirm')).toBeDisabled();
  expect(screen.getByTestId('memory-detail-delete-index')).toHaveProp('editable', false);
  await fireEvent.press(screen.getByTestId('memory-detail-delete-confirm')); await tick(5000);
  expect(writes).toBe(1); expect(checks).toBe(1);
  await act(() => gate.resolve()); await tick();
  expect(screen.getByTestId('profile-memory-content')).toHaveTextContent('保留索引正文');
  expect(screen.queryByTestId('memory-index-detail-topic')).toBeNull();
  expect(writes).toBe(1);
});
test('agent-profile.G11 T15 原 CAS 版本确认未删，恢复核对稿，仅下一次用户删除才写', async () => {
  let writes = 0;
  peer.overrides['DELETE /agents/:id/memory/details/:slug'] = () => ++writes === 1 ? unavailable() : undefined;
  await review('用户核对后的索引');
  await fireEvent.press(screen.getByTestId('memory-detail-delete-submit')); await tick();
  expect(screen.getByTestId('memory-detail-save-result')).toBeOnTheScreen();
  expect(screen.getByTestId('memory-detail-delete-index')).toHaveDisplayValue('用户核对后的索引');
  expect(writes).toBe(1);
  await fireEvent.press(screen.getByTestId('memory-detail-delete-confirm')); await tick();
  await fireEvent.press(screen.getByTestId('memory-detail-delete-submit')); await tick();
  expect(writes).toBe(2);
  expect(peer.state.memories.get(path)?.content).toBe('用户核对后的索引');
});
test('agent-profile.G7 删除明确拒绝保留核对稿，在页顶报错，不进入未知核对', async () => {
  peer.overrides['DELETE /agents/:id/memory/details/:slug'] = () => unavailable('不允许删除', 400);
  await review();
  const content = screen.getByTestId('memory-detail-delete-index').props.value;
  await fireEvent.press(screen.getByTestId('memory-detail-delete-submit')); await tick();
  expect(screen.getByTestId('memory-detail-error')).toBeOnTheScreen();
  expect(screen.getByTestId('memory-detail-delete-index')).toHaveDisplayValue(content);
  expect(screen.queryByTestId('memory-save-unconfirmed')).toBeNull();
  expect(peer.state.memories.get(path)?.details.topic).toEqual(ref);
});
test('agent-profile.G11 T13 返回前台事件触发一次只读核对，不依赖计时器或重发 DELETE', async () => {
  let writes = 0, checks = 0, recovered = false;
  peer.overrides['DELETE /agents/:id/memory/details/:slug'] = async (_context, respond) => { writes++; await respond(); return unavailable(); };
  peer.overrides['GET /agents/:id/memory'] = () => { if (writes) { checks++; if (!recovered) return unavailable(); } };
  await review();
  await fireEvent.press(screen.getByTestId('memory-detail-delete-submit')); await tick(5000);
  expect(checks).toBe(1);
  await act(() => focusManager.setFocused(false)); await tick(5000);
  expect(checks).toBe(1);
  recovered = true;
  await act(() => focusManager.setFocused(true)); await tick();
  expect(screen.getByTestId('profile-memory-content')).toBeOnTheScreen();
  expect(writes).toBe(1);
});
