import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useRef, useState } from 'react';
import { View, type TextInput } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BrowserView, type BrowserViewActions } from '../browser/view.tsx';
import { BrowserStage, type StageChrome } from '../browser/stage.tsx';
import type { BrowserRuntimeSnapshot } from '../browser/runtime.ts';
import { EMPTY_PAGE_STATE } from '../browser/pages.ts';
import { Text } from '../components/ui/text.tsx';
import { initialBrowserScreen, selectBrowserScreen, type BrowserScreenState } from '../lib/browser-screen.ts';
import { initialVideoState } from '../lib/browser-video.ts';
import { IDENTITY_VIEW } from '../takeover-lab/geometry.ts';
import { browserStoryTask } from './browser-scene.tsx';
import { FoundationFrame } from './foundation-frame.tsx';
import { SceneProviders } from './scene-providers.tsx';

/** Difficult view states use the live selector. Actions are recorded, never network commands. */
function ViewStory({ scenario = 'unknown', theme = 'light' }: { scenario?: 'busy' | 'unknown' | 'failure' | 'empty' | 'typing' | 'discarded' | 'ended'; theme?: 'light' | 'dark' }) {
  const [lastAction, setLastAction] = useState('');
  const input = useRef<TextInput | null>(null), urlInput = useRef<TextInput | null>(null);
  const control = scenario === 'empty' || scenario === 'typing' || scenario === 'discarded';
  const task = browserStoryTask(control ? 'human' : 'requested');
  if (control) { task.pages = []; task.current = null; }
  const local: BrowserScreenState = scenario === 'busy' ? { ...initialBrowserScreen, status: 'running', operationId: 'op', command: 'takeover' }
    : { ...initialBrowserScreen, error: scenario === 'failure' ? '无法接管浏览器' : '' };
  const r: BrowserRuntimeSnapshot = { streamState: control ? 'open' : 'closed', pages: control ? { ...EMPTY_PAGE_STATE, snapshot: { t: 'pages', state: 'human', pages: [], current: null, epoch: 1, vp: 1, css: [800, 600], dpr: 1, environment_id: task.environment_id, environment_name: task.environment_name, capacity: task.capacity, capacity_rejection: null } } : EMPTY_PAGE_STATE,
    shown: null, inputReady: false, ended: false, endedReason: null, error: null, streamError: null, decodeFailed: false, decodeFailures: 0,
    mode: 'mouse', view: IDENTITY_VIEW, container: { w: 0, h: 0 }, pointer: null, feedback: null, wheelOffset: 0,
    video: initialVideoState, inputUnknown: false,
    pressed: { left: false, right: false }, keyboard: 0, keyboardTarget: null, typingNotice: scenario === 'typing' ? 'pending' : scenario === 'discarded' ? 'discarded' : null, stats: null };
  const selection = selectBrowserScreen(local, { task, pages: r.pages, ended: false, online: true, control,
    outcome: scenario === 'unknown' ? { operationId: 'op', resource: 'browser', id: task.id, action: 'save', status: 'unknown', error: '', reconciled: false } : undefined });
  const record = (action: string) => setLastAction(action);
  const actions: BrowserViewActions = {
    onBack: () => record('返回'), onTakeover: () => record('接管'), onHandback: () => record('交还'), onPanel: panel => record(`面板 ${panel.kind}`),
    onUrl: () => record('编辑网址'), onUrlChange: value => record(`网址 ${value}`), onNavigate: () => record('访问网址'), onClosePage: id => record(`关闭 ${id}`),
    onSwitchPage: id => record(`切页 ${id}`), onNewPage: () => record('新建页面'), onSendBack: () => record('后退'), onReload: () => record('刷新'),
    onMode: () => record('切换模式'), onKeyboard: () => record('打开键盘'), onKeyboardHide: () => record('收起键盘'), onKey: key => record(key),
    onDebug: value => record(`调试 ${value}`), onLandscape: value => record(`横屏 ${value}`), onReconnect: () => record('重连'),
    onDismissError: () => record('关闭错误'), onRetryTyping: () => record('重试输入'), onDismissTyping: () => record('关闭输入提示'),
    onInput: node => { input.current = node; }, onUrlInput: node => { urlInput.current = node; },
    onInputFocus: () => record('输入聚焦'), onInputBlur: () => record('输入失焦'), onTyped: value => record(`输入 ${value}`), onBackspace: () => record('删除字符'), onSubmit: () => record('提交输入'),
  };
  const stage = (chrome: StageChrome) => <BrowserStage snapshot={r} chrome={chrome} control={control} landscape={false} human={selection.human} stopped={false} empty={control} canCreate debug={false} diagnostics={null}
    videoPlayer={null} onRetryVideo={() => record('重试视频')}
    onLayout={size => record(`布局 ${size.w}×${size.h}`)} onDisplayed={() => record('显示画面')} onTouch={() => record('画面手势')}
    onWheel={() => record('滚动')} onButton={button => record(button)} onSwitchPage={actions.onSwitchPage} onDismissNotice={() => record('关闭页面提示')}
    onNewPage={actions.onNewPage} onReconnect={actions.onReconnect}/>;
  return <FoundationFrame theme={theme} scrollable={false}><GestureHandlerRootView style={{ flex: 1 }}><SceneProviders><View className="flex-1">
    <BrowserView id={task.id} control={control} task={task} agentName="研究员" runtime={r} {...selection} canCreatePage emptyControlPages={control}
      debug={false} landscape={false} landscapeEnabled={false} focused active insets={{ top: 24, bottom: 16, left: 0, right: 0 }} stage={stage} diagnostics={null} banner={null} error={selection.error || (scenario === 'ended' ? '浏览器任务已结束' : null)} errorDismissible={!!selection.error} actions={actions}/>
    {lastAction && <Text variant="caption" className="px-4 py-2 text-muted-foreground">Storybook：{lastAction}</Text>}<PortalHost/>
  </View></SceneProviders></GestureHandlerRootView></FoundationFrame>;
}
const meta = { title: 'browser-view', component: ViewStory, parameters: { fullScreen: true } } satisfies Meta<typeof ViewStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const A5: Story = { name: 'A5 视图 · 接管中', args: { scenario: 'busy' } };
export const A6: Story = { name: 'A6 视图 · 接管明确失败', args: { scenario: 'failure' } };
export const A7: Story = { name: 'A7 视图 · 操作结果未确认', args: { scenario: 'unknown' } };
export const A7Dark: Story = { name: 'A7 视图 · 操作结果未确认（深色）', args: { scenario: 'unknown', theme: 'dark' } };
export const B5: Story = { name: 'B5 视图 · human 租约零页', args: { scenario: 'empty' } };
export const B7: Story = { name: 'B7 视图 · 部分文字未发送（持续状态，无 ×）', args: { scenario: 'typing' } };
export const B7Discarded: Story = { name: 'B7 视图 · 部分输入已丢弃（一次性结果，× 关闭）', args: { scenario: 'discarded' } };
export const A4Ended: Story = { name: 'A4 视图 · 运行时持续状态（无 ×）', args: { scenario: 'ended' } };
