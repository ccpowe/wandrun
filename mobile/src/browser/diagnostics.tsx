import { useMemo, useState } from 'react';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { Text } from '../components/ui/text.tsx';
import { useTranslation } from '../lib/i18n.ts';
import { useMountEffect } from '../lib/use-mount-effect.ts';
import { sampleHermes } from './measurements.ts';
import type { BrowserRuntime, BrowserRuntimeSnapshot } from './runtime.ts';
import { useRuntimeCommit } from '../lib/use-runtime-commit.ts';

type UiSampleReceiver = (generation: number, log: boolean, ext: number | null, heap: number | null, gc: number | null) => void;
function sampleUiRuntime(receive: UiSampleReceiver, generation: number, log: boolean) {
  'worklet';
  const sample = sampleHermes();
  scheduleOnRN(receive, generation, log, sample.extBytes, sample.heapBytes, sample.gcCount);
}
class UiSampler {
  private generation = 0;
  private pending = false;
  private active = false;
  constructor(private runtime: BrowserRuntime) {}
  receive: UiSampleReceiver = (generation, log, uiExtBytes, uiHeapBytes, uiGcCount) => {
    if (!this.active || generation !== this.generation) return;
    this.pending = false;
    const client = this.runtime.stream;
    if (!client?.isOpen) return;
    const stats = { ...client.measurements.snapshot(performance.now()), ...sampleHermes(), uiExtBytes, uiHeapBytes, uiGcCount };
    this.runtime.setStats(stats);
    if (log) {
      const snapshot = this.runtime.getSnapshot().pages.snapshot;
      console.log('[stream-stats] ' + JSON.stringify({ lease: this.runtime.id, page: snapshot?.current ?? null,
        epoch: snapshot?.epoch ?? null, vp: snapshot?.vp ?? null, connection: 'open', ...stats }));
    }
  };
  start(receive: UiSampleReceiver) {
    this.active = true; this.pending = false;
    const generation = ++this.generation;
    let ticks = 0;
    const refresh = (log = false) => {
      if (this.pending || !this.runtime.stream?.isOpen) return;
      this.pending = true;
      scheduleOnUI(sampleUiRuntime, receive, generation, log);
    };
    refresh();
    const timer = setInterval(() => refresh(++ticks % 10 === 0), 500);
    return () => { this.active = false; ++this.generation; this.pending = false; clearInterval(timer); };
  }
}
/** Mounted only while debug + focused + foreground + open. */
export function BrowserDiagnosticsSubscription({ runtime }: { runtime: BrowserRuntime }) {
  const [sampler] = useState(() => new UiSampler(runtime));
  const receive = useRuntimeCommit(sampler.receive);
  useMountEffect(() => sampler.start(receive));
  return null;
}
export function BrowserDiagnostics({ snapshot: r }: { snapshot: BrowserRuntimeSnapshot }) {
  const { t, locale } = useTranslation();
  const formats = useMemo(() => [new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })], [locale]);
  const s = r.stats, frame = r.shown?.frame;
  const show = (value: number | null | undefined, digits = 0) => value == null ? t('未知') : formats[digits].format(value);
  const rows = [
    `${t('收/显')} ${show(s?.receiveFps, 1)}/${show(s?.displayFps, 1)} fps · ${t('二进制')} ${show(s?.binaryKbps, 1)} kbps · RTT ${show(s?.rttMs, 1)} ms`,
    `${t('JPEG 均/峰')} ${show(s?.jpegMeanKiB, 1)}/${show(s?.jpegMaxKiB, 1)} KiB · ${t('网丢')} ${show(s?.gatewayDropped)} ${t('本弃')} ${show(s?.localDiscarded)} · ACK ${show(s?.ackWaitMs, 1)} ms`,
    `${t('窗口')} ${s?.windowMode ?? t('未知')} ${show(s?.inFlight)}/${show(s?.maxInFlight)} (≤${show(s?.maxInFlightLimit)}) · ${t('帧龄')} ${show(s?.frameAgeMs, 1)} ms`,
    `${t('等额/发送锁')} ${show(s?.creditWaitMs, 1)}/${show(s?.sendLockMs, 1)} ms · ACK ${t('基线/平滑/排队')} ${show(s?.ackBaselineMs, 1)}/${show(s?.ackSmoothedMs, 1)}/${show(s?.queueDelayMs, 1)} ms`,
    `${t('输入等锁/派发/CDP 均')} ${show(s?.inputLockWaitMeanMs, 1)}/${show(s?.inputDispatchMeanMs, 1)}/${show(s?.inputCdpMeanMs, 1)} ms n${show(s?.inputDoneSamples)}`,
    `${t('触显')} P50/P90 ${show(s?.inputMedianMs)}/${show(s?.inputP90Ms)}ms ${t('近20')} n${show(s?.inputSamples)} ${t('待定')}${show(s?.pendingClicks)} · ${t('失败')}${show(r.decodeFailures)} · ${frame ? `#${frame.seq} e${frame.epoch}/v${frame.vp} ${frame.css.map(n => show(n)).join('×')} ${show(r.view.z, 1)}×` : t('无画面')} ${r.streamState}`,
    `${t('画质')} ${frame?.quality_tier ?? t('未知')} · ${frame?.quality_reason ?? t('未知')}`,
    `Ext JS/UI ${show(s?.extBytes == null ? null : s.extBytes / 1e6, 1)}/${show(s?.uiExtBytes == null ? null : s.uiExtBytes / 1e6, 1)} MB · ${t('重录 主/指')} ${show(s?.frameCanvasRenders)}/${show(s?.cursorCanvasRenders)}`,
  ];
  return <>{rows.map((row, index) => <Text key={index} numberOfLines={1} className="text-xs text-immersive-foreground">{row}</Text>)}</>;
}
