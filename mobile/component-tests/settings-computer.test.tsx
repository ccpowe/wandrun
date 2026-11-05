import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import SettingsComputer from '../src/app/settings-computer';
import SettingsComputerEnvironments from '../src/app/settings-computer-environments';
import { Text } from '../src/components/ui/text';
import { FakeGateway, jsonResponse } from '../src/dev/fake-gateway';
import { seedServerEnvironments } from '../src/dev/server-environments-scenario';
import type { BrowserCapacity } from '../src/gateway/api';
import { renderGateway, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers();
  peer = new FakeGateway({ computer: { name: 'resource-host', online_since: 1, uptime_seconds: 60, cpu_percent: 12,
    memory: { used_bytes: 1024, total_bytes: 4096, percent: 25 }, environments: [] } });
});
afterEach(() => { peer.disconnect(); jest.useRealTimers(); });
const capacity = (used: number, limit: number): BrowserCapacity => ({ pages_used: used, pages_limit: limit,
  pages_registered: used, pages_creating: 0, pages_pending_cleanup: 0 });
function Elsewhere() { return <Text>其他页面</Text>; }

test('服务器资源只展示本机浏览器容量；本机消失时不把云端容量替补上来', async () => {
  const cloud = { environment_id: 'instabox:machine', environment_name: 'Cloud', capacity: capacity(9, 10) };
  const local = { environment_id: 'local', environment_name: 'Local alias', capacity: capacity(1, 4) };
  peer.state.computer!.environments = [cloud, local];
  await renderGateway(peer, SettingsComputer, '/settings-computer'); await tick();
  expect(screen.getByRole('progressbar', { name: '浏览器页面', value: { now: 25 } })).toBeOnTheScreen();
  // B1: an empty browser directory shows no empty-state text below the environments.
  expect(screen.queryByText('没有正在使用的浏览器页面')).toBeNull();
  peer.state.computer!.environments = [cloud]; await tick(30_000);
  expect(screen.queryByRole('progressbar', { name: '浏览器页面' })).toBeNull();
  expect(screen.getByRole('progressbar', { name: 'CPU', value: { now: 12 } })).toBeOnTheScreen();
});

test('服务器测量失焦不继续轮询；返回重新读取当前资源而不是停在旧快照', async () => {
  let reads = 0;
  peer.overrides['GET /computer'] = () => { reads++; };
  await renderGateway(peer, SettingsComputer, '/settings-computer', { '/settings': Elsewhere }); await tick();
  const beforeBlur = reads;
  await act(() => router.push('/settings')); await tick(60_000);
  expect(reads).toBe(beforeBlur);
  peer.state.computer!.cpu_percent = 77;
  await act(() => router.back()); await tick();
  expect(screen.getByRole('progressbar', { name: 'CPU', value: { now: 77 } })).toBeOnTheScreen();
});

const envRoutes = { '/settings-computer-environments': SettingsComputerEnvironments };
const envIds = () => screen.queryAllByTestId(/^server-env-(?!paused-summary)/).map(node => node.props.testID.replace('server-env-', ''));

test('C1 少量环境全部列出：状态 · 在用 Agent、本机不写状态词、浏览器页数，0 不显示；浏览器分组不变', async () => {
  seedServerEnvironments(peer, 'few');
  await renderGateway(peer, SettingsComputer, '/settings-computer'); await tick();
  expect(screen.getByText('执行环境 · 5')).toBeOnTheScreen();
  expect(envIds()).toEqual(['local', 'instabox-wand-box', 'instabox-build-box', 'instabox-old-box', 'instabox-research-box']);
  const local = within(screen.getByTestId('server-env-local'));
  expect(local.getByText('本机')).toBeOnTheScreen(); expect(local.getByText('test 在用')).toBeOnTheScreen(); expect(local.getByText('浏览器 1')).toBeOnTheScreen();
  expect(within(screen.getByTestId('server-env-instabox-wand-box')).getByText('浏览器 2')).toBeOnTheScreen();
  const old = within(screen.getByTestId('server-env-instabox-old-box'));
  expect(old.getByText('不可用 · 没有 Agent 在用')).toBeOnTheScreen(); expect(old.queryByText(/^浏览器/)).toBeNull();
  expect(screen.getByText('已暂停 · research 在用')).toBeOnTheScreen();
  expect(screen.queryByTestId('server-env-paused-summary')).toBeNull();
  expect(screen.getByText('wand · 2')).toBeOnTheScreen();
});

