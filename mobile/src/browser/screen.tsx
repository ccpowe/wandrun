import { skipToken } from '@tanstack/react-query';
import { router, useIsFocused, useNavigation } from 'expo-router';
import { CircleAlert, WifiOff } from 'lucide-react-native';
import { Suspense, useReducer, useState, useSyncExternalStore } from 'react';
import { AppState, Keyboard as NativeKeyboard, useWindowDimensions } from 'react-native';
import { KeyboardEvents } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBanner } from '../components/status-banner.tsx';
import type { ChatSession } from '../gateway/session.ts';
import { newClientId } from '../gateway/session.ts';
import { agentDisplayName } from '../lib/agent-display-name.ts';
import { browserScreenReducer, initialBrowserScreen, selectBrowserScreen, type BrowserCommand, type BrowserPanel } from '../lib/browser-screen.ts';
import { useConnectionLabel } from '../lib/connection-banner.tsx';
import { returnToConversation } from '../lib/chat-navigation.ts';
import { browserTaskOptions } from '../lib/gateway-queries.ts';
import { useTranslation } from '../lib/i18n.ts';
import { useSession } from '../lib/session-context.tsx';
import { useFocusedVisit } from '../lib/use-focused-visit.ts';
import { useGatewayQuery } from '../lib/use-gateway-query.ts';
import { useMountEffect } from '../lib/use-mount-effect.ts';
import { HiddenStatusBar, useImmersiveStatusBar } from '../lib/use-status-bar-appearance.tsx';
import { userErrorMessage } from '../lib/user-error.ts';
import { useDelayedNotice } from '../lib/use-delayed-notice.ts';
import { BrowserDiagnostics, BrowserDiagnosticsSubscription } from './diagnostics.tsx';
import { currentPage, isEmptyControlPages } from './pages.ts';
import { BrowserRuntime } from './runtime.ts';
import { BrowserStage, type StageChrome } from './stage.tsx';
import { BrowserView, type BrowserViewActions } from './view.tsx';
import { browserVideoAvailable, BrowserVideoPlayer } from './video-player.tsx';

