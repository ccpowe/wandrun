import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import BrowserTakeover from '../src/app/browser-takeover';
import BrowserViewer from '../src/app/browser-viewer';
import SettingsComputer from '../src/app/settings-computer';
import type { BrowserTask } from '../src/gateway/api';
import { FakeGateway, jsonResponse } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
// Official Skia mock, using its CommonJS entry under jest-expo. No frame is supplied:
// these tests assert route/local-control semantics, not native drawing or remote IME.
jest.mock('@shopify/react-native-skia/lib/commonjs/Platform', () => {
  const noop = () => undefined;
  return { OS: 'web', PixelRatio: 1, requireNativeComponent: noop, resolveAsset: noop, findNodeHandle: noop, NativeModules: noop, View: noop };
});
jest.mock('@shopify/react-native-skia/lib/commonjs/skia/core/Font', () => ({ useFont: () => null, matchFont: () => null, listFontFamilies: () => [], useFonts: () => null }));
jest.mock('@shopify/react-native-skia', () => jest.requireActual('@shopify/react-native-skia/lib/commonjs/mock').Mock({}));

let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers();
  peer = new FakeGateway();
  seedGatewayAgent(peer);
  const task: BrowserTask = {
    id: 'lease', task_id: 'root', root_id: 'root', agent_id: 'research', entry_agent_id: 'research',
    entry_agent_name: '研究员', conversation_title: '网页核对', state: 'human', epoch: 1,
    pages: [{ id: 'release', title: '发布页面', url: 'https://example.com/release' }, { id: 'reference', title: '接口页面', url: 'https://example.org/api' }], current: 'release',
    environment_id: 'local', environment_name: '本机',
    capacity: { pages_used: 2, pages_registered: 2, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 8 },
    capacity_rejection: null, reason: null, requested_reason: null,
  };
  peer.state.browserTasks.push(task);
  peer.state.computer = {
    name: '核对电脑', online_since: 1, uptime_seconds: 7200, cpu_percent: 19,
    memory: { used_bytes: 4 * 1024 ** 3, total_bytes: 8 * 1024 ** 3, percent: 50 },
    environments: [{ environment_id: 'local', environment_name: '本机', capacity: task.capacity }],
  };
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });
function settingsTaskClose(taskId: string, pageId: string) {
  let row = screen.getByTestId(`settings-computer-page-${taskId}-${pageId}`).parent;
  while (row && !within(row).queryByLabelText('关闭此任务的全部浏览器页面')) row = row.parent;
  if (!row) throw new Error(`Missing close action for ${taskId}/${pageId}`);
  return within(row).getByLabelText('关闭此任务的全部浏览器页面');
}

test('普通竖屏页编辑网址时打开页面弹层会退出编辑，取消后才能重新编辑', async () => {
  await renderGateway(peer, BrowserTakeover, '/browser-takeover', {}, '/browser-takeover?id=lease&page=release');
  expect(screen.getByRole('button', { name: '编辑网址' })).toBeEnabled();
  await fireEvent.press(screen.getByTestId('takeover-url'));
  expect(screen.getByLabelText('网址')).toHaveDisplayValue('https://example.com/release');
  await fireEvent.changeText(screen.getByLabelText('网址'), 'https://example.com/draft');
  await fireEvent.press(screen.getByRole('button', { name: '页面，共 2 个' }));
  expect(screen.queryByLabelText('网址')).toBeNull();
  expect(screen.queryByTestId('takeover-url-cancel')).toBeNull();
  expect(screen.getByText('页面 · 2')).toBeOnTheScreen();
  expect(screen.getByTestId('takeover-page-release')).toHaveTextContent(/发布页面/);
  expect(screen.getByTestId('takeover-page-reference')).toHaveTextContent(/接口页面/);
  await fireEvent.press(screen.getByLabelText('关闭弹层'));
  expect(screen.queryByText('页面 · 2')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '编辑网址' }));
  expect(screen.getByLabelText('网址')).toHaveDisplayValue('https://example.com/release');
  await fireEvent.press(screen.getByTestId('takeover-url-cancel'));
  expect(screen.queryByLabelText('网址')).toBeNull();
  expect(screen.getByRole('button', { name: '编辑网址' })).toBeEnabled();
});

