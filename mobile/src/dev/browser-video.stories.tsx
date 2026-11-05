import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BrowserView, type BrowserViewActions } from '../browser/view.tsx';
import { BrowserVideoOverlay } from '../browser/video-ui.tsx';
import type { BrowserRuntimeSnapshot } from '../browser/runtime.ts';
import { EMPTY_PAGE_STATE } from '../browser/pages.ts';
import { Text } from '../components/ui/text.tsx';
import { initialBrowserScreen, selectBrowserScreen } from '../lib/browser-screen.ts';
import { initialVideoState, type VideoFailureReason, type VideoPhase } from '../lib/browser-video.ts';
import { IDENTITY_VIEW } from '../takeover-lab/geometry.ts';
import { browserStoryTask } from './browser-scene.tsx';
import { FoundationFrame } from './foundation-frame.tsx';
import { SceneProviders } from './scene-providers.tsx';

/** Difficult native-media states are view stories, not claims of decoded video in Expo Go.
 * Production BrowserView / overlay / controls are real; the native frame is an explicit illustration.
 * Runtime transitions and wire inputs are exercised separately at their socket/player boundaries. */
function BrowserVideoStory({ phase = 'playing', reason = 'publisher-not-installed',
  more = true, unconfirmed = false, theme = 'light' }: {
  phase?: VideoPhase; reason?: VideoFailureReason; more?: boolean; unconfirmed?: boolean; theme?: 'light' | 'dark';
}) {
  const transport = 'video';
  const [panel, setPanel] = useState(more ? { kind: 'more' as const } : initialBrowserScreen.panel);
  const [last, setLast] = useState('');
  const task = browserStoryTask('human');
  const effectivePhase = phase;
  const picture = effectivePhase !== 'connecting' && effectivePhase !== 'joining' && effectivePhase !== 'failed';
  const runtime: BrowserRuntimeSnapshot = {
    streamState: 'open', pages: { ...EMPTY_PAGE_STATE, snapshot: { t: 'pages', current: task.current, pages: task.pages, state: 'human',
      epoch: 1, vp: 3, css: [800, 600], dpr: 1, environment_id: task.environment_id, environment_name: task.environment_name,
      capacity: task.capacity, capacity_rejection: null } },
    shown: null, inputReady: effectivePhase === 'playing', ended: false, endedReason: null, error: null, streamError: null,
    decodeFailed: false, decodeFailures: 0, mode: 'mouse', view: IDENTITY_VIEW, container: { w: 0, h: 0 }, pointer: null,
    feedback: null, wheelOffset: 0, pressed: { left: false, right: false }, keyboard: 0, keyboardTarget: null, typingNotice: null, stats: null,
    inputUnknown: unconfirmed,
    video: { ...initialVideoState, transport, phase: effectivePhase, reason },
  };
  const selection = selectBrowserScreen(initialBrowserScreen, { task, pages: runtime.pages, ended: false, online: true, control: true });
  const record = (action: string) => setLast(action);
  const actions: BrowserViewActions = {
    onBack: () => record('返回'), onTakeover: () => record('接管'), onHandback: () => record('交还'), onPanel: setPanel,
    onUrl: () => record('编辑网址'), onUrlChange: () => {}, onNavigate: () => record('访问网址'), onClosePage: () => record('关闭页面'),
    onSwitchPage: () => record('切页'), onNewPage: () => record('新建页面'), onSendBack: () => record('后退'), onReload: () => record('刷新'),
    onMode: () => record('切换模式'), onKeyboard: () => record('打开键盘'), onKeyboardHide: () => {}, onKey: () => {},
    onDebug: () => {}, onLandscape: () => {}, onReconnect: () => record('重新连接'), onDismissError: () => {},
    onRetryTyping: () => {}, onDismissTyping: () => {},
    onInput: () => {}, onUrlInput: () => {}, onInputFocus: () => {}, onInputBlur: () => {}, onTyped: () => {}, onBackspace: () => {}, onSubmit: () => {},
  };
  const stage = () => <View className="flex-1 bg-immersive-panel">
    {picture && <View className="absolute inset-4 gap-3 rounded-sm bg-card p-4"><Text variant="body">example.com</Text>
      <View className="h-5 w-3/4 rounded-sm bg-muted"/><View className="h-3 rounded-sm bg-muted"/>
      <View className="h-28 rounded-sm bg-muted"/><View className="h-3 w-5/6 rounded-sm bg-muted"/>
      <Text variant="caption" className="text-muted-foreground">原生播放器边界示意，非视频解码</Text>
    </View>}
    <BrowserVideoOverlay phase={effectivePhase} reason={reason} hasPicture={picture}
      onRetry={() => record('重试视频')}/>
  </View>;
  return <FoundationFrame theme={theme} scrollable={false}><GestureHandlerRootView style={{ flex: 1 }}><SceneProviders>
    <BrowserView id={task.id} control task={task} agentName="研究员" runtime={runtime} {...selection} canCreatePage emptyControlPages={false}
      panel={panel} debug={false} landscape={false} landscapeEnabled={false}
      focused active insets={{ top: 24, bottom: 16, left: 0, right: 0 }} stage={stage} diagnostics={null} banner={null} error={null} actions={actions}/>
    {last ? <Text variant="caption" className="px-4 py-2 text-muted-foreground">Storybook：{last}</Text> : null}<PortalHost/>
  </SceneProviders></GestureHandlerRootView></FoundationFrame>;
}
const meta = { title: 'browser-video', component: BrowserVideoStory, parameters: { fullScreen: true },
  argTypes: { reason: { control: 'select', options: ['publisher-not-installed', 'publisher-start-timeout', 'publisher-exited', 'cdp-unreachable', 'page-publish-timeout', 'sfu-unreachable', 'token-failed', 'watch-limit', 'page-unavailable', 'join-timeout', 'first-frame-timeout'] } },
} satisfies Meta<typeof BrowserVideoStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const D2: Story = { name: 'D2 视频连接中 · 尚无画面', args: { phase: 'connecting', more: false } };
export const D3: Story = { name: 'D3 切换中 · 保留旧画面', args: { phase: 'switching', more: false } };
export const D4: Story = { name: 'D4 推流组件未安装', args: { phase: 'failed', more: false } };
export const D4StartTimeout: Story = { name: 'D4 视频启动超时', args: { phase: 'failed', reason: 'publisher-start-timeout', more: false } };
export const D4Exited: Story = { name: 'D4 推流已停止', args: { phase: 'failed', reason: 'publisher-exited', more: false } };
export const D4Cdp: Story = { name: 'D4 浏览器连接不可用', args: { phase: 'failed', reason: 'cdp-unreachable', more: false } };
export const D4PublishTimeout: Story = { name: 'D4 页面视频发布超时', args: { phase: 'failed', reason: 'page-publish-timeout', more: false } };
export const D4Sfu: Story = { name: 'D4 视频服务不可达', args: { phase: 'failed', reason: 'sfu-unreachable', more: false } };
export const D4Token: Story = { name: 'D4 视频授权失败', args: { phase: 'failed', reason: 'token-failed', more: false } };
export const D4Limit: Story = { name: 'D4 同时观看达到上限', args: { phase: 'failed', reason: 'watch-limit', more: false } };
export const D4Page: Story = { name: 'D4 页面画面不存在', args: { phase: 'failed', reason: 'page-unavailable', more: false } };
export const D4Join: Story = { name: 'D4 入房或订阅超时', args: { phase: 'failed', reason: 'join-timeout', more: false } };
export const D4FirstFrame: Story = { name: 'D4 首帧超时', args: { phase: 'failed', reason: 'first-frame-timeout', more: false } };
export const D6: Story = { name: 'D6 重连中 · 保留最后画面', args: { phase: 'reconnecting', more: false } };
export const D9: Story = { name: 'D9 视频播放 · 原操作入口', args: { more: false } };
export const D10: Story = { name: 'D10 部分操作结果未确认', args: { unconfirmed: true, more: false } };
