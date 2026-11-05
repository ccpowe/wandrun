import { Mouse, MouseLeft, MouseRight, X } from 'lucide-react-native';
import { useMemo, useState, type ReactNode } from 'react';
import { ScrollView, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { Button } from '../components/ui/button.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { Text } from '../components/ui/text.tsx';
import { useTranslation } from '../lib/i18n.ts';
import { buttonLayout, BUTTON_MARGIN, BUTTON_SIZE, CONTROL_COLUMN, controlColumnLayout, portraitPicture } from '../takeover-lab/layout.ts';
import { toRemote, toScreen, type Size } from '../takeover-lab/geometry.ts';
import type { TouchEvent } from '../takeover-lab/gestures.ts';
import { WHEEL_OPTIONS } from '../takeover-lab/mouse-gestures.ts';
import { CursorCanvas, FrameCanvas, FrameViewport, type FrameCandidate } from './frame-canvas.tsx';
import { framePresentation } from './frame-presentation.ts';
import { activeNotice, hostOf, pageLabel } from './pages.ts';
import { endedReason } from './protocol.ts';
import type { BrowserRuntimeSnapshot } from './runtime.ts';
import { useRegionGesture } from './use-region-gesture.ts';
import { BrowserVideoSurface, type BrowserVideoConnection } from './video-player.tsx';
import { BrowserVideoOverlay } from './video-ui.tsx';

/** Distances from the stage edges to the screen edges (portrait takeover centers the picture on the whole screen),
 * plus the landscape control column's handback and dock (browser.B6), which the view owns; `compact` dock shows icons only (browser.W7). */
export type StageChrome = { above: number; below: number; handback?: ReactNode; dock?(compact: boolean): ReactNode };
const WHEEL_HEIGHT = 2 * (WHEEL_OPTIONS.travel + 22);
/** Landscape B column widths: wheel column at the far left, control column at the right. */
export const LANDSCAPE_WHEEL_COLUMN = 76;
export const LANDSCAPE_CONTROL_COLUMN = 84;
const SOLID = 'bg-immersive-foreground/20';

/** No command or subscription ownership here. Existing recognizers/Skia surface remain unchanged. */
export function BrowserStage({ snapshot: r, chrome, control, landscape, human, stopped, empty, canCreate, debug, reason, diagnostics, videoPlayer, onRetryVideo, onLayout, onDisplayed, onTouch, onWheel, onButton, onSwitchPage, onDismissNotice, onNewPage, onReconnect }: {
  snapshot: BrowserRuntimeSnapshot; chrome: StageChrome; control: boolean; landscape: boolean; human: boolean; stopped: boolean; empty: boolean; canCreate: boolean; debug: boolean;
  reason?: string | null; diagnostics: ReactNode; onLayout(size: Size): void; onDisplayed(candidate: FrameCandidate): void;
  onTouch(event: TouchEvent, canTap?: boolean): void; onWheel(event: TouchEvent): void; onButton(button: 'left' | 'right', event: TouchEvent): void;
  onSwitchPage(id: string): void; onDismissNotice(id: string): void; onNewPage(): void; onReconnect(): void;
  videoPlayer: BrowserVideoConnection | null; onRetryVideo(): void;
}) {
  const { t } = useTranslation();
  const [area, setArea] = useState<Size>({ w: 0, h: 0 });
  const [columnHeight, setColumnHeight] = useState(0);
  const { fontScale } = useWindowDimensions();
  const portrait = control && !landscape;
  const css = r.pages.snapshot?.css ?? r.shown?.frame.css ?? [16, 9];
  const controlsHeight = portrait && r.keyboard === 0 ? Math.max(WHEEL_HEIGHT, BUTTON_SIZE) + BUTTON_MARGIN : 0;
  const columns = control && landscape && r.keyboard === 0;
  const { top: pictureTop, height: pictureHeight } = portraitPicture(area, chrome, (css[1] > 0 ? css[1] : 9) / (css[0] > 0 ? css[0] : 16), controlsHeight, r.keyboard > 0);
  const trackpad = portrait && r.mode === 'mouse';
  const surface = useRegionGesture(event => {
    if (!trackpad) return onTouch(event);
    const touches = event.touches.map(touch => ({ ...touch, y: touch.y - pictureTop }));
    const first = touches[0];
    onTouch({ ...event, touches }, !!first && first.y >= 0 && first.y <= pictureHeight &&
      toRemote(first, r.container, { w: css[0], h: css[1] }, r.view) !== null);
  }).withTestId('browser-surface'), wheel = useRegionGesture(onWheel).withTestId('browser-wheel');
  const left = useRegionGesture(event => onButton('left', event)).withTestId('browser-left');
  const right = useRegionGesture(event => onButton('right', event)).withTestId('browser-right');
  useMemo(() => {
    const regions = [surface, wheel, left, right];
    for (const gesture of regions) gesture.simultaneousWithExternalGesture(...regions.filter(other => other !== gesture));
    return regions;
  }, [surface, wheel, left, right]);
  const stage = r.video.picture ? r.pages.snapshot : r.shown?.frame;
  const presentation = r.shown ? framePresentation(r.shown.connectionId, r.shown.frame, r.container) : null;
  const canvas = r.shown && presentation ? <FrameCanvas key={presentation.key} candidate={r.shown} containerWidth={r.container.w} containerHeight={r.container.h} x={presentation.x} y={presentation.y} width={presentation.width} height={presentation.height} onDisplayed={onDisplayed}/> : null;
  const hasPicture = !!r.shown || !!r.video.picture;
  const video = r.video.source && videoPlayer ? <BrowserVideoSurface player={videoPlayer} width={r.container.w} height={r.container.h}/> : null;
  const frame = <>{video && <View style={{ position: 'absolute', width: r.container.w, height: r.container.h }}>{video}</View>}{canvas}</>;
  const cursor = control && r.mode === 'mouse' && r.pointer && stage ? toScreen(r.pointer, r.container, { w: stage.css[0], h: stage.css[1] }, r.view) : null;
  const live = control && human && !!stage && r.keyboard === 0;
  // Portrait: the pair is centered on the screen midline (browser.B8).
  const buttons = live && portrait ? buttonLayout(r.mode, { w: area.w, h: controlsHeight }) : null;
  const notice = activeNotice(r.pages), page = notice?.page;
  const capacity = r.pages.snapshot?.capacity;
  const wheelView = (style: ViewStyle) => <GestureDetector gesture={wheel}><View collapsable={false} accessibilityLabel={t('滚动条')} className={`items-center rounded-full ${SOLID}`} style={{ ...style, width: 52, height: WHEEL_HEIGHT }}><View pointerEvents="none" className="bg-immersive-foreground/25" style={{ width: 2, height: '76%', marginTop: '12%' }}/><View pointerEvents="none" className="items-center justify-center rounded-full bg-immersive-foreground/30" style={{ position: 'absolute', top: WHEEL_OPTIONS.travel + r.wheelOffset, width: 44, height: 44 }}><Icon as={Mouse} size={22} className="text-immersive-foreground"/></View></View></GestureDetector>;
  const buttonView = (button: 'left' | 'right', style: ViewStyle) => <GestureDetector key={button} gesture={button === 'left' ? left : right}><View collapsable={false} accessibilityLabel={t(button === 'left' ? '左键' : '右键')} className={`items-center justify-center rounded-full ${r.pressed[button] ? 'bg-immersive-foreground/40' : SOLID}`} style={style}><Icon as={button === 'left' ? MouseLeft : MouseRight} size={24} className="text-immersive-foreground"/></View></GestureDetector>;
  const band = live && <>
    {wheelView({ position: 'absolute', right: 24, bottom: BUTTON_MARGIN })}
    {buttons && (['left', 'right'] as const).map(button => buttonView(button, { position: 'absolute', ...buttons[button] }))}
  </>;
  const body = <View testID="browser-stage" className="flex-1 bg-immersive-panel" onLayout={event => setArea({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })}>
    {trackpad && <GestureDetector gesture={surface}><View testID="takeover-trackpad" collapsable={false} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}/></GestureDetector>}
    <FrameViewport testID="browser-picture" pointerEvents="box-none" size={r.container} view={r.view} frame={frame} className={portrait ? 'w-full' : 'flex-1'} style={portrait ? { position: 'absolute', top: pictureTop, height: pictureHeight } : undefined} onLayout={event => onLayout({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })}>
    {!trackpad && <GestureDetector gesture={surface}><View testID="browser-picture-gesture" collapsable={false} className="absolute inset-0"/></GestureDetector>}
    <View pointerEvents="none" className="absolute inset-0">
      {hasPicture && <View pointerEvents="none" testID={control ? 'takeover-frame' : 'viewer-frame'} className="absolute left-0 top-0 h-px w-px" accessibilityLabel={t('浏览器画面已显示')}/>}
      {cursor && <View pointerEvents="none" style={{ position: 'absolute', left: cursor.x, top: cursor.y, width: 20, height: 28 }}><CursorCanvas source={r.shown?.source}/></View>}
      {r.feedback && human && hasPicture && <View pointerEvents="none" testID="takeover-contact-feedback" className="rounded-full border-2 border-immersive-foreground bg-immersive-foreground/30" style={{ position: 'absolute', left: r.feedback.x - 15, top: r.feedback.y - 15, width: 30, height: 30 }}/>}
    </View>
    {control && human && stage && <>
      {page && r.keyboard === 0 && <View className="absolute left-2 right-16 top-2 flex-row items-center gap-2 rounded-lg bg-card px-3 py-2"><View className="min-w-0 flex-1"><Text numberOfLines={1} variant="caption">{t('新页面：{page}', { page: pageLabel(page) })}{notice?.more ? ` · ${t('还有 {count} 个', { count: notice.more })}` : ''}</Text><Text numberOfLines={1} className="text-xs text-muted-foreground">{hostOf(page.url)}</Text></View><Button intent="soft" testID="takeover-new-page-switch" accessibilityLabel={t('切换新页面')} onPress={() => onSwitchPage(page.id)}><Text>{t('切换')}</Text></Button><Button intent="quiet" size="icon" testID="takeover-new-page-dismiss" accessibilityLabel={t('关闭提示')} onPress={() => onDismissNotice(page.id)}><Icon as={X} className="size-5"/></Button></View>}
    </>}
    {!stopped && !empty && r.streamState === 'open' && (r.video.transport === 'video' || r.video.source) &&
      <BrowserVideoOverlay phase={r.video.phase} reason={r.video.reason} hasPicture={hasPicture}
        onRetry={onRetryVideo}/>}
    {empty && <View className="absolute inset-0 items-center justify-center gap-3 bg-immersive-panel"><Text className="text-lg font-medium text-immersive-foreground">{t('没有页面')}</Text><Text variant="caption" className="text-immersive-muted-foreground">{t('页面都已关闭，操作不会发送')}</Text><Button testID="takeover-empty-new-page" accessibilityLabel={t('新建页面')} disabled={!canCreate} onPress={onNewPage}><Text>{t('新建页面')}</Text></Button>{capacity && capacity.pages_used >= capacity.pages_limit && <Text variant="caption" className="text-immersive-muted-foreground">{t('本环境页面总数已达上限，请先关闭页面')}</Text>}</View>}
    {stopped && <View className="absolute inset-0 items-center justify-center bg-immersive-panel"><Text className="text-lg font-medium text-immersive-foreground">{reason ? endedReason(reason) : t('页面已结束，可让 Agent 重新打开')}</Text></View>}
    {!hasPicture && !stopped && !empty && r.streamState !== 'reconnecting' && r.streamState !== 'stopped' && (r.video.transport === 'jpeg' || r.streamState === 'closed') && <View className="absolute inset-0 items-center justify-center gap-3"><Text variant="caption" className="text-immersive-muted-foreground">{t(r.streamState === 'closed' ? '画面连接已断开，可重新连接或让 Agent 重新打开' : r.decodeFailed ? '画面解码失败' : '正在连接画面…')}</Text>{r.streamState === 'closed' && <Button intent="soft" testID="browser-reconnect" accessibilityLabel={t('重新连接')} onPress={onReconnect}><Text>{t('重新连接')}</Text></Button>}</View>}
    {debug && <View pointerEvents="none" className="absolute bottom-2 left-2 right-2 rounded-sm bg-immersive-scrim p-2">{diagnostics}</View>}
    </FrameViewport>
    {/* box-none: blank band space falls through to the trackpad below (browser.B9). */}
    {portrait && <View testID="takeover-button-area" pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: controlsHeight }}>{band}</View>}
  </View>;
  const column = controlColumnLayout(columnHeight, fontScale);
  // One element tree in both orientations: the side columns occupy fixed slots around `body`, so rotating or
  // opening the keyboard never remounts the picture (Skia canvas, video surface, gesture regions).
  // Landscape B (browser.B6): wheel alone at the far left; handback / left+right / dock gathered mid-column on its midline.
  return <View className={columns ? 'flex-1 flex-row' : 'flex-1'}>
    {columns && <View testID="takeover-wheel-column" collapsable={false} className="items-center justify-center" style={{ width: LANDSCAPE_WHEEL_COLUMN }}>{live && wheelView({})}</View>}
    {body}
    {columns && <View testID="takeover-control-column" collapsable={false} style={{ width: LANDSCAPE_CONTROL_COLUMN }} onLayout={event => setColumnHeight(event.nativeEvent.layout.height)}>
      {/* browser.W7（待确认）：放不下时先缩间距，再底栏只留图标，最后列内滚动。 */}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: column.padding, gap: column.gap }}>
        {chrome.handback}
        <View className="items-center" style={{ gap: CONTROL_COLUMN.pairGap }}>{live && r.mode === 'mouse' && (['left', 'right'] as const).map(button => buttonView(button, { width: BUTTON_SIZE, height: BUTTON_SIZE }))}</View>
        <View testID="takeover-control-dock" className="items-center">{chrome.dock?.(column.compact)}</View>
      </ScrollView>
    </View>}
  </View>;
}