test('URL 编辑、页面列表和更多面板不并存，切换面板保留页面数据', async () => {
  await renderGateway(peer, BrowserTakeover, '/browser-takeover', {}, '/browser-takeover?id=lease&page=release');
  await fireEvent.press(screen.getByTestId('takeover-url'));
  await fireEvent.press(screen.getByTestId('takeover-more'));
  expect(screen.queryByLabelText('网址')).toBeNull();
  expect(screen.getByTestId('takeover-landscape')).toBeOnTheScreen();
  expect(screen.queryByTestId('takeover-page-release')).toBeNull();
  await fireEvent.press(screen.getByLabelText('关闭弹层'));
  await fireEvent.press(screen.getByTestId('takeover-pages'));
  expect(screen.getByTestId('takeover-page-release')).toBeOnTheScreen();
  expect(screen.queryByTestId('takeover-landscape')).toBeNull();
  await fireEvent.press(screen.getByLabelText('关闭弹层'));
  expect(peer.state.browserTasks[0].pages.map(page => page.id)).toEqual(['release', 'reference']);
  expect(peer.state.browserTasks[0].pages[0].url).toBe('https://example.com/release');
});

test('电脑资源页的具体页面行进入真实观看路由，并呈现资源与页数标签', async () => {
  await renderGateway(peer, SettingsComputer, '/settings-computer', { '/browser-viewer': BrowserViewer });
  expect(within(screen.getByTestId('settings-computer-cpu')).getByText('CPU')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-computer-cpu')).toHaveTextContent(/19%/);
  expect(screen.getByTestId('settings-computer-memory')).toHaveTextContent(/4\.0 \/ 8\.0 GB/);
  expect(screen.getByTestId('settings-computer-pages')).toHaveTextContent(/2 \/ 8/);
  await fireEvent.press(screen.getByTestId('settings-computer-page-lease-reference'));
  await tick();
  expect(screen.getByTestId('viewer-close')).toBeOnTheScreen();
  expect(screen.getByText(/你接管中 · example\.org · 共 2 个页面/)).toBeOnTheScreen();
  expect(screen.getByText('研究员 · 网页核对')).toBeOnTheScreen();
  expect(screen.queryByTestId('takeover-url')).toBeNull();
  await fireEvent.press(screen.getByTestId('viewer-close'));
  await tick();
  expect(screen.getByTestId('settings-computer-page-lease-reference')).toBeOnTheScreen();
});

test('browser.C1 T12 点 X 立即关闭整租约全部页面，不要求第二次操作', async () => {
  await renderGateway(peer, SettingsComputer, '/settings-computer');
  const request = jest.fn(peer.fetch);
  jest.mocked(globalThis.fetch).mockImplementation(request);
  await fireEvent.press(settingsTaskClose('lease', 'release')); await tick();
  expect(request.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  expect(screen.queryByTestId('settings-computer-page-lease-release')).toBeNull();
  expect(screen.queryByTestId('settings-computer-page-lease-reference')).toBeNull();
});

test('browser.C2 A7 未确认关闭在离开重入后仍禁重发，核对已结束后刷新全部页面', async () => {
  await renderGateway(peer, SettingsComputer, '/settings-computer', { '/browser-viewer': BrowserViewer });
  const readback = Promise.withResolvers<Response>();
  const writes = jest.fn(() => Promise.resolve(jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503)));
  jest.mocked(globalThis.fetch).mockImplementation((input, init) =>
    String(input).endsWith('/browser-tasks/lease')
      ? init?.method === 'DELETE' ? writes() : readback.promise
      : peer.fetch(input, init));
  await fireEvent.press(settingsTaskClose('lease', 'release')); await tick();
  expect(screen.getByTestId('settings-computer-close-error')).toHaveTextContent(/未确认/);
  for (const action of screen.getAllByLabelText('关闭此任务的全部浏览器页面')) expect(action).toBeDisabled();
  await act(() => router.push({ pathname: '/browser-viewer', params: { id: 'lease' } })); await tick();
  expect(screen.getByTestId('viewer-takeover')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('viewer-close')); await tick();
  for (const action of screen.getAllByLabelText('关闭此任务的全部浏览器页面')) expect(action).toBeDisabled();
  const released: BrowserTask = { ...peer.state.browserTasks[0], state: 'released', pages: [], current: null };
  peer.state.browserTasks[0] = released;
  await act(() => readback.resolve(jsonResponse(released))); await tick();
  expect(screen.queryByTestId('settings-computer-page-lease-release')).toBeNull();
  expect(screen.queryByTestId('settings-computer-page-lease-reference')).toBeNull();
  expect(writes).toHaveBeenCalledTimes(1);
});

function addOtherLease() {
  const other = { ...peer.state.browserTasks[0], id: 'other', pages: [{ id: 'other-page', title: '其他任务', url: 'https://other.example' }], current: 'other-page' };
  peer.state.browserTasks.push(other);
}
test('browser.C2 一个租约关闭 unknown 不锁住其他租约，其他任务仍可直接关闭', async () => {
  addOtherLease();
  await renderGateway(peer, SettingsComputer, '/settings-computer');
  const readback = Promise.withResolvers<Response>();
  jest.mocked(globalThis.fetch).mockImplementation((input, init) =>
    String(input).endsWith('/browser-tasks/lease')
      ? init?.method === 'DELETE' ? Promise.resolve(jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503)) : readback.promise
      : peer.fetch(input, init));
  await fireEvent.press(settingsTaskClose('lease', 'release')); await tick();
  expect(settingsTaskClose('lease', 'release')).toBeDisabled();
  expect(settingsTaskClose('other', 'other-page')).toBeEnabled();
  await fireEvent.press(settingsTaskClose('other', 'other-page')); await tick();
  expect(screen.queryByTestId('settings-computer-page-other-other-page')).toBeNull();
  expect(screen.getByTestId('settings-computer-page-lease-release')).toBeOnTheScreen();
});
test('browser.C1 查看页的 unknown 不能冒充资源页关闭错误，也不能锁住其他租约', async () => {
  addOtherLease();
  await renderGateway(peer, BrowserViewer, '/browser-viewer', { '/settings-computer': SettingsComputer }, '/browser-viewer?id=lease');
  const readback = Promise.withResolvers<Response>();
  jest.mocked(globalThis.fetch).mockImplementation((input, init) =>
    String(input).endsWith('/browser-tasks/lease/takeover')
      ? Promise.resolve(jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503))
      : String(input).endsWith('/browser-tasks/lease') ? readback.promise : peer.fetch(input, init));
  await fireEvent.press(screen.getByTestId('viewer-takeover')); await tick();
  await act(() => router.push('/settings-computer')); await tick();
  expect(screen.queryByTestId('settings-computer-close-error')).toBeNull();
  expect(settingsTaskClose('other', 'other-page')).toBeEnabled();
  expect(settingsTaskClose('lease', 'release')).toBeDisabled();
  expect(within(screen.getByTestId('settings-computer-page-lease-release')).getByText(/操作结果未确认/)).toBeOnTheScreen();
  await act(() => readback.resolve(jsonResponse(peer.state.browserTasks[0]))); await tick();
  expect(settingsTaskClose('lease', 'release')).toBeEnabled();
  expect(within(screen.getByTestId('settings-computer-page-lease-release')).queryByText(/操作结果未确认/)).toBeNull();
});
test('browser.B4 关闭非最后一页后保留列表，可连续关闭剩余页直至收起零页列表', async () => {
  await renderGateway(peer, BrowserTakeover, '/browser-takeover', {}, '/browser-takeover?id=lease');
  jest.mocked(globalThis.fetch).mockImplementation((input, init) => {
    if (String(input).includes('/browser-tasks/lease/pages/') && init?.method === 'DELETE') {
      const pages = peer.state.browserTasks[0].pages.filter(page => !String(input).endsWith(`/pages/${page.id}`));
      const task = { ...peer.state.browserTasks[0], pages, current: pages[0]?.id ?? null };
      peer.state.browserTasks[0] = task;
      return Promise.resolve(jsonResponse({ browser_task: task }));
    }
    return peer.fetch(input, init);
  });
  await fireEvent.press(screen.getByTestId('takeover-pages'));
  await fireEvent.press(screen.getByTestId('takeover-close-page-reference')); await tick();
  expect(screen.getByText('页面 · 1')).toBeOnTheScreen();
  expect(screen.getByTestId('takeover-close-page-release')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('takeover-close-page-release'));
  await fireEvent.press(screen.getByText('关闭')); await tick();
  expect(screen.queryByText('这是最后一页')).toBeNull();
  expect(screen.queryByText('页面 · 0')).toBeNull();
  expect(screen.getByRole('button', { name: '页面，共 0 个' })).toBeOnTheScreen();
});
test.each(['offline', 'unknown'] as const)('browser.B4 %s 禁止单页关闭但仍允许收起列表', async scenario => {
  await renderGateway(peer, BrowserTakeover, '/browser-takeover', {}, '/browser-takeover?id=lease');
  await fireEvent.press(screen.getByTestId('takeover-pages'));
  if (scenario === 'offline') {
    peer.overrides['GET /events'] = () => jsonResponse({ error: { code: 'unavailable', message: '断线' } }, 503);
    await act(() => peer.disconnect()); await tick(1500);
  }
  else {
    const readback = Promise.withResolvers<Response>();
    jest.mocked(globalThis.fetch).mockImplementation((input, init) =>
      String(input).endsWith('/browser-tasks/lease/pages/reference')
        ? Promise.resolve(jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503))
        : String(input).endsWith('/browser-tasks/lease') ? readback.promise : peer.fetch(input, init));
    await fireEvent.press(screen.getByTestId('takeover-close-page-reference')); await tick();
  }
  expect(screen.getByTestId('takeover-close-page-release')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('takeover-close-page-release')); await tick();
  expect(jest.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(scenario === 'unknown' ? 1 : 0);
  await fireEvent.press(screen.getByLabelText('关闭弹层'));
  expect(screen.queryByTestId('takeover-close-page-release')).toBeNull();
});
test('browser.B4 最后一页 unknown 禁用确认关闭但允许取消回到列表', async () => {
  peer.state.browserTasks[0].pages = [peer.state.browserTasks[0].pages[0]];
  await renderGateway(peer, BrowserTakeover, '/browser-takeover', {}, '/browser-takeover?id=lease');
  await fireEvent.press(screen.getByTestId('takeover-pages'));
  await fireEvent.press(screen.getByTestId('takeover-close-page-release'));
  const readback = Promise.withResolvers<Response>();
  jest.mocked(globalThis.fetch).mockImplementation((input, init) =>
    String(input).endsWith('/browser-tasks/lease/pages/release')
      ? Promise.resolve(jsonResponse({ error: { code: 'unavailable', message: '暂不可用' } }, 503))
      : String(input).endsWith('/browser-tasks/lease') ? readback.promise : peer.fetch(input, init));
  await fireEvent.press(screen.getByText('关闭')); await tick();
  expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
  await fireEvent.press(screen.getByRole('button', { name: '关闭' })); await tick();
  expect(jest.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  await fireEvent.press(screen.getByRole('button', { name: '取消' }));
  expect(screen.getByText('页面 · 1')).toBeOnTheScreen();
  expect(screen.getByTestId('takeover-close-page-release')).toBeDisabled();
});
test('browser.B4 取消最后一页关闭确认后保留页面列表', async () => {
  peer.state.browserTasks[0].pages = [peer.state.browserTasks[0].pages[0]];
  await renderGateway(peer, BrowserTakeover, '/browser-takeover', {}, '/browser-takeover?id=lease');
  await fireEvent.press(screen.getByTestId('takeover-pages'));
  await fireEvent.press(screen.getByTestId('takeover-close-page-release'));
  await fireEvent.press(screen.getByText('取消'));
  expect(screen.getByText('页面 · 1')).toBeOnTheScreen();
});
test('browser.A1 列表已有租约时详情后备失败不制造错误横幅，仍显示真实页面', async () => {
  peer.overrides['GET /browser-tasks/:id'] = () => jsonResponse({ error: { code: 'unavailable', message: '详情暂不可用' } }, 503);
  await renderGateway(peer, BrowserViewer, '/browser-viewer', {}, '/browser-viewer?id=lease');
  expect(screen.getByText(/你接管中 · example\.com · 共 2 个页面/)).toBeOnTheScreen();
  expect(screen.queryByText('无法加载浏览器任务，正在重试…')).toBeNull();
});

test('browser.A6 真实查看页：接管明确失败显示横幅，横幅内 × 关闭后消失，可再次接管', async () => {
  peer.state.browserTasks[0].state = 'requested';
  await renderGateway(peer, BrowserViewer, '/browser-viewer', {}, '/browser-viewer?id=lease');
  jest.mocked(globalThis.fetch).mockImplementation((input, init) =>
    String(input).endsWith('/browser-tasks/lease/takeover') && init?.method === 'POST'
      ? Promise.resolve(jsonResponse({ error: { code: 'conflict', message: '浏览器正在被其他设备接管' } }, 409))
      : peer.fetch(input, init));
  await fireEvent.press(screen.getByTestId('viewer-takeover')); await tick();
  expect(screen.getByTestId('browser-error')).toBeOnTheScreen();
  expect(screen.queryByText(/操作结果未确认/)).toBeNull();
  await fireEvent.press(screen.getByTestId('browser-error-dismiss')); await tick();
  expect(screen.queryByTestId('browser-error')).toBeNull();
  expect(screen.getByTestId('viewer-takeover')).toBeEnabled();
});
