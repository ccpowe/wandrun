import { useEffect } from 'react';
import { act, fireEvent, screen } from '@testing-library/react-native';
import AgentProfileRoute from '../src/app/agents/[id]';
import { FakeGateway, unavailable } from '../src/dev/fake-gateway';
import { gatewayQueryClient, scheduleListOptions } from '../src/lib/gateway-queries';
import { useSession } from '../src/lib/session-context';
import type { ChatSession } from '../src/gateway/session';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
let peer: FakeGateway;
let session: ChatSession;
let gates: ReturnType<typeof Promise.withResolvers<void>>[];
const gate = () => { const next = Promise.withResolvers<void>(); gates.push(next); return next; };
function ProfileRoute() {
  const current = useSession();
  useEffect(() => { if (current) session = current; }, [current]);
  return <AgentProfileRoute />;
}
async function openSchedules() {
  await renderGateway(peer, ProfileRoute, '/agents/[id]', {}, '/agents/research?tab=schedules');
  await tick();
  expect(screen.getByTestId('profile-schedule-enabled-s')).not.toBeChecked();
}
beforeEach(() => {
  jest.useFakeTimers();
  gates = [];
  peer = new FakeGateway();
  seedGatewayAgent(peer);
  peer.state.schedules = [{ id: 's', agent_id: 'research', name: '审查定时', content: '复盘', rule: { kind: 'daily', time: '08:00' }, timezone: 'Asia/Shanghai', enabled: false, ended: false, next_run_at: null, created_at: 1, updated_at: 1 }];
  peer.state.scheduleNextRuns.s = 2_000_000_000;
});
afterEach(() => { for (const held of gates) held.resolve(); peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('R1：切成员后 PATCH 完成，不复活已退订定时 Query 的失败重试', async () => {
  const patch = gate();
  let backgroundReads = 0;
  let listUnavailable = false;
  peer.overrides['PATCH /schedules/:id'] = async (_, respond) => { await patch.promise; return respond(); };
  peer.overrides['GET /agents/:id/schedules'] = () => { if (listUnavailable) { backgroundReads++; return unavailable(); } };
  await openSchedules();
  await fireEvent.press(screen.getByTestId('profile-schedule-enabled-s'));
  await fireEvent.press(screen.getByTestId('profile-tab-members')); await tick();
  listUnavailable = true;
  await act(() => patch.resolve()); await tick(5000);
  const query = gatewayQueryClient.getQueryCache().find({ queryKey: scheduleListOptions(session, 'research').queryKey });
  console.info('R1 smoke', { backgroundReads, observers: query?.getObserversCount(), fetchStatus: query?.state.fetchStatus });
  expect(screen.getByTestId('profile-empty-members')).toBeOnTheScreen();
  expect(backgroundReads).toBe(0);
  expect(query?.state.fetchStatus).not.toBe('fetching');
  listUnavailable = false;
  await fireEvent.press(screen.getByTestId('profile-tab-schedules')); await tick();
  expect(screen.getByTestId('profile-schedule-enabled-s')).toBeChecked();
  expect(screen.getByTestId('profile-schedule-enabled-s')).toBeEnabled();
});

test.each(['核对前', '核对后'] as const)('R2：旧列表在%s返回，核对后只以新完整快照解锁，不重放 PATCH', async order => {
  const oldList = gate(); const readBack = gate(); const freshList = gate();
  let holdOld = false; let holdFresh = false; let writes = 0;
  peer.overrides['GET /agents/:id/schedules'] = async (_, respond) => {
    const response = await respond();
    if (holdOld) { holdOld = false; await oldList.promise; }
    else if (holdFresh) await freshList.promise;
    return response;
  };
  peer.overrides['PATCH /schedules/:id'] = async (_, respond) => { writes++; await respond(); return unavailable(); };
  peer.overrides['GET /schedules/:id'] = async (_, respond) => { const response = await respond(); await readBack.promise; return response; };
  await openSchedules();
  holdOld = true;
  await act(() => peer.emit(peer.event('resource.changed', { kind: 'schedule', id: 's', op: 'updated' }))); await tick();
  await fireEvent.press(screen.getByTestId('profile-schedule-enabled-s')); await tick();
  expect(screen.getByTestId('profile-schedule-enabled-s')).toBeDisabled();
  await tick(3000);
  expect(screen.getByRole('alert')).toHaveTextContent(/未确认/);
  if (order === '核对前') { await act(() => oldList.resolve()); await tick(); }
  holdFresh = true;
  await act(() => readBack.resolve()); await tick();
  const outcome = session.editorOperations.get('schedule:s');
  console.info('R2 smoke', { serverEnabled: peer.state.schedules[0].enabled, outcomeStatus: outcome?.status, reconciled: outcome?.reconciled, displayedChecked: screen.getByTestId('profile-schedule-enabled-s').props.accessibilityState?.checked, displayedDisabled: screen.getByTestId('profile-schedule-enabled-s').props.accessibilityState?.disabled });
  expect(outcome?.reconciled).toBe(true);
  // Confirming the write is not yet authority to act on the cached list.
  expect(screen.getByTestId('profile-schedule-enabled-s')).toBeDisabled();
  await act(() => freshList.resolve()); await tick();
  if (order === '核对后') { await act(() => oldList.resolve()); await tick(); }
  expect(peer.state.schedules[0].enabled).toBe(true);
  expect(screen.getByTestId('profile-schedule-enabled-s')).toBeChecked();
  expect(screen.getByTestId('profile-schedule-enabled-s')).toBeEnabled();
  expect(screen.queryByText(/保存结果未确认/)).toBeNull();
  expect(writes).toBe(1);
  // Consuming this receipt once must not override a later ordinary gateway snapshot.
  holdFresh = false;
  peer.state.schedules = peer.state.schedules.map(row => ({ ...row, enabled: false }));
  await act(() => peer.emit(peer.event('resource.changed', { kind: 'schedule', id: 's', op: 'updated' }))); await tick();
  expect(screen.getByTestId('profile-schedule-enabled-s')).not.toBeChecked();
  expect(screen.getByTestId('profile-schedule-enabled-s')).toBeEnabled();
  expect(writes).toBe(1);
});

test('R3：44×26 定时开关通过默认 hitSlop 补足 48dp 命中区域', async () => {
  await openSchedules();
  const { hitSlop } = screen.getByTestId('profile-schedule-enabled-s').props;
  expect(26 + (hitSlop?.top ?? 0) + (hitSlop?.bottom ?? 0)).toBeGreaterThanOrEqual(48);
  expect(44 + (hitSlop?.left ?? 0) + (hitSlop?.right ?? 0)).toBeGreaterThanOrEqual(48);
});
