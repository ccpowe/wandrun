import { PortalHost } from '@rn-primitives/portal';
import { createContext, useContext, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardController } from 'react-native-keyboard-controller';
import { Uniwind } from 'uniwind';

import { ChatScreen } from '../components/chat/chat-screen';
import { ChatEntryScreen } from '../app/index';
import { ProfileScreen } from '../app/agents/[id]';
import { AllAgentsScreen } from '../app/agents';
import { ComputerScreen } from '../app/settings-computer';
import { SearchPage } from '../app/search';
import { SettingsPage } from '../app/settings';
import { chatScenario, type ChatStoryState, type ChatScenario } from './chat-scenario';
import { SceneProviders } from './scene-providers';
import { useMountEffect } from '../lib/use-mount-effect';
import { SessionProvider, useSession } from '../lib/session-context';

const Peer = createContext<ChatScenario | null>(null);
const StoryState = createContext<ChatStoryState>('I1');
function useStorySession() { return useSession()!; }
function ProfileRoute() {
  const session = useStorySession();
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ProfileScreen id={id} session={session} initialTab="computer" />;
}
function AgentsRoute() { return <AllAgentsScreen session={useStorySession()} />; }
function ComputerRoute() { return <ComputerScreen session={useStorySession()} />; }
function SearchRoute() { return <SearchPage session={useStorySession()} />; }
function SettingsRoute() { return <SettingsPage session={useStorySession()} />; }
function EntryRoute() {
  const state = useContext(StoryState);
  return <ChatEntryScreen session={useStorySession()} lastConversationId={state === 'J1' ? 'recent' : state === 'J2' ? 'deleted-root' : undefined} startNew={state === 'J9'} />;
}
function StoryChatRoute() { return <ChatRoute state={useContext(StoryState)} />; }
const routes = { '/': EntryRoute, '/chat': StoryChatRoute, '/agents/[id]': ProfileRoute, '/agents': AgentsRoute, '/settings-computer': ComputerRoute, '/search': SearchRoute, '/settings': SettingsRoute };
function ChatRoute({ state }: { state: ChatStoryState }) {
  const peer = useContext(Peer)!;
  const session = useStorySession();
  const { id, message_seq } = useLocalSearchParams<{ id?: string; message_seq?: string }>();
  return <ChatScreen session={session} id={id} messageSeq={message_seq ? Number(message_seq) : undefined}
    initialDrawerOpen={state.startsWith('E') && id === peer.id}
    initialCardOpen={['I1', 'I3', 'I4', 'I11'].includes(state) && id === peer.id} />;
}

/** Uses the same route screens as the app. Only the HTTP peer and initial local panel differ. */
export function ChatScenePage({ state = 'I1', theme = 'light', scenario }: { state?: ChatStoryState; theme?: 'light' | 'dark'; scenario?: ChatScenario }) {
  // Story variants own fresh sessions/routes; durable drafts remain scoped to the scenario's computer ID.
  // The key is the whole scene identity, so its mount bridges never need to resynchronize.
  return <ChatScene key={`${state}:${theme}`} state={state} theme={theme} scenario={scenario} />;
}

function ChatScene({ state, theme, scenario }: { state: ChatStoryState; theme: 'light' | 'dark'; scenario?: ChatScenario }) {
  // A scenario passed by a test is fixed for this keyed scene; the story default is created once.
  const [peer] = useState(() => scenario ?? chatScenario(state));
  return <GestureHandlerRootView style={{ flex: 1 }}><SessionProvider runtime={peer.runtime}>
    <SessionScene peer={peer} state={state} theme={theme} />
  </SessionProvider></GestureHandlerRootView>;
}

function SessionScene({ peer, state, theme }: { peer: ChatScenario; state: ChatStoryState; theme: 'light' | 'dark' }) {
  const session = useSession();
  return session ? <ConnectedScene key={session.queryIdentity} peer={peer} state={state} theme={theme} /> : null;
}

function ConnectedScene({ peer, state, theme }: { peer: ChatScenario; state: ChatStoryState; theme: 'light' | 'dark' }) {
  const session = useStorySession();
  const [readyPeer, setReadyPeer] = useState<ChatScenario | null>(null);
  useMountEffect(() => {
    const previousTheme = Uniwind.currentTheme;
    Uniwind.setTheme(theme);
    return () => Uniwind.setTheme(previousTheme);
  });
  useMountEffect(() => {
    // Cleanup revokes only this mount's right to publish readiness; the peer always stops.
    let subscribed = true;
    void peer.start(session).then(() => { if (subscribed) setReadyPeer(peer); });
    return () => { subscribed = false; peer.stop(); void KeyboardController.dismiss(); };
  });
  return <View className="flex-1 bg-background">
      {(state.startsWith('J') || readyPeer === peer) && <Peer.Provider value={peer}><StoryState.Provider value={state}>
        <SceneProviders path={state.startsWith('J') ? '/' : '/chat'} location={state.startsWith('J') ? '/' : `/chat?id=${encodeURIComponent(peer.id)}`} routes={routes}>{null}</SceneProviders>
      </StoryState.Provider></Peer.Provider>}
      <PortalHost />
  </View>;
}