export type BrowserScreenProps = { id: string; page?: string; control: true; landscapeEnabled: boolean; onLandscapeChange(value: boolean): void } | { id: string; page?: string; control: false };
export function BrowserScreen(props: BrowserScreenProps) {
  const session = useSession();
  if (!session) return null;
  return <BrowserContainer key={`${session.queryIdentity}:${props.id}:${props.control}`} session={session} {...props}/>;
}
const subscribeAppState = (notify: () => void) => { const subscription = AppState.addEventListener('change', notify); return () => subscription.remove(); };
const appStateSnapshot = () => AppState.currentState;
function BrowserNativeSubscription({ runtime, onKeyboardHidden }: { runtime: BrowserRuntime; onKeyboardHidden(): void }) {
  useMountEffect(() => {
    const hide = () => { runtime.keyboardHide(); onKeyboardHidden(); };
    const subscriptions = [
      AppState.addEventListener('change', value => { if (value !== 'active') hide(); }),
      KeyboardEvents.addListener('keyboardWillShow', event => { if (AppState.currentState === 'active') runtime.keyboardShow(event.height); }),
      KeyboardEvents.addListener('keyboardDidHide', hide),
    ];
    return () => { subscriptions.forEach(subscription => subscription.remove()); };
  });
  return null;
}
function BrowserStreamSubscription({ runtime }: { runtime: BrowserRuntime }) {
  useMountEffect(() => runtime.attach());
  return null;
}
function BrowserContainer({ session, ...props }: BrowserScreenProps & { session: ChatSession }) {
  const { id, page, control } = props;
  const { t } = useTranslation();
  useSyncExternalStore(session.subscribe, session.getVersion);
  const focused = useIsFocused();
  const navigation = useNavigation();
  const active = useSyncExternalStore(subscribeAppState, appStateSnapshot) === 'active';
  useImmersiveStatusBar(control);
  const [runtime] = useState(() => new BrowserRuntime(session.api, id, control, page,
    () => { const state = session.browserTasks.get(id)?.state; return state !== 'released' && state !== 'revoking' && state !== 'stopping'; }, {
      isLeaseEnded: () => { const state = session.browserTasks.get(id)?.state; return state === 'released' || state === 'stopping'; },
      subscribeTask: session.subscribe,
      createVideoPlayer: events => browserVideoAvailable() ? new BrowserVideoPlayer(events) : null,
    }));
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [state, dispatch] = useReducer(browserScreenReducer, initialBrowserScreen);
  const listedTask = session.browserTasks.get(id);
  const read = useGatewayQuery(id && !listedTask ? browserTaskOptions(session, id) : skipToken);
  const task = listedTask ?? read.data;
  const operationKey = `browser:${id}`;
  const selection = selectBrowserScreen(state, { task, pages: snapshot.pages, ended: snapshot.ended,
    online: session.connection === 'open', control, outcome: session.editorOperations.get(operationKey) });
  const connectionLabel = useConnectionLabel(session);
  const showReconnect = useDelayedNotice(snapshot.streamState === 'reconnecting' ? id : null);
  const showReadError = useDelayedNotice(read.error ? id : null);
  // Persistent states first (they disappear with their state); one-time results last and closable.
  const error = selection.error || snapshot.endedReason || (!snapshot.streamError ? snapshot.error : null);
  const errorDismissible = !!selection.error || !snapshot.endedReason && !!snapshot.error;
  const connectionNotice = connectionLabel ?? (showReconnect ? t('无法连接画面，正在重试…') : null);
  const captureVisit = useFocusedVisit();
  const insets = useSafeAreaInsets(), window = useWindowDimensions();
  const landscape = control && window.width > window.height;
  const capacity = snapshot.pages.snapshot?.capacity ?? task?.capacity;
  const empty = control && !selection.stopped && snapshot.streamState === 'open' && isEmptyControlPages(snapshot.pages);
  const canCreate = selection.human && !selection.stopped && snapshot.streamState === 'open'
    && snapshot.pages.snapshot?.state === 'human' && (capacity?.pages_used ?? 0) < (capacity?.pages_limit ?? 0);
  const current = snapshot.pages.snapshot ? currentPage(snapshot.pages)
    : task?.pages.find(item => item.id === page) ?? task?.pages.find(item => item.id === task.current) ?? null;
  const panel = selection.panel;
  const changePanel = (next: BrowserPanel) => {
    runtime.blurInputs(); NativeKeyboard.dismiss();
    dispatch({ type: 'panel', panel: next });
  };
  const currentSelection = () => selectBrowserScreen(state, { task: session.browserTasks.get(id) ?? task,
    pages: runtime.getSnapshot().pages, ended: runtime.getSnapshot().ended, online: session.connection === 'open', control,
    outcome: session.editorOperations.get(operationKey) });
  async function command(kind: BrowserCommand, target?: string) {
    const now = currentSelection();
    if (kind === 'takeover' ? !now.canTakeover : kind === 'handback' ? !now.canReturnControl : !now.canClosePage) return;
    const operationId = newClientId(), isCurrentVisit = captureVisit();
    if (kind === 'handback') runtime.flushTyping();
    dispatch({ type: 'start', operationId, command: kind });
    try {
      const fields = kind === 'takeover' ? { state: 'human' } : kind === 'handback' ? { state: 'agent' } : { closedPage: target };
      const result = await session.editorOperations.run(operationKey, { operationId, resource: 'browser', id, action: 'save', fields },
        () => kind === 'takeover' ? session.api.takeoverBrowser(id, operationId)
          : kind === 'handback' ? session.api.handbackBrowser(id, operationId) : session.api.closeBrowserPage(id, target!));
      if (!result) { dispatch({ type: 'failed', operationId, error: '' }); return; }
      dispatch({ type: 'succeeded', operationId, remainingPages: result.browser_task.pages.length });
      if (!isCurrentVisit() || currentSelection().stopped) return;
      if (kind === 'takeover') router.push({ pathname: '/browser-takeover', params: { id, ...(current ? { page: current.id } : {}) } });
      else if (kind === 'handback' && task) returnToConversation(navigation, task.root_id);
    } catch (reason) {
      const outcome = session.editorOperations.get(operationKey);
      const unconfirmed = outcome?.operationId === operationId && (outcome.status === 'unknown' || outcome.reconciled);
      dispatch({ type: 'failed', operationId, error: unconfirmed ? '' : userErrorMessage(reason, kind === 'takeover' ? '无法接管浏览器' : kind === 'handback' ? '无法交还浏览器' : '关闭页面失败') });
    }
  }
  const actions: BrowserViewActions = {
    onBack: () => router.back(), onTakeover: () => void command('takeover'), onHandback: () => void command('handback'),
    onPanel: changePanel,
    onUrl: () => { runtime.editUrl(); dispatch({ type: 'panel', panel: { kind: 'url', draft: current?.url ?? '' } }); },
    onUrlChange: draft => dispatch({ type: 'url', draft }),
    onNavigate: () => {
      if (panel.kind !== 'url' || runtime.getSnapshot().keyboardTarget !== 'url' || AppState.currentState !== 'active') return;
      const address = panel.draft.trim();
      if (!/^https?:\/\//i.test(address)) { runtime.setError('网址无效，请输入 http 或 https 网址'); return; }
      runtime.send({ t: 'navigate', url: address }); runtime.endUrl(); dispatch({ type: 'panel', panel: { kind: 'stage' } });
    },
    onClosePage: target => {
      if (!currentSelection().canClosePage) return;
      if ((snapshot.pages.snapshot?.pages ?? task?.pages ?? []).length === 1 && panel.kind !== 'close-page') changePanel({ kind: 'close-page', target });
      else void command('close-page', target);
    },
    onSwitchPage: target => { runtime.switchPage(target); changePanel({ kind: 'stage' }); },
    onNewPage: () => { if (canCreate) runtime.newPage(); changePanel({ kind: 'stage' }); },
    onSendBack: () => { runtime.send({ t: 'back' }); }, onReload: () => { runtime.send({ t: 'reload' }); },
    onMode: () => runtime.setMode(snapshot.mode === 'mouse' ? 'touch' : 'mouse'), onKeyboard: () => runtime.input?.focus(),
    onKeyboardHide: () => runtime.input?.blur(), onKey: runtime.sendKey,
    onDebug: value => dispatch({ type: 'debug', value }), onLandscape: value => { if (props.control) props.onLandscapeChange(value); changePanel({ kind: 'stage' }); },
    onReconnect: () => dispatch({ type: 'reconnect' }), onDismissError: () => { runtime.setError(null); dispatch({ type: 'dismiss-error' }); },
    onRetryTyping: () => { runtime.flushTyping(); }, onDismissTyping: runtime.dismissTypingNotice,
    onInput: runtime.attachInput, onUrlInput: runtime.attachUrlInput,
    onInputFocus: runtime.focusInput, onInputBlur: runtime.blurInput, onTyped: runtime.typed, onBackspace: runtime.backspace,
    onSubmit: () => { runtime.flushTyping(true); },
  };
  const diagnostics = <BrowserDiagnostics snapshot={snapshot}/>;
  const streaming = focused && active && !selection.stopped;
  const stage = (chrome: StageChrome) => <BrowserStage snapshot={snapshot} chrome={chrome} control={control} landscape={landscape} human={selection.human} stopped={selection.stopped}
    empty={empty} canCreate={canCreate} debug={state.debug} reason={task?.reason} diagnostics={diagnostics}
    onLayout={runtime.layout} onDisplayed={runtime.onDisplayed} onTouch={runtime.touchEvent} onWheel={runtime.wheelEvent}
    onButton={runtime.buttonEvent} onSwitchPage={runtime.switchPage} onDismissNotice={runtime.dismissNotice}
    videoPlayer={runtime.videoPlayer} onRetryVideo={runtime.retryVideo}
    onNewPage={actions.onNewPage} onReconnect={actions.onReconnect}/>;
  return <>
    {control && focused && active && <HiddenStatusBar/>}
    <BrowserNativeSubscription runtime={runtime} onKeyboardHidden={() => dispatch({ type: 'keyboard-hidden' })}/>
    {streaming && <Suspense fallback={null}><BrowserStreamSubscription key={state.reconnect} runtime={runtime}/></Suspense>}
    {streaming && state.debug && snapshot.streamState === 'open' && <BrowserDiagnosticsSubscription key={state.reconnect} runtime={runtime}/>}
    <BrowserView id={id} control={control} task={task && current && !snapshot.pages.snapshot ? { ...task, current: current.id } : task}
      agentName={agentDisplayName(session.agents, task?.entry_agent_id, task?.entry_agent_name)} runtime={snapshot}
      {...selection} panel={panel} canCreatePage={canCreate} emptyControlPages={empty} debug={state.debug}
      landscape={landscape} landscapeEnabled={props.control && props.landscapeEnabled} focused={focused} active={active}
      insets={insets} stage={stage} diagnostics={diagnostics} actions={actions} error={connectionNotice ? null : error} errorDismissible={errorDismissible}
      banner={connectionNotice ? <StatusBanner icon={WifiOff} title={connectionNotice} description={connectionLabel ? t('内容可能不是最新的') : undefined}/>
        : !error && !snapshot.streamError && read.error && showReadError ? <StatusBanner icon={CircleAlert} title={t('无法加载浏览器任务，正在重试…')}/> : null}/>
  </>;
}
