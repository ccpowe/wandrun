import { ChevronLeft, CircleAlert, Hand, Keyboard, LockKeyhole, MoreHorizontal, MousePointer2, RotateCw, Smartphone, X } from 'lucide-react-native';
import { StatusBanner } from '../components/status-banner.tsx';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import type { BrowserTask } from '../gateway/api.ts';
import type { BrowserPanel } from '../lib/browser-screen.ts';
import { useTranslation } from '../lib/i18n.ts';
import { Button } from '../components/ui/button.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { Input } from '../components/ui/input.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { Text } from '../components/ui/text.tsx';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../components/ui/alert-dialog.tsx';
import { currentPage, hostOf, pageLabel } from './pages.ts';
import type { BrowserRuntimeSnapshot } from './runtime.ts';
import type { StageChrome } from './stage.tsx';
import type { KeyName } from '../takeover-lab/keys.ts';
import { HELPER_KEYS } from '../takeover-lab/keys.ts';
import { useDelayedNotice } from '../lib/use-delayed-notice.ts';

export type BrowserViewActions = {
  onBack(): void; onTakeover(): void; onHandback(): void; onPanel(panel: BrowserPanel): void;
  onUrl(): void; onUrlChange(value: string): void; onNavigate(): void; onClosePage(id: string): void;
  onSwitchPage(id: string): void; onNewPage(): void; onSendBack(): void; onReload(): void;
  onMode(): void; onKeyboard(): void; onKeyboardHide(): void; onKey(key: KeyName): void;
  onDebug(value: boolean): void; onLandscape(value: boolean): void; onReconnect(): void;
  onDismissError(): void; onRetryTyping(): void; onDismissTyping(): void;
  onInput(node: TextInput | null): void; onUrlInput(node: TextInput | null): void;
  onInputFocus(): void; onInputBlur(): void; onTyped(value: string): void; onBackspace(): void; onSubmit(): void;
};
export type BrowserViewProps = {
  id: string; control: boolean; task?: BrowserTask | null; agentName: string;
  runtime: BrowserRuntimeSnapshot; human: boolean; stopped: boolean; busy: boolean;
  unknown: boolean;
  canTakeover: boolean; canHandback: boolean; canReturnControl: boolean; canClosePage: boolean; canCreatePage: boolean;
  emptyControlPages: boolean; effectiveState?: BrowserTask['state']; panel: BrowserPanel; debug: boolean;
  landscape: boolean; landscapeEnabled: boolean; focused: boolean; active: boolean;
  insets: { top: number; bottom: number; left: number; right: number };
  /** Rendered with the measured chrome so the portrait picture can center on the whole screen. */
  stage(chrome: StageChrome): ReactNode; diagnostics: ReactNode; banner: ReactNode; error: string | null;
  /** design.md 提醒规则：only one-time results (command failure, rejected input / popup) can be closed;
   * persistent states (ended, stream connection failure) and unconfirmed results disappear with their state. */
  errorDismissible?: boolean;
  actions: BrowserViewActions;
};
function IconButton({ icon, label, onPress, testID, disabled = false, immersive = false }: { icon: typeof X; label: string; onPress(): void; testID?: string; disabled?: boolean; immersive?: boolean }) {
  return <Button intent="quiet" size="icon" accessibilityLabel={label} testID={testID} disabled={disabled} onPress={onPress}><Icon as={icon} className={disabled ? (immersive ? "size-5 text-immersive-muted-foreground/60" : "size-5") : immersive ? "size-5 text-immersive-foreground" : "size-5 text-foreground"} /></Button>;
}
/** Takeover is immersive in both themes (browser.B1): solid fills, no outlines. */
const SOLID = 'bg-immersive-foreground/20';
export function BrowserView(p: BrowserViewProps) {
  const { t, locale } = useTranslation();
  const { control, task, human, stopped, busy, panel, runtime: r, actions: a, landscape, insets } = p;
  const showUnknown = useDelayedNotice(p.unknown ? p.id : null);
  const showInputUnknown = useDelayedNotice(r.inputUnknown ? p.id : null);
  const selectedPage = r.pages.snapshot ? currentPage(r.pages) : task?.pages.find(item => item.id === task.current) ?? null;
  const pages = r.pages.snapshot?.pages ?? task?.pages ?? [];
  const capacity = r.pages.snapshot?.capacity ?? task?.capacity;
  const used = capacity?.pages_used ?? 0, limit = capacity?.pages_limit ?? 0;
  const format = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const urlEditing = panel.kind === 'url';
  const remoteKeyboard = r.keyboardTarget === 'remote' && r.keyboard > 0;
  const status = t(stopped ? '已结束' : human ? '操作中' : p.effectiveState === 'requested' ? '等你接管' : p.effectiveState === 'human' ? '你接管中' : p.effectiveState === 'revoking' ? '正在结束' : 'Agent 操作中');
  const subtitle = `${p.agentName} · ${task?.conversation_title ?? ''}`;
  const handback = <Button intent="soft" testID="takeover-handback" accessibilityLabel={t('交还浏览器')} disabled={!p.canReturnControl} onPress={a.onHandback} className={`${SOLID} px-5`}><Text className="text-immersive-foreground">{t('交还')}</Text></Button>;
  const pageButton = <Button intent="quiet" size="icon" testID="takeover-pages" accessibilityLabel={t('页面，共 {count} 个', { count: pages.length })} onPress={() => a.onPanel({ kind: 'pages' })}><Text className="rounded-[4px] border-[1.5px] border-immersive-foreground px-1.5 text-xs text-immersive-foreground">{format.format(pages.length)}</Text></Button>;
  // Landscape items match takeover-lab CONTROL_COLUMN (py-1, icon 24, gap 4, label 16); compact keeps only the icon (browser.W7).
  const dock = (compact: boolean) => {
    const item = landscape ? 'h-auto min-h-0 min-w-16 flex-col gap-1 py-1' : 'h-auto min-w-16 flex-col gap-1 py-2';
    const label = (text: string) => !compact && <Text className="text-xs text-immersive-foreground">{text}</Text>;
    return <>
      <Button intent="quiet" testID="takeover-mode" accessibilityLabel={t('当前{mode}模式，点按切换', { mode: t(r.mode === 'mouse' ? '鼠标' : '触控') })} disabled={p.emptyControlPages} onPress={a.onMode} className={item}><Icon as={r.mode === 'mouse' ? MousePointer2 : Hand} className="size-6 text-immersive-foreground"/>{label(t(r.mode === 'mouse' ? '鼠标' : '触控'))}</Button>
      <Button intent="quiet" testID="takeover-keyboard" accessibilityLabel={t('打开键盘')} disabled={!human || p.emptyControlPages || r.streamState !== 'open' || !r.inputReady} onPress={a.onKeyboard} className={item}><Icon as={Keyboard} className="size-6 text-immersive-foreground"/>{label(t('键盘'))}</Button>
      <Button intent="quiet" testID="takeover-more" accessibilityLabel={t('更多')} onPress={() => a.onPanel({ kind: 'more' })} className={item}><Icon as={MoreHorizontal} className="size-6 text-immersive-foreground"/>{label(t('更多'))}</Button>
    </>;
  };
  // Root height and the stage row's offset give the stage its distance to both screen edges.
  const [rootHeight, setRootHeight] = useState(0);
  const [row, setRow] = useState({ y: 0, h: 0 });
  const measured = rootHeight && row.h ? { above: row.y, below: Math.max(0, rootHeight - row.y - row.h) } : { above: 0, below: 0 };
  // Landscape B: the stage lays out handback and dock in its right control column (browser.B6).
  const chrome: StageChrome = control && landscape ? { ...measured, handback, dock } : measured;
  return <View testID="browser-root" className={control ? "flex-1 bg-immersive-panel" : "flex-1 bg-background"} onLayout={event => setRootHeight(event.nativeEvent.layout.height)} style={{ paddingTop: remoteKeyboard ? 0 : insets.top, paddingBottom: r.keyboard || (landscape ? Math.max(insets.bottom, 8) : insets.bottom), paddingLeft: landscape ? insets.left : 0, paddingRight: landscape ? insets.right : 0 }}>
    {!remoteKeyboard && !(landscape && !urlEditing) && (control ? <>
      <View testID="takeover-top-bar" className="h-13 flex-row items-center gap-2 pl-4 pr-3"><View className="size-2 rounded-full bg-destructive"/><Text variant="body" className="text-immersive-foreground">{status}</Text><Text variant="caption" numberOfLines={1} className="min-w-0 flex-1 text-immersive-muted-foreground">{subtitle}</Text>{handback}</View>
      <View testID="takeover-address-bar" className="h-11 flex-row items-center gap-1 px-2">
        <IconButton immersive icon={ChevronLeft} label={t('后退')} onPress={a.onSendBack} disabled={!human || !selectedPage}/>
        <IconButton immersive icon={RotateCw} label={t('刷新')} onPress={a.onReload} disabled={!human || !selectedPage}/>
        {/* browser.W1（待确认）：编辑态沿用地址胶囊的暗色填充。 */}
        {urlEditing ? <><Input ref={node => a.onUrlInput(node)} testID="takeover-url" accessibilityLabel={t('网址')} autoFocus autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" submitBehavior="submit" value={panel.draft} onChangeText={a.onUrlChange} onSubmitEditing={a.onNavigate} onBlur={() => a.onPanel({ kind: 'stage' })} tone="muted" className="h-9 min-h-9 min-w-0 flex-1 rounded-full bg-immersive-foreground/10 text-immersive-foreground"/><IconButton immersive icon={X} label={t('取消编辑网址')} testID="takeover-url-cancel" onPress={() => a.onPanel({ kind: 'stage' })}/></>
          : <Button intent="soft" testID="takeover-url" accessibilityLabel={t('编辑网址')} disabled={!human || !selectedPage} onPress={a.onUrl} className="h-9 min-h-9 min-w-0 flex-1 justify-start gap-2 bg-immersive-foreground/10 px-3 py-0"><Icon as={LockKeyhole} size={12} className="text-immersive-muted-foreground"/><Text variant="caption" numberOfLines={1} className="min-w-0 flex-1 text-immersive-foreground">{selectedPage ? hostOf(selectedPage.url) : t('没有页面')}</Text></Button>}
        {pageButton}
      </View>
    </> : <>
      <View className="min-h-14 flex-row items-center justify-between px-3"><IconButton icon={X} label={t('关闭观看')} testID="viewer-close" onPress={a.onBack}/><View className="min-w-0 flex-1 items-center"><Text className="text-lg font-medium">{t('浏览器')}</Text><Text numberOfLines={1} className="text-xs text-muted-foreground">{subtitle}</Text></View><View className="w-12"/></View>
      <View className="items-center pb-3 pt-1"><Text className="max-w-[95%] rounded-full bg-muted px-3 py-2 text-xs">● {status} · {selectedPage ? hostOf(selectedPage.url) : t('没有页面')} · {t('共 {count} 个页面', { count: format.format(pages.length) })}</Text></View>
    </>)}
    {p.banner}
    {/* design.md 提醒规则：一次性命令失败可 × 关闭；持续状态与结果未确认（browser.A7）随状态撤销、无 ×。 */}
    {p.error && (!p.unknown || showUnknown) && (p.unknown || !r.inputUnknown && !r.typingNotice) && panel.kind !== 'close-page' && <View testID="browser-error"><StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(p.error)}
      action={p.errorDismissible && !p.unknown ? { icon: X, label: t('关闭提示'), onPress: a.onDismissError, testID: 'browser-error-dismiss' } : undefined}/></View>}
    {r.inputUnknown && showInputUnknown && !p.unknown && <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t('部分操作结果未确认，请检查页面')}/>}
    <View testID="browser-row" className={landscape ? 'flex-1 flex-row' : 'flex-1'} onLayout={event => setRow({ y: event.nativeEvent.layout.y, h: event.nativeEvent.layout.height })}>
      {p.stage(chrome)}
    </View>
    {r.typingNotice && !r.inputUnknown && !p.unknown && <View testID="browser-input-notice" className="gap-1 pt-2"><StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(r.typingNotice === 'pending' ? '部分文字尚未发送，已保留；画面恢复后可重试发送' : '部分输入未发送且已丢弃，请检查页面后重新输入')}
      action={r.typingNotice === 'discarded' ? { icon: X, label: t('关闭提示'), onPress: a.onDismissTyping, testID: 'browser-input-dismiss' } : undefined}/>
      {r.typingNotice === 'pending' && <Button intent="quiet" className="mx-4 self-start" testID="browser-input-retry" accessibilityLabel={t('重试发送')} disabled={!r.inputReady || r.streamState !== 'open' || !human} onPress={a.onRetryTyping}><Text>{t('重试发送')}</Text></Button>}</View>}
    {r.decodeFailed && r.shown && <Text variant="caption" className="bg-card px-4 py-2 text-destructive">{t('最新画面解码失败，正在显示上一帧')}</Text>}
    {control && <TextInput ref={node => a.onInput(node)} testID="takeover-input-text" accessibilityLabel={t('远端键盘输入')} style={{ position: 'absolute', left: 0, bottom: 0, width: 1, height: 1, opacity: 0 }} onFocus={a.onInputFocus} onBlur={a.onInputBlur} onChangeText={a.onTyped} onKeyPress={event => { if (event.nativeEvent.key === 'Backspace') a.onBackspace(); }} onSubmitEditing={a.onSubmit} submitBehavior="submit" autoCorrect={false} autoComplete="off" spellCheck={false} autoCapitalize="none" {...{ importantForAutofill: 'no' as const }} contextMenuHidden caretHidden returnKeyType="send"/>}
    {/* browser.W4（待确认）：辅助键行与沉浸页同为暗底。 */}
    {control && remoteKeyboard && <View className="flex-row gap-1 bg-immersive-panel px-1 py-2">{HELPER_KEYS.map(({ name, label }) => <Button intent="soft" key={name} testID={`takeover-key-${name}`} accessibilityLabel={label} onPress={() => a.onKey(name)} className={`min-w-0 flex-1 px-0 ${SOLID}`}><Text className="text-immersive-foreground">{label}</Text></Button>)}<IconButton immersive icon={Keyboard} label={t('收起键盘')} testID="takeover-keyboard-hide" onPress={a.onKeyboardHide}/></View>}
    {control && r.keyboard === 0 && !landscape && <View testID="takeover-dock" className="min-h-16 flex-row items-center justify-around px-3">{dock(false)}</View>}
    {!control && <View className="gap-2 px-4 pb-4 pt-4"><View className="flex-row items-center justify-between"><Text variant="caption" className="text-muted-foreground">{t('显示调试信息')}</Text><Switch testID="viewer-debug" accessibilityLabel={t('显示调试信息')} checked={p.debug} onCheckedChange={a.onDebug}/></View><Button testID="viewer-takeover" accessibilityLabel={t(p.canHandback ? '继续操作浏览器' : '接管浏览器')} disabled={!p.canTakeover} onPress={a.onTakeover}><Text>{t(p.canHandback ? '继续操作' : '接管')}</Text></Button>{p.canHandback && <Button intent="soft" testID="viewer-handback" accessibilityLabel={t('交还浏览器')} disabled={busy || !p.canReturnControl} onPress={a.onHandback}><Text>{t('交还')}</Text></Button>}</View>}
    {(panel.kind === 'pages' || panel.kind === 'more') && control && <View className="absolute inset-0 justify-end"><Pressable accessibilityLabel={t('关闭弹层')} onPress={() => a.onPanel({ kind: 'stage' })} className="absolute inset-0 bg-immersive-scrim"/><View className="max-h-[82%] gap-4 rounded-t-lg bg-page-surface px-4 pb-5 pt-4" style={{ paddingBottom: Math.max(insets.bottom, 20) }}><View className="mx-auto h-1 w-9 rounded-full bg-muted-foreground"/>
      {panel.kind === 'pages' ? <><View className="flex-row items-center justify-between"><Text className="text-lg font-medium">{t('页面 · {count}', { count: format.format(pages.length) })}</Text><Text variant="caption" className="text-muted-foreground">{t('本环境页面 {used}/{limit}', { used: format.format(used), limit: format.format(limit) })}</Text></View><ScrollView style={{ flexGrow: 0 }}>{pages.map(item => <View key={item.id} className={`mb-1 flex-row items-center rounded-md ${item.id === r.pages.snapshot?.current ? 'bg-secondary' : 'bg-card'}`}><Button intent="quiet" testID={`takeover-page-${item.id}`} accessibilityLabel={t('切换{page}', { page: pageLabel(item) })} onPress={() => a.onSwitchPage(item.id)} className="h-auto min-w-0 flex-1 flex-col items-start px-4 py-3"><Text variant="body" numberOfLines={1}>{pageLabel(item)}</Text><Text variant="caption" numberOfLines={1} className="text-muted-foreground">{hostOf(item.url)}{item.id === r.pages.snapshot?.current ? ` · ${t('当前')}` : ''}</Text></Button><IconButton icon={X} label={t('关闭{page}', { page: pageLabel(item) })} testID={`takeover-close-page-${item.id}`} disabled={!p.canClosePage} onPress={() => a.onClosePage(item.id)}/></View>)}</ScrollView><Button intent="soft" testID="takeover-new-page" accessibilityLabel={t('新建页面')} disabled={!p.canCreatePage} onPress={a.onNewPage}><Text>{t('新建页面')}</Text></Button><Text variant="caption" className="text-center text-muted-foreground">{t(used >= limit ? '本环境页面总数已达上限，请先关闭页面' : '新页面需手动切换')}</Text></>
        : <ScrollView style={{ flexGrow: 0 }}><Text className="text-lg font-medium">{t('更多')}</Text>
          {/* browser.W2（待确认）：横屏没有地址栏，后退 / 刷新 / 页面放在更多顶部。 */}
          {landscape && <View testID="takeover-landscape-nav" className="flex-row justify-around py-3">
            <Button intent="quiet" testID="takeover-landscape-back" accessibilityLabel={t('后退')} disabled={!human || !selectedPage} onPress={() => { a.onSendBack(); a.onPanel({ kind: 'stage' }); }} className="h-auto min-w-16 flex-col gap-1 py-2"><Icon as={ChevronLeft} className="size-6"/><Text className="text-xs">{t('后退')}</Text></Button>
            <Button intent="quiet" testID="takeover-landscape-reload" accessibilityLabel={t('刷新')} disabled={!human || !selectedPage} onPress={() => { a.onReload(); a.onPanel({ kind: 'stage' }); }} className="h-auto min-w-16 flex-col gap-1 py-2"><Icon as={RotateCw} className="size-6"/><Text className="text-xs">{t('刷新')}</Text></Button>
            <Button intent="quiet" testID="takeover-landscape-pages" accessibilityLabel={t('页面，共 {count} 个', { count: pages.length })} onPress={() => a.onPanel({ kind: 'pages' })} className="h-auto min-w-16 flex-col gap-1 py-2"><Text className="rounded-[4px] border-[1.5px] border-foreground px-1.5 text-xs">{format.format(pages.length)}</Text><Text className="text-xs">{t('页面')}</Text></Button>
          </View>}
          <View className="flex-row items-center gap-3 py-3"><Icon as={Smartphone} className="size-5" style={{ transform: [{ rotate: p.landscapeEnabled ? '90deg' : '0deg' }] }}/><Text variant="body" className="flex-1">{t('横屏')}</Text><Switch testID="takeover-landscape" accessibilityLabel={t('横屏')} checked={p.landscapeEnabled} onCheckedChange={a.onLandscape}/></View><Text variant="caption" className="text-muted-foreground">{t('鼠标模式怎么操作')}</Text>{[['轻点', '在指针处左键单击；快速轻点两次可双击'], ['单指滑动', '移动指针'], ['左 / 右键', '点击左键或右键；按住左键并滑动另一指可拖动'], [landscape ? '左侧滚动条' : '右侧滚动条', '往下拖页面向下滚，松手回中'], ['双指', '缩放、平移画面；捏回即 1 倍']].map(([title, detail]) => <View key={title} className="flex-row border-t border-border/50 py-3"><Text variant="caption" className="w-24">{t(title)}</Text><Text variant="caption" className="min-w-0 flex-1 text-muted-foreground">{t(detail)}</Text></View>)}<Text variant="caption" className="text-muted-foreground">{t('触控模式：轻点 = 左键，长按 = 右键，单指拖动 = 平移画面，双指缩放。')}</Text><View className="flex-row items-center justify-between border-t border-border/50 py-3"><View className="flex-1"><Text variant="body">{t('显示调试信息')}</Text><Text variant="caption" className="text-muted-foreground">{t('开启后每 5 秒输出调试日志')}</Text></View><Switch testID="takeover-debug" accessibilityLabel={t('显示调试信息')} checked={p.debug} onCheckedChange={a.onDebug}/></View></ScrollView>}
    </View></View>}
    <AlertDialog open={panel.kind === 'close-page'} onOpenChange={open => { if (!open) a.onPanel({ kind: 'pages' }); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('这是最后一页')}</AlertDialogTitle><AlertDialogDescription>{t('关闭后页面会暂时为空。本环境有剩余额度时可新建页面。')}</AlertDialogDescription></AlertDialogHeader>{p.error && <Text variant="caption" className="text-destructive">{t(p.error)}</Text>}<AlertDialogFooter><AlertDialogCancel disabled={busy}><Text>{t('取消')}</Text></AlertDialogCancel><Button intent="destructive" disabled={!p.canClosePage} onPress={() => { if (panel.kind === 'close-page') a.onClosePage(panel.target); }} className="flex-1"><Text>{t('关闭')}</Text></Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </View>;
}

