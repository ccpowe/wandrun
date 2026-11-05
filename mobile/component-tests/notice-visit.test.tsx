import { act, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import SettingsRoute from '../src/app/settings';
import AgentsRoute from '../src/app/agents';
import { FakeGateway, unavailable } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));

const routes = { '/settings': SettingsRoute };
let peer: FakeGateway;
beforeEach(() => { jest.useFakeTimers(); peer = new FakeGateway(); seedGatewayAgent(peer); });
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

for (const kind of ['read', 'connection'] as const) {
  for (const matured of [false, true]) {
    test(`agent-list.A4 A6 提醒访问边界：${kind} ${matured ? '已显示' : '未成熟'}租期 push/back 后重新等待`, async () => {
      if (kind === 'read') peer.overrides['GET /agents'] = () => unavailable();
      await renderGateway(peer, AgentsRoute, '/agents', routes);
      if (kind === 'connection') {
        peer.overrides['GET /events'] = () => unavailable();
        await act(async () => peer.disconnect());
      }
      const notice = () => screen.queryByText(kind === 'read' ? '无法加载 Agent，正在重试…' : '内容可能不是最新的');
      await tick(matured ? 3500 : 1000);
      if (matured) expect(notice()).toBeOnTheScreen();
      else expect(notice()).toBeNull();
      await act(() => router.push('/settings'));
      await tick(3100);
      expect(screen.getByTestId('settings-back')).toBeOnTheScreen();
      await act(() => router.back());
      await tick(100);
      expect(screen.getByTestId('agent-list-screen')).toBeOnTheScreen();
      expect(notice()).toBeNull();
      await tick(2800);
      expect(notice()).toBeNull();
      await tick(200);
      expect(notice()).toBeOnTheScreen();
      if (kind === 'connection') expect(screen.getByTestId('agents-add')).toBeDisabled();
    });
  }
}