test('C2 / E1 环境多时收起已暂停；点汇总行进入子页面并预选“已暂停”，返回后再进仍预选', async () => {
  seedServerEnvironments(peer, 'many');
  await renderGateway(peer, SettingsComputer, '/settings-computer', envRoutes); await tick();
  expect(screen.getByText('执行环境 · 41')).toBeOnTheScreen();
  expect(envIds()).toEqual(['local', 'instabox-wand-box', 'instabox-research-box', 'instabox-ci-box', 'instabox-build-box', 'instabox-old-box', 'instabox-gpu-box']);
  await fireEvent.press(screen.getByText('另有 34 个已暂停')); await tick();
  expect(screen.getByRole('tab', { name: '已暂停', selected: true })).toBeOnTheScreen();
  expect(screen.getByText('34 个')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('tab', { name: '运行中' })); await tick();
  expect(envIds()).toEqual(['local', 'instabox-wand-box', 'instabox-research-box', 'instabox-ci-box']);
  await act(() => router.back()); await tick();
  await fireEvent.press(screen.getByText('另有 34 个已暂停')); await tick();
  expect(screen.getByRole('tab', { name: '已暂停', selected: true })).toBeOnTheScreen();
  await act(() => router.back()); await tick();
});

test('E2 / E3 搜索与筛选同时生效；无结果显示“没有匹配的执行环境”且无结果标题', async () => {
  seedServerEnvironments(peer, 'many');
  await renderGateway(peer, SettingsComputerEnvironments, '/settings-computer-environments', {}, '/settings-computer-environments?filter=paused'); await tick();
  await fireEvent.changeText(screen.getByLabelText('搜索执行环境'), '  DEV-box '); await tick();
  expect(screen.getByText('6 个')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('tab', { name: '启动中' })); await tick();
  expect(screen.getByTestId('server-envs-empty')).toBeOnTheScreen();
  expect(screen.getByText('没有匹配的执行环境')).toBeOnTheScreen();
  expect(screen.queryByText(/^\d+ 个$/)).toBeNull();
});

test('C4 / C5 首次读取中只显示本机；失败保留本机与网关原文并可重试，成功后错误消失', async () => {
  seedServerEnvironments(peer, 'few');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const unavailable = () => jsonResponse({ error: { code: 'environment_catalog_unavailable', message: '无法加载 Instabox 机器，请检查宿主凭据或稍后重试；Local 仍可使用。' } }, 503);
  peer.overrides['GET /execution-environments'] = async () => { await gate; return unavailable(); };
  await renderGateway(peer, SettingsComputer, '/settings-computer'); await tick();
  expect(screen.getByText('执行环境 · 1')).toBeOnTheScreen();
  expect(screen.getByTestId('server-envs-loading')).toBeOnTheScreen();
  peer.overrides['GET /execution-environments'] = unavailable;
  release(); await tick(10_000);
  expect(screen.getByText('无法更新执行环境：无法加载 Instabox 机器，请检查宿主凭据或稍后重试；Local 仍可使用。')).toBeOnTheScreen();
  expect(envIds()).toEqual(['local']);
  delete peer.overrides['GET /execution-environments'];
  await fireEvent.press(within(screen.getByTestId('server-envs-error').parent!).getByText('重试')); await tick();
  expect(screen.queryByTestId('server-envs-error')).toBeNull();
  expect(screen.getByText('执行环境 · 5')).toBeOnTheScreen();
});

test('C8 失焦不轮询执行环境；可见时每 60 秒读一次', async () => {
  seedServerEnvironments(peer, 'few');
  let reads = 0;
  peer.overrides['GET /execution-environments'] = () => { reads++; };
  await renderGateway(peer, SettingsComputer, '/settings-computer', { '/settings': Elsewhere }); await tick();
  const first = reads;
  await tick(60_000);
  expect(reads).toBe(first + 1);
  await act(() => router.push('/settings')); await tick(180_000);
  expect(reads).toBe(first + 1);
});

test('E4 子页面读取失败：筛选下方同一错误与重试，已有的本机照常按筛选显示', async () => {
  seedServerEnvironments(peer, 'many');
  peer.overrides['GET /execution-environments'] = () => jsonResponse({ error: { code: 'unavailable', message: '网关暂时不可用' } }, 503);
  await renderGateway(peer, SettingsComputerEnvironments, '/settings-computer-environments', {}, '/settings-computer-environments?filter=running'); await tick(10_000);
  expect(screen.getByText('无法更新执行环境：网关暂时不可用')).toBeOnTheScreen();
  expect(envIds()).toEqual(['local']);
  await fireEvent.press(screen.getByRole('tab', { name: '已暂停' })); await tick();
  expect(screen.getByText('没有匹配的执行环境')).toBeOnTheScreen();
});
