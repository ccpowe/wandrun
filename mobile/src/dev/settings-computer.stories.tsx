import type { Meta, StoryObj } from '@storybook/react-native';
import { PortalHost } from '@rn-primitives/portal';
import { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Uniwind } from 'uniwind';
import BrowserViewer from '../app/browser-viewer';
import SettingsComputer from '../app/settings-computer';
import SettingsComputerEnvironments from '../app/settings-computer-environments';
import { SessionProvider } from '../lib/session-context';
import { useMountEffect } from '../lib/use-mount-effect';
import { SceneProviders } from './scene-providers';
import { seedServerEnvironments, type ServerEnvironmentsScene } from './server-environments-scenario';
import { settingsScenario, type SettingsScenario } from './settings-scenario';

// HTTP-boundary facts only (settings-computer C / E); the page, Query reads and navigation are production code.
const routes = { '/settings-computer-environments': SettingsComputerEnvironments, '/browser-viewer': BrowserViewer };
function ServerScenePage({ scene = 'few', theme = 'light', location = '/settings-computer' }: { scene?: ServerEnvironmentsScene; theme?: 'light' | 'dark'; location?: string }) {
  const peer = useMemo(() => {
    const scenario = settingsScenario('A1');
    seedServerEnvironments(scenario.peers[0]!, scene);
    return scenario;
  }, [scene]);
  return <ServerSceneRuntime key={`${peer.identity}:${theme}:${location}`} peer={peer} theme={theme} location={location} />;
}
function ServerSceneRuntime({ peer, theme, location }: { peer: SettingsScenario; theme: 'light' | 'dark'; location: string }) {
  useMountEffect(() => { peer.start(); return peer.stop; });
  useMountEffect(() => { const previous = Uniwind.currentTheme; Uniwind.setTheme(theme); return () => Uniwind.setTheme(previous); });
  return <GestureHandlerRootView style={{ flex: 1 }}>
    <SessionProvider runtime={peer.runtime}>
      <SceneProviders path="/settings-computer" location={location} routes={routes}><SettingsComputer /></SceneProviders>
    </SessionProvider>
    <PortalHost />
  </GestureHandlerRootView>;
}
const meta = { title: 'settings-computer', component: ServerScenePage, parameters: { fullScreen: true } } satisfies Meta<typeof ServerScenePage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const C1: Story = { name: 'C1 执行环境 · 少量全列', args: { scene: 'few' } };
export const C1Dark: Story = { name: 'C1 执行环境 · 少量 · 深色', args: { scene: 'few', theme: 'dark' } };
export const C2: Story = { name: 'C2 执行环境 · 41 个 · 已暂停收起', args: { scene: 'many' } };
export const E1: Story = { name: 'E1 子页面 · 预选已暂停', args: { scene: 'many', location: '/settings-computer-environments?filter=paused' } };
export const E1Dark: Story = { name: 'E1 子页面 · 深色', args: { scene: 'many', theme: 'dark', location: '/settings-computer-environments?filter=paused' } };
