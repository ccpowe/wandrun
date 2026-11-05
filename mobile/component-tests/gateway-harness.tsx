import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import type { ComponentType } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import type { AgentDetail, Conversation, GatewayEvent } from '../src/gateway/api';
import { FakeGateway } from '../src/dev/fake-gateway';
import { installFakeGatewayHost } from '../src/dev/fake-gateway-host';
import { SceneProviders } from '../src/dev/scene-providers';
import { SessionProvider, useSession } from '../src/lib/session-context';

export const tickGateway = async (ms = 100) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
let releaseHost: (() => void) | undefined;
afterEach(() => { releaseHost?.(); releaseHost = undefined; });

/** Native credentials/network boundaries only; routes and transport remain the production owners. */
export async function renderGateway(peer: FakeGateway, Screen: ComponentType, path: string, routes: Record<string, ComponentType> = {}, location = path) {
  releaseHost?.();
  releaseHost = installFakeGatewayHost({ baseUrls: ['https://gateway-l2.invalid'], fetch: peer.fetch });
  jest.spyOn(globalThis, 'fetch').mockImplementation(peer.fetch);
  jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(JSON.stringify({
    computers: [{ computerId: 'l2', connectionId: 'l2', baseUrl: 'https://gateway-l2.invalid', token: 'test', pairingMethod: 'development', computerName: '测试电脑', gatewayVersion: 'test-version' }], currentId: 'l2',
  }));
  jest.spyOn(Network, 'addNetworkStateListener').mockReturnValue({ remove() {} });
  function ConnectedRoutes() {
    if (!useSession()) return null;
    return <SceneProviders path={path} location={location} routes={routes}><Screen /></SceneProviders>;
  }
  const view = await render(<GestureHandlerRootView style={{ flex: 1 }}><SessionProvider>
    <ConnectedRoutes /><PortalHost />
  </SessionProvider></GestureHandlerRootView>);
  await tickGateway();
  return view;
}

export function seedGatewayAgent(peer: FakeGateway, changes: Partial<AgentDetail> = {}) {
  const detail: AgentDetail = {
    id: 'research', name: '研究员', avatar: 0, description: '研究说明', workers: [],
    system_prompt: '核对资料', model: 'offline', reasoning_effort: null, fast_mode: false, code_mode: true,
    environment: 'local', member_of: [], skills: [], mcp_servers: [], searchable_mcp_servers: [], ...changes,
  };
  peer.state.agents.push({ ...detail, latest_conversation: null, unread: false });
  peer.state.agentDetails.set(detail.id, detail);
  return detail;
}

export function seedGatewayConversation(peer: FakeGateway, agentId = 'research', id = 'root', events: GatewayEvent[] = []) {
  const conversation: Conversation = {
    id, agent_id: agentId, title: '边界契约对话', created_at: 1, updated_at: 1,
    last_activity_seq: null, last_activity_at: null, last_text: null, last_agent_seq: 0,
    read_seq: 0, status: 'idle', unread: false, source: 'user', schedule_origin: null,
  };
  peer.state.conversations.push(conversation);
  peer.state.histories.set(id, events);
  peer.state.seq = Math.max(peer.state.seq, ...events.map(event => event.seq));
  return conversation;
}

/** Supply Yoga's viewport/composer callbacks; never replace the list or its navigation. */
export async function layoutGatewayChat() {
  let composer = screen.getByTestId('composer-input').parent;
  while (composer && typeof composer.props.onLayout !== 'function') composer = composer.parent;
  if (!composer) throw new Error('Composer measurement boundary missing');
  await fireEvent(composer, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 70 } } });
  for (const scroll of screen.container.queryAll(node => node.type === 'RCTScrollView' && typeof node.props.onLayout === 'function')) {
    await fireEvent(scroll, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 650 } } });
  }
  await tickGateway(200);
}
