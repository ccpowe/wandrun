import { PortalHost } from '@rn-primitives/portal';
import { useEffectEvent, useState, useSyncExternalStore } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import type { BrowserTask } from '../gateway/api.ts';
import BrowserViewer from '../app/browser-viewer.tsx';
import BrowserTakeover from '../app/browser-takeover.tsx';
import { Credentials } from '../lib/credentials.ts';
import { SessionProvider, useSession } from '../lib/session-context.tsx';
import { useMountEffect } from '../lib/use-mount-effect.ts';
import { FakeGateway } from './fake-gateway.ts';
import { installFakeGatewayHost } from './fake-gateway-host.ts';
import { FoundationFrame } from './foundation-frame.tsx';
import { SceneProviders } from './scene-providers.tsx';
import { FakeBrowserStream, installFakeBrowserStreams } from './fake-gateway/browser-stream.ts';
import { browserFixturePicture } from './fake-gateway/browser-picture.ts';
import { Text } from '../components/ui/text.tsx';
const origin = 'https://browser-story.invalid';
const routes = { '/browser-viewer': BrowserViewer, '/browser-takeover': BrowserTakeover };
export function browserStoryTask(state: BrowserTask['state'] = 'requested'): BrowserTask {
  return { id: 'lease', task_id: 'root', root_id: 'root', agent_id: 'research', entry_agent_id: 'research',
    entry_agent_name: '研究员', conversation_title: '核对网页与接口资料', state, epoch: 1,
    pages: [{ id: 'release', title: '发布页面', url: 'https://example.com/release' }, { id: 'reference', title: '接口资料', url: 'https://example.org/api' }], current: 'release',
    environment_id: 'local', environment_name: '本机', capacity: { pages_used: 2, pages_registered: 2, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 8 },
    capacity_rejection: null, reason: null, requested_reason: null };
}
function Connected({ control }: { control: boolean }) {
  if (!useSession()) return null;
  const path = control ? '/browser-takeover' : '/browser-viewer';
  return <SceneProviders path={path} location={`${path}?id=lease&page=release`} routes={routes}><></></SceneProviders>;
}
function InputCounters({ socket }: { socket: FakeBrowserStream }) {
  useSyncExternalStore(socket.subscribe, socket.getSnapshot);
  let down = 0, up = 0, buttons = 0;
  for (const input of socket.inputs) if (input.t === 'pointer') {
    const next = input.buttons as number;
    if (next && !buttons) down++;
    if (!next && buttons) up++;
    buttons = next;
  }
  return <Text variant="caption" testID="browser-fixture-inputs" className="bg-card px-4 py-2 text-muted-foreground">
    {`假网关 · 状态输入 · 已派发 ${socket.inputs.length} · 按下 ${down} · 抬起 ${up} · 最近 ${socket.inputs.at(-1)?.t ?? '无'}`}
  </Text>;
}
/** HTTP/session are real; optional v3 socket models only the Chrome boundary. */
function BrowserSceneMount({ control, state, stream }: { control: boolean; state: BrowserTask['state']; stream: boolean }) {
  const [peer] = useState(() => new FakeGateway({ browserTasks: [browserStoryTask(state)] }));
  const [socket, setSocket] = useState<FakeBrowserStream | null>(null);
  const onSocket = useEffectEvent((next: FakeBrowserStream) => setSocket(next));
  const [credentials] = useState(() => new Credentials({
    getItemAsync: async () => JSON.stringify({ computers: [{ computerId: 'browser-story', connectionId: 'browser-story-installation', computerName: '浏览器场景', baseUrl: origin, token: 'story', pairingMethod: 'development' }], currentId: 'browser-story' }),
    setItemAsync: async () => {}, deleteItemAsync: async () => {},
  }));
  useMountEffect(() => {
    const release = installFakeGatewayHost({ baseUrls: [origin], fetch: peer.fetch });
    const releaseStream = stream ? installFakeBrowserStreams(origin, peer.state.browserTasks[0], { jpeg: browserFixturePicture() }, next => onSocket(next)) : undefined;
    return () => { releaseStream?.(); peer.disconnect(); release(); };
  });
  return <GestureHandlerRootView style={{ flex: 1 }}>{socket && <InputCounters socket={socket}/>}<SessionProvider runtime={{ credentials, fetch: peer.fetch }}><Connected control={control}/><PortalHost/></SessionProvider></GestureHandlerRootView>;
}
export function BrowserScene({ theme = 'light', control = false, state = control ? 'human' : 'requested', stream = false }: { theme?: 'light' | 'dark'; control?: boolean; state?: BrowserTask['state']; stream?: boolean }) {
  return <FoundationFrame theme={theme} scrollable={false}><BrowserSceneMount key={`${theme}:${control}:${state}:${stream}`} control={control} state={state} stream={stream}/></FoundationFrame>;
}
