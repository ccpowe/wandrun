import { PortalHost } from '@rn-primitives/portal';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Uniwind } from 'uniwind';
import { AgentEditor } from '../app/agent-editor';
import { CapabilitiesScreen } from '../app/agent-capabilities';
import ChatRoute from '../app/chat';
import { AllAgentsScreen } from '../app/agents';
import { ProfileScreen } from '../app/agents/[id]';
import { ScheduleEditor } from '../app/schedule-editor';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { SceneProviders } from './scene-providers';
import { useMountEffect } from '../lib/use-mount-effect';
import { editorScenario, type EditorScenario, type EditorScene } from './editor-scenario';
import { SessionProvider, useSession } from '../lib/session-context';

function useStorySession() { return useSession()!; }
function AgentRoute() {
  const session = useStorySession();
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <AgentEditor key={id ?? 'new'} session={session} id={id} />;
}
function ScheduleRoute() {
  const session = useStorySession();
  return <ScheduleEditor id="morning" agentId="planner" session={session} />;
}
function ProfileRoute() { return <ProfileScreen id="planner" initialTab="schedules" session={useStorySession()} />; }
function CapabilitiesRoute() { return <CapabilitiesScreen id="planner" session={useStorySession()} />; }
function DirectoryRoute() { return <AllAgentsScreen session={useStorySession()} />; }
const routes = { '/': DirectoryRoute, '/agent-editor': AgentRoute, '/schedule-editor': ScheduleRoute, '/agents/[id]': ProfileRoute, '/agent-capabilities': CapabilitiesRoute, '/chat': ChatRoute };
function OpenEditor({ schedule, creating }: { schedule: boolean; creating: boolean }) {
  const session = useStorySession();
  const opened = useRef(false);
  useMountEffect(() => {
    if (opened.current) return () => {};
    opened.current = true;
    if (schedule) router.push({ pathname: '/schedule-editor', params: { id: 'morning', agentId: 'planner' } });
    else {
      if (creating) session.editorOperations.beginCreationVisit('agent');
      router.push({ pathname: '/agent-editor', params: creating ? {} : { id: 'planner' } });
    }
    return () => {};
  });
  return null;
}
function Entry({ schedule, creating, entry }: { schedule: boolean; creating: boolean; entry: 'editor' | 'list' | 'profile' }) {
  const session = useStorySession();
  return <>{entry === 'editor' ? <OpenEditor schedule={schedule} creating={creating} /> : null}
    {schedule || entry === 'profile' ? <ProfileScreen id="planner" initialTab="schedules" session={session} /> : <AllAgentsScreen session={session} />}</>;
}
type EditorSceneProps = {
  state?: EditorScene; schedule?: boolean; creating?: boolean; theme?: 'light' | 'dark'; scenario?: EditorScenario; entry?: 'editor' | 'list' | 'profile';
};
export function EditorScenePage({ state = 'normal', schedule = false, creating = false, theme = 'light', entry = 'editor', scenario }: EditorSceneProps) {
  return <SceneContent key={`${state}:${schedule}:${creating}:${theme}:${entry}`} state={state} schedule={schedule} creating={creating} theme={theme} entry={entry} scenario={scenario} />;
}
function SceneContent({ state, schedule, creating, theme, scenario, entry }: Required<Omit<EditorSceneProps, 'scenario'>> & { scenario?: EditorScenario }) {
  const peer = useMemo(() => scenario ?? editorScenario(state), [state, scenario]);
  return <SessionProvider runtime={peer.runtime}>
    <SceneSessionRuntime state={state} schedule={schedule} creating={creating} theme={theme} entry={entry} peer={peer} />
  </SessionProvider>;
}
type SceneRuntimeProps = Required<Omit<EditorSceneProps, 'scenario'>> & { peer: EditorScenario };
function SceneSessionRuntime(props: SceneRuntimeProps) {
  const session = useSession();
  return session ? <SceneRuntime key={session.queryIdentity} {...props} /> : null;
}
function SceneRuntime({ state, schedule, creating, theme, peer, entry }: SceneRuntimeProps) {
  const session = useStorySession();
  useMountEffect(() => { void peer.start(session); return peer.stop; });
  useMountEffect(() => { const previous = Uniwind.currentTheme; Uniwind.setTheme(theme); return () => Uniwind.setTheme(previous); });
  return <GestureHandlerRootView style={{ flex: 1 }}>
    <SceneProviders path="/agents" routes={routes}><Entry schedule={schedule} creating={creating} entry={entry} /></SceneProviders>
    {state === 'external-update' ? <Button  intent="soft" onPress={() => peer.updateSchedule('其他设备改过的定时')}><Text>Storybook：模拟其他设备更新</Text></Button> : null}
    {state === 'external-agent' ? <><Button  intent="soft" onPress={() => peer.updateAgent({ name: '其他设备改过的名字' })}><Text>Storybook：模拟其他设备改名</Text></Button><Button  intent="soft" onPress={peer.removeAgent}><Text>Storybook：模拟其他设备删除</Text></Button></> : null}
    {state.includes('loading') ? <Button  intent="soft" onPress={peer.release}><Text>Storybook：完成读取</Text></Button> : null}
    {['read-failure', 'read-stale', 'offline', 'save-failure', 'unknown', 'unknown-applied', 'catalog-failure', 'member-failure', 'environment-partial', 'capabilities-failure', 'runs-failure', 'delete-failure', 'delete-conflict', 'delete-unknown'].includes(state) ? <Button  intent="soft" onPress={peer.recover}><Text>Storybook：模拟网关恢复</Text></Button> : null}
    <PortalHost />
  </GestureHandlerRootView>;
}
