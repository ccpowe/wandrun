import { Skia } from "@shopify/react-native-skia";
import * as ScreenOrientation from "expo-screen-orientation";
import { useFocusEffect, router } from "expo-router";
import { ChevronLeft, Hand, Keyboard, LockKeyhole, MoreHorizontal, Mouse, MouseLeft, MousePointer2, MouseRight, RotateCw, Smartphone, X } from "lucide-react-native";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Alert, AppState, Keyboard as NativeKeyboard, Pressable, ScrollView, Switch, Text, TextInput, Vibration, View, useWindowDimensions } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { KeyboardEvents } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { useCSSVariable } from "uniwind";

import { Icon } from "../components/ui/icon.tsx";

import type { BrowserTask } from "../gateway/api.ts";
import { useSession } from "../lib/session-context.tsx";
import { useTranslation } from "../lib/i18n.ts";
import { agentDisplayName } from "../lib/agent-display-name.ts";
import { clampView, IDENTITY_VIEW, movePointer, pointerForViewport, type Point, type Size, toRemote, toRemoteClamped, toScreen, type View as LocalView, wheelAnchor, zoomPan } from "../takeover-lab/geometry.ts";
import { type Action, DEFAULT_OPTIONS, type TouchEvent, TouchModeRecognizer } from "../takeover-lab/gestures.ts";
import { COMMIT, InputBuffer, type InputOp } from "../takeover-lab/input-buffer.ts";
import { HELPER_KEYS, KEYS, type KeyName } from "../takeover-lab/keys.ts";
import { buttonLayout } from "../takeover-lab/layout.ts";
import { type MouseAction, MouseModeRecognizer, WHEEL_OPTIONS, WheelControl } from "../takeover-lab/mouse-gestures.ts";
import { activeNotice, applyPages, collapseNotices, currentPage, dismissNotice, EMPTY_PAGE_STATE, hostOf, initialPageSelection, isEmptyControlPages, observePageSelection, pageLabel, rejectPageRestoration, resumePageSelection, type PageState } from "./pages.ts";
import { sampleHermes, type StreamDiagnostics } from "./measurements.ts";
import { endedReason, rejectReason, type Frame, type Input, type Pages } from "./protocol.ts";
import { BrowserStream, type StreamState } from "./stream.ts";
import { feedbackPoint } from "./feedback.ts";
import { useRegionGesture } from "./use-region-gesture.ts";

import { CursorCanvas, FrameCanvas, FrameViewport, type FrameCandidate } from "./frame-canvas.tsx";
import { framePresentation } from "./frame-presentation.ts";
import { useRuntimeCallback } from "./use-runtime-callback.ts";

type Mode = "mouse" | "touch";
type Sheet = "pages" | "more" | null;

type UiSampleReceiver = (generation: number, log: boolean, ext: number | null, heap: number | null, gc: number | null) => void;

// Module worklet + stable RN entry: periodic diagnostics must not retain the
// render that started sampling, or create a fresh remote function every 500 ms.
function sampleUiRuntime(receive: UiSampleReceiver, generation: number, log: boolean) {
  "worklet";
  const sample = sampleHermes();
  scheduleOnRN(receive, generation, log, sample.extBytes, sample.heapBytes, sample.gcCount);
}

function IconButton({ icon, label, onPress, testID, disabled = false }: {
  icon: typeof X; label: string; onPress(): void; testID?: string; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} testID={testID} disabled={disabled} onPress={onPress} className="h-10 w-10 items-center justify-center rounded-xl disabled:opacity-40">
    <Icon as={icon} className="size-5 text-foreground" />
  </Pressable>;
}

function BrowserSwitch({ testID, label, value, onValueChange }: {
  testID: string; label: string; value: boolean; onValueChange(value: boolean): void;
}) {
  const [foreground, background, muted, mutedForeground] = useCSSVariable(["--color-foreground", "--color-background", "--color-muted", "--color-muted-foreground"]);
  return <Switch testID={testID} accessibilityLabel={label} value={value} onValueChange={onValueChange}
    trackColor={{ false: String(muted ?? "#F0F0ED"), true: String(foreground ?? "#141414") }}
    thumbColor={String(value ? background ?? "#FAFAFA" : mutedForeground ?? "#737373")} />;
}

/** A formal browser lease view; only the control variant sends input or changes pages. */
export function BrowserScreen({ id, page, control }: { id: string; page?: string; control: boolean }) {
  const { t, locale } = useTranslation();
  const session = useSession();
  const api = session?.api;
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const landscape = control && window.width > window.height;
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const [active, setActive] = useState(AppState.currentState !== "background" && AppState.currentState !== "inactive");
  const [task, setTask] = useState<BrowserTask | null>(null);
  const liveTask = session?.browserTasks.get(id);
  const [streamState, setStreamState] = useState<StreamState>("closed");
  const [reconnect, setReconnect] = useState(0);
  const [inputReady, setInputReady] = useState(false);
  const [pages, setPages] = useState<PageState>(EMPTY_PAGE_STATE);
  const pagesRef = useRef(EMPTY_PAGE_STATE);
  const [shown, setShown] = useState<FrameCandidate | null>(null);
  const shownRef = useRef<Frame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typingNotice, setTypingNotice] = useState<"pending" | "discarded" | null>(null);
  const [decodeFailures, setDecodeFailures] = useState(0);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [debug, setDebug] = useState(false);
  const [stats, setStats] = useState<StreamDiagnostics | null>(null);
  const uiSampling = useRef({ generation: 0, pending: false });
  const [mode, setModeState] = useState<Mode>("mouse");
  const modeRef = useRef<Mode>("mouse");
  const [view, setView] = useState<LocalView>(IDENTITY_VIEW);
  const viewRef = useRef<LocalView>(IDENTITY_VIEW);
  const [container, setContainer] = useState<Size>({ w: 0, h: 0 });
  const containerRef = useRef<Size>({ w: 0, h: 0 });
  const [pointer, setPointerState] = useState<Point | null>(null);
  const pointerRef = useRef<Point | null>(null);
  const lastTouch = useRef<Point | null>(null);
  const [feedback, setFeedback] = useState<Point | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [wheelOffset, setWheelOffset] = useState(0);
  const [pressed, setPressed] = useState({ left: false, right: false });
  const [keyboard, setKeyboard] = useState(0);
  const input = useRef<TextInput>(null);
  const urlInput = useRef<TextInput>(null);
  const [keyboardTarget, setKeyboardTarget] = useState<"url" | "remote" | null>(null);
  const urlEditing = keyboardTarget === "url";
  const remoteKeyboard = keyboardTarget === "remote" && keyboard > 0;
  const [url, setUrl] = useState("");
  const stream = useRef<BrowserStream | null>(null);
  const initialSelection = useMemo(() => initialPageSelection(page, api?.config.computerId), [page, api?.config.computerId]);
  const pageSelection = useRef(initialSelection);
  const restoreRequestId = useRef<number | null>(null);
  const mouse = useRef(new MouseModeRecognizer());
  const touch = useRef(new TouchModeRecognizer());
  const wheel = useRef(new WheelControl());
  const longPress = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wheelTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const buffer = useRef(new InputBuffer());
  const typingActive = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const takeoverId = useRef<string | null>(null);
  const handbackId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);

  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    setFocused(true);
    if (control) void ScreenOrientation.unlockAsync().catch((reason) => {
      console.warn("[browser-orientation] unlock failed", reason);
      setError("无法恢复自动旋转，请检查设备的屏幕方向设置");
    });
    return () => {
      focusedRef.current = false;
      setFocused(false);
      if (control) void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(console.warn);
    };
  }, [control]));
  useEffect(() => {
    if (!api || !id || !focused) return;
    let cancelled = false;
    void api.browserTask(id).then((next) => { if (!cancelled) setTask(next); }, (reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取浏览器任务");
    });
    return () => { cancelled = true; };
  }, [api, id, focused]);
  const lease = liveTask ?? task;
  const effectiveState = lease?.state === "released" || lease?.state === "revoking" || lease?.state === "stopping"
    ? lease.state : pages.snapshot?.state ?? lease?.state;
  const canHandback = effectiveState === "human" && !ended;
  const human = control && canHandback;
  const stopped = ended || effectiveState === "released";

  const updatePages = (change: (before: PageState) => PageState) => {
    pagesRef.current = change(pagesRef.current);
    setPages(pagesRef.current);
  };
  const setLocalView = useCallback((next: LocalView) => { viewRef.current = next; setView(next); }, []);
  const setPointer = useCallback((next: Point | null) => { pointerRef.current = next; setPointerState(next); }, []);
  const stopWheel = useCallback(() => { clearInterval(wheelTimer.current); wheelTimer.current = undefined; }, []);
  const stopGestures = useCallback(() => {
    clearTimeout(longPress.current);
    clearTimeout(feedbackTimer.current); setFeedback(null);
    longPress.current = undefined;
    stopWheel(); wheel.current = new WheelControl(); setWheelOffset(0);
    mouse.current = new MouseModeRecognizer(); touch.current = new TouchModeRecognizer();
    setPressed({ left: false, right: false });
  }, [stopWheel]);
  const clearTypingTimer = useCallback(() => { clearTimeout(settleTimer.current); settleTimer.current = undefined; }, []);
  const endTyping = useCallback((nativeInput: TextInput | null = input.current) => {
    // Invalidate before blur: native blur/hide callbacks must not flush old text into a new target.
    typingActive.current = false;
    clearTypingTimer();
    if (buffer.current.reset()) setTypingNotice("discarded");
    nativeInput?.clear(); nativeInput?.blur();
    setKeyboardTarget((before) => before === "remote" ? null : before);
  }, [clearTypingTimer]);
  const sendOp = (op: InputOp): boolean => {
    if (!typingActive.current) return false;
    const accepted = human && active && focused && stream.current?.input(
      op.kind === "text" ? { t: "text", text: op.text } : { t: "key", ...KEYS[op.key] },
    ) != null;
    if (!accepted) setTypingNotice(buffer.current.hasPending ? "pending" : "discarded");
    return accepted;
  };
  const flushTyping = (submit = false) => {
    clearTypingTimer();
    if (!typingActive.current) return true;
    const sent = submit ? buffer.current.enter(sendOp) : buffer.current.flush(sendOp);
    if (buffer.current.needsClear) { buffer.current.needsClear = false; input.current?.clear(); }
    if (sent) setTypingNotice((before) => before === "pending" ? null : before);
    return sent;
  };
  const onKeyboardHide = useEffectEvent(() => {
    setKeyboard(0);
    const sent = flushTyping();
    if (sent) endTyping();
    else input.current?.blur();
    urlInput.current?.blur(); setKeyboardTarget(null);
  });
  useEffect(() => {
    const subs = [
      AppState.addEventListener("change", (value) => {
        // Leaving the foreground ends both input sessions. Android may hide the IME
        // without completing its hide animation, so do not wait for keyboardDidHide.
        if (value !== "active") onKeyboardHide();
        setActive(value === "active");
      }),
      KeyboardEvents.addListener("keyboardWillShow", (event) => {
        if (AppState.currentState === "active") setKeyboard(event.height);
      }),
      KeyboardEvents.addListener("keyboardDidHide", () => onKeyboardHide()),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, []);

  // Keep event handlers current without tearing down the socket for every gesture or frame.
  const onPages = useEffectEvent((next: Pages) => {
    const previous = pagesRef.current.snapshot;
    updatePages((before) => applyPages(before, next, Date.now()));
    // Control prompts do not invalidate a picture or its pending display ACK.
    const identityChanged = previous?.current !== next.current || previous?.epoch !== next.epoch
      || previous?.vp !== next.vp;
    if (identityChanged || next.state !== "human" || next.pages.length === 0) endTyping();
    if (identityChanged) {
      shownRef.current = null; setShown(null); lastTouch.current = null; stopGestures(); setLocalView(IDENTITY_VIEW);
      setInputReady(false);
    }
    const restored = observePageSelection(pageSelection.current, next);
    pageSelection.current = restored.selection;
    if (!pageSelection.current.pending) restoreRequestId.current = null;
    if (restored.switchTo) {
      const requestId = stream.current?.switchPage(restored.switchTo);
      if (requestId == null) pageSelection.current = rejectPageRestoration(pageSelection.current, next.current);
      else restoreRequestId.current = requestId;
    }
    if (next.state !== "human" || next.pages.length === 0) stopGestures();
    if (next.state === "released") setEnded(true);
  });
  useEffect(() => {
    if (!api || !id || !focused || !active || stopped) return;
    const keyboardInput = input.current;
    const client = new BrowserStream(api, id, control, {
      state: (state) => {
        setStreamState(state);
        setStats(null);
        if (state === "connecting") {
          pageSelection.current = resumePageSelection(pageSelection.current, api.config.computerId ?? null);
          setInputReady(false);
          restoreRequestId.current = null;
          pagesRef.current = EMPTY_PAGE_STATE; setPages(EMPTY_PAGE_STATE);
          shownRef.current = null; setShown(null); lastTouch.current = null;
          stopGestures();
        }
        if (state === "closed") { shownRef.current = null; setShown(null); setInputReady(false); stopWheel(); }
      },
      frame: (packet) => {
        try {
          const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(packet.jpeg));
          if (!image) throw new Error("画面解码失败");
          setShown({ frame: packet.frame, image, source: client, connectionId });
          setDecodeFailed(false);
        } catch {
          client.discardFrame(packet.frame.seq);
          setDecodeFailures((count) => count + 1); setDecodeFailed(true);
        }
      },
      pages: (next) => onPages(next),
      reply: (result) => {
        if (result.t === "reject") {
          if (result.id === restoreRequestId.current && result.id !== null) {
            restoreRequestId.current = null;
            pageSelection.current = rejectPageRestoration(pageSelection.current, pagesRef.current.snapshot?.current ?? null);
          }
          console.warn("[browser-stream] rejected", { lease: id, id: result.id, reason: result.why });
          setError(rejectReason(result.why));
        } else if (result.t === "input_done" || result.t === "page_done") setError(null);
      },
      ended: (reason) => { setEnded(true); setError(endedReason(reason)); },
      error: setError,
    });
    const connectionId = client.measurements.connectionId;
    stream.current = client;
    return () => {
      client.close();
      if (stream.current === client) stream.current = null;
      shownRef.current = null; setShown(null);
      endTyping(keyboardInput);
      stopWheel(); mouse.current = new MouseModeRecognizer(); touch.current = new TouchModeRecognizer();
      clearTimeout(feedbackTimer.current); setFeedback(null);
    };
  }, [api, id, focused, active, control, stopped, stopGestures, stopWheel, reconnect, endTyping]);
  const onFrameDisplayed = useCallback(({ frame, source }: FrameCandidate) => {
    if (stream.current !== source || !source.displayedFrame(frame)) return;
    const previous = shownRef.current;
    shownRef.current = frame;
    setInputReady(true);
    const nextPointer = pointerForViewport(pointerRef.current, frame.css[0], frame.css[1]);
    if (nextPointer !== pointerRef.current) setPointer(nextPointer);
    if (previous && (previous.vp !== frame.vp || previous.page !== frame.page)) setLocalView(IDENTITY_VIEW);
  }, [setPointer, setLocalView]);
  useEffect(() => {
    if (!pages.notices.length) return;
    const timer = setInterval(() => updatePages((before) => ({ ...before, ...collapseNotices(before, Date.now()) })), 1000);
    return () => clearInterval(timer);
  }, [pages.notices.length]);
  const receiveUiSample = useRuntimeCallback<Parameters<UiSampleReceiver>>((generation, log, uiExtBytes, uiHeapBytes, uiGcCount) => {
    if (generation !== uiSampling.current.generation) return;
    uiSampling.current.pending = false;
    const client = stream.current;
    if (!debug || !client?.isOpen || !focusedRef.current || AppState.currentState !== "active") return;
    const measurements = {
      ...client.measurements.snapshot(performance.now()), ...sampleHermes(),
      uiExtBytes, uiHeapBytes, uiGcCount,
    };
    setStats(measurements);
    if (log) {
      const snapshot = pagesRef.current.snapshot;
      console.log("[stream-stats] " + JSON.stringify({
        lease: id, page: snapshot?.current ?? null, epoch: snapshot?.epoch ?? null,
        vp: snapshot?.vp ?? null, connection: "open", ...measurements,
      }));
    }
  });
  useEffect(() => {
    if (!debug || !focused || !active || streamState !== "open") return;
    const client = stream.current;
    if (!client) return;
    const sampling = uiSampling.current;
    const generation = ++sampling.generation;
    sampling.pending = false;
    const refresh = (log = false) => {
      if (sampling.pending || !client.isOpen) return;
      sampling.pending = true;
      // One outstanding sample; stale replies cannot settle a new sampling session.
      scheduleOnUI(sampleUiRuntime, receiveUiSample, generation, log);
    };
    refresh();
    let ticks = 0;
    const timer = setInterval(() => refresh(++ticks % 10 === 0), 500);
    return () => { ++sampling.generation; sampling.pending = false; clearInterval(timer); };
  }, [debug, focused, active, streamState, id, receiveUiSample]);
  useEffect(() => () => { clearTypingTimer(); stopWheel(); clearTimeout(longPress.current); clearTimeout(feedbackTimer.current); }, [clearTypingTimer, stopWheel]);

  const send = (message: Input) => human && shownRef.current ? stream.current?.input(message) : null;
  const apply = (action: Action | MouseAction) => {
    const frame = shownRef.current;
    const box = containerRef.current;
    if (!frame || !human || !box.w || !box.h) return;
    const size = { w: frame.css[0], h: frame.css[1] };
    const at = (): Point => {
      const point = pointerRef.current ?? { x: size.w / 2, y: size.h / 2 };
      if (!pointerRef.current) setPointer(point);
      return point;
    };
    if (action.kind === "pinch") setLocalView(zoomPan(viewRef.current, action.from, action.to, action.scale, box, size));
    else if (action.kind === "pan") setLocalView(zoomPan(viewRef.current, { x: 0, y: 0 }, { x: action.dx, y: action.dy }, 1, box, size));
    else if (action.kind === "move") {
      const next = movePointer(at(), action.dx, action.dy, box, size, viewRef.current);
      setPointer(next); send({ t: "move", ...next, buttons: action.dragging ? 1 : 0 });
    } else if (action.kind === "press" || action.kind === "release") {
      send({ t: action.kind === "press" ? "down" : "up", ...at(), button: action.button, count: action.count });
    } else if (action.kind === "click" && "count" in action) send({ t: "click", ...at(), button: action.button, count: action.count });
    else if (action.kind === "click") {
      const remote = toRemote(action, box, size, viewRef.current);
      if (remote) send({ t: "click", ...remote, button: action.button });
    }
  };
  const setMode = (next: Mode) => { if (next === modeRef.current) return; stopGestures(); modeRef.current = next; setModeState(next); };
  const markContact = (contact: Point, feedbackMode = modeRef.current) => {
    const frame = shownRef.current;
    if (!human || !active || !focused || !frame) return;
    const point = feedbackPoint(feedbackMode, contact, pointerRef.current, containerRef.current,
      { w: frame.css[0], h: frame.css[1] }, viewRef.current);
    if (!point) return;
    clearTimeout(feedbackTimer.current);
    setFeedback(point);
    // A brief local contact acknowledgement; no animation loop or remote-frame dependency.
    feedbackTimer.current = setTimeout(() => setFeedback(null), 280);
  };
  const touchEvent = ({ type, touches, t }: TouchEvent) => {
    if (!human && !control) {
      // Viewer zoom/pan uses exactly the same local touch recognizer; remote click outputs are ignored.
    } else if (!human) return;
    if (type === "start" && touches.length === 1) markContact(touches[0]);
    if (control && modeRef.current === "mouse") return mouse.current.handle({ type, touches, t }).forEach(apply);
    if (type === "start" && touches.length) {
      const frame = shownRef.current;
      if (control && frame) lastTouch.current = toRemoteClamped(touches[touches.length - 1], containerRef.current, { w: frame.css[0], h: frame.css[1] }, viewRef.current);
    }
    if (!(type === "move" || type === "start" && touches.length === 1)) { clearTimeout(longPress.current); longPress.current = undefined; }
    if (control && type === "start" && touches.length === 1) {
      longPress.current = setTimeout(() => {
        longPress.current = undefined;
        const actions = touch.current.tick();
        if (actions.length) Vibration.vibrate(15);
        actions.forEach(apply);
      }, DEFAULT_OPTIONS.longPressMs);
    }
    const actions = touch.current.handle({ type, touches, t });
    if (control) actions.forEach(apply);
    else actions.forEach((action) => {
      const frame = shownRef.current;
      if (!frame) return;
      const size = { w: frame.css[0], h: frame.css[1] };
      if (action.kind === "pinch") setLocalView(zoomPan(viewRef.current, action.from, action.to, action.scale, containerRef.current, size));
      if (action.kind === "pan") setLocalView(zoomPan(viewRef.current, { x: 0, y: 0 }, { x: action.dx, y: action.dy }, 1, containerRef.current, size));
    });
  };
  const wheelEvent = (event: TouchEvent) => {
    if (!human) return;
    wheel.current.handle(event);
    setWheelOffset(wheel.current.offset);
    if (wheel.current.active && !wheelTimer.current) wheelTimer.current = setInterval(() => {
      const dy = wheel.current.tick(Date.now());
      const frame = shownRef.current;
      if (dy && frame) send({ t: "wheel", ...wheelAnchor(modeRef.current, pointerRef.current, lastTouch.current, { w: frame.css[0], h: frame.css[1] }), dx: 0, dy });
    }, 16);
    else if (!wheel.current.active) stopWheel();
  };
  const buttonEvent = (button: "left" | "right", event: TouchEvent) => {
    if (!human) return;
    if (event.type === "start" && event.touches.length === 1) markContact(event.touches[0], "mouse");
    mouse.current.handleButton(button, event).forEach(apply);
    setPressed((before) => ({ ...before, [button]: event.touches.length > 0 }));
  };
  const surfaceGesture = useRegionGesture(touchEvent);
  const wheelGesture = useRegionGesture(wheelEvent);
  const leftGesture = useRegionGesture((event) => buttonEvent("left", event));
  const rightGesture = useRegionGesture((event) => buttonEvent("right", event));
  useMemo(() => {
    const regions = [surfaceGesture, wheelGesture, leftGesture, rightGesture];
    for (const gesture of regions) gesture.simultaneousWithExternalGesture(...regions.filter((other) => other !== gesture));
    return regions;
  }, [surfaceGesture, wheelGesture, leftGesture, rightGesture]);
  const commandId = () => `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const takeover = async () => {
    if (!api || busy || !lease || stopped) return;
    takeoverId.current ??= commandId(); setBusy(true);
    try {
      const result = await api.takeoverBrowser(id, takeoverId.current);
      setTask(result.browser_task); takeoverId.current = null;
      router.push({ pathname: "/browser-takeover", params: { id, ...(pages.snapshot?.current ? { page: pages.snapshot.current } : {}) } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法接管浏览器"); }
    finally { setBusy(false); }
  };
  const handback = async () => {
    if (!api || busy || !lease || !canHandback) return;
    flushTyping(); handbackId.current ??= commandId(); setBusy(true);
    try {
      const result = await api.handbackBrowser(id, handbackId.current);
      setTask(result.browser_task); handbackId.current = null;
      router.dismissTo({ pathname: "/c/[id]", params: { id: lease.root_id } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法交还浏览器"); }
    finally { setBusy(false); }
  };
  const closePage = (target: string) => {
    if (!api || !human) return;
    const execute = () => void api.closeBrowserPage(id, target).then(({ browser_task: next }) => { setTask(next); if (next.pages.length === 0) setSheet(null); if (next.state === "released") setEnded(true); }, (reason) => setError(reason instanceof Error ? reason.message : "关闭页面失败"));
    if (pages.snapshot?.pages.length === 1) Alert.alert(t("这是最后一页"), t("关闭后页面会暂时为空，可随时新建页面。"), [
      { text: t("取消"), style: "cancel" }, { text: t("关闭"), style: "destructive", onPress: execute },
    ]);
    else execute();
  };
  const navigate = () => {
    const address = url.trim();
    if (!/^https?:\/\//i.test(address)) return setError("网址无效，请输入 http 或 https 网址");
    send({ t: "navigate", url: address });
    urlInput.current?.blur(); setKeyboardTarget(null);
  };
  const openSheet = (next: Exclude<Sheet, null>) => {
    flushTyping();
    urlInput.current?.blur(); input.current?.blur(); setKeyboardTarget(null);
    NativeKeyboard.dismiss();
    setSheet(next);
  };
  const typed = (text: string) => {
    if (!human || !typingActive.current) return;
    if (!buffer.current.change(text)) return clearTypingTimer();
    clearTypingTimer();
    if (COMMIT.mode === "immediate") flushTyping();
    else settleTimer.current = setTimeout(flushTyping, COMMIT.settleMs);
  };
  const sendKey = (key: KeyName) => { if (flushTyping()) sendOp({ kind: "key", key }); };
  const selectedPage = pages.snapshot ? currentPage(pages) : lease?.pages.find((item) => item.id === page) ?? null;
  const pageCount = pages.snapshot?.pages.length ?? lease?.pages.length ?? 0;
  const currentNotice = activeNotice(pages);
  const noticePage = currentNotice?.page;
  const pageMax = lease?.max_pages ?? pages.snapshot?.max_pages ?? 0;
  const emptyControlPages = control && !stopped && streamState === "open" && isEmptyControlPages(pages);
  const stage = shown?.frame ?? null;
  const canvasConnection = shown?.connectionId;
  const presentation = stage && canvasConnection ? framePresentation(canvasConnection, stage, container) : null;
  const cursor = control && mode === "mouse" && pointer && stage ? toScreen(pointer, container, { w: stage.css[0], h: stage.css[1] }, view) : null;
  const buttonPositions = control && human ? buttonLayout(mode, container, keyboard > 0) : null;
  const status = t(stopped ? "已结束" : human ? "操作中" : effectiveState === "requested" ? "等你接管" : effectiveState === "human" ? "你接管中" : effectiveState === "revoking" || effectiveState === "stopping" ? "正在结束" : "Agent 操作中");
  const pagePadding = keyboard ? keyboard : landscape ? Math.max(insets.bottom, 8) : insets.bottom;

  const measured = debug && focused && active && streamState === "open" ? stats : null;
  const numberFormats = useMemo(() => [
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  ], [locale]);
  const show = (n: number | null | undefined, digits = 0) => n == null ? t("未知") : numberFormats[digits].format(n);
  const frameCanvas = shown && presentation ? <FrameCanvas key={presentation.key} candidate={shown}
    containerWidth={container.w} containerHeight={container.h}
    x={presentation.x} y={presentation.y} width={presentation.width} height={presentation.height}
    onDisplayed={onFrameDisplayed} /> : null;
  const cursorCanvas = cursor && shown ? <View pointerEvents="none" style={{ position: "absolute", left: cursor.x, top: cursor.y, width: 20, height: 28 }}>
    <CursorCanvas key={canvasConnection} source={shown.source} />
  </View> : null;
  return <View className="flex-1 bg-background" style={{ paddingTop: remoteKeyboard ? 0 : insets.top, paddingBottom: pagePadding, paddingLeft: landscape ? insets.left : 0, paddingRight: landscape ? insets.right : 0 }}>
    {!remoteKeyboard && (landscape && !urlEditing ? null : control ? <>
      <View className="flex-row items-center px-4 pb-1 pt-2">
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-2"><View className="h-2 w-2 rounded-full bg-destructive"/><Text className="text-base font-semibold text-foreground">{status}</Text></View>
          <Text numberOfLines={1} className="text-xs text-muted-foreground">{agentDisplayName(session?.agents, lease?.entry_agent_id, lease?.entry_agent_name)} · {lease?.conversation_title}</Text>
        </View>
        <Pressable testID="takeover-handback" accessibilityRole="button" accessibilityLabel={t("交还浏览器")} disabled={!human || busy} onPress={() => void handback()} className="rounded-full border border-foreground px-4 py-2 disabled:opacity-40"><Text className="text-sm font-semibold text-foreground">{t("交还")}</Text></Pressable>
      </View>
      <View className="flex-row items-center gap-1 px-2 pb-2 pt-1">
        <IconButton icon={ChevronLeft} label={t("后退")} onPress={() => send({ t: "back" })} disabled={!human || !selectedPage} />
        <IconButton icon={RotateCw} label={t("刷新")} onPress={() => send({ t: "reload" })} disabled={!human || !selectedPage} />
        {urlEditing ? <><TextInput ref={urlInput} testID="takeover-url" accessibilityLabel={t("网址")} autoFocus autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" submitBehavior="submit" value={url} onChangeText={setUrl} onSubmitEditing={navigate} onBlur={() => setKeyboardTarget(null)} className="h-10 min-w-0 flex-1 rounded-full bg-muted px-3 text-sm text-foreground" />
          <IconButton icon={X} label={t("取消编辑网址")} testID="takeover-url-cancel" onPress={() => { urlInput.current?.blur(); setKeyboardTarget(null); }} /></>
          : <Pressable testID="takeover-url" accessibilityRole="button" accessibilityLabel={t("编辑网址")} disabled={!human || !selectedPage} onPress={() => { flushTyping(); input.current?.blur(); setUrl(selectedPage?.url ?? ""); setKeyboardTarget("url"); }} className="h-10 min-w-0 flex-1 flex-row items-center gap-2 rounded-full bg-muted px-3"><LockKeyhole size={14} color="#858580"/><Text numberOfLines={1} className="flex-1 text-sm text-foreground">{selectedPage ? hostOf(selectedPage.url) : t("没有页面")}</Text></Pressable>}
        <Pressable testID="takeover-pages" accessibilityRole="button" accessibilityLabel={t("页面，共 {count} 个", { count: pageCount })} onPress={() => openSheet("pages")} className="h-10 w-10 items-center justify-center"><Text className="rounded-md border-2 border-foreground px-1.5 text-sm font-semibold text-foreground">{numberFormats[0].format(pageCount)}</Text></Pressable>
      </View>
    </> : <>
      <View className="h-14 flex-row items-center justify-between px-3">
        <IconButton icon={X} label={t("关闭观看")} testID="viewer-close" onPress={() => router.back()} />
        <View className="min-w-0 flex-1 items-center"><Text className="text-lg font-semibold text-foreground">{t("浏览器")}</Text><Text numberOfLines={1} className="text-xs text-muted-foreground">{agentDisplayName(session?.agents, lease?.entry_agent_id, lease?.entry_agent_name)} · {lease?.conversation_title}</Text></View>
        <View className="w-10" />
      </View>
      <View className="items-center pb-3 pt-1"><Text className="max-w-[95%] rounded-full bg-muted px-3 py-1.5 text-xs text-foreground">● {status} · {selectedPage ? hostOf(selectedPage.url) : t("没有页面")} · {t("共 {count} 个页面", { count: numberFormats[0].format(pageCount) })}</Text></View>
    </>)}
    <View className={landscape ? "flex-1 flex-row" : "flex-1"}>
      {landscape && keyboard === 0 && <View className="w-[76px] items-center gap-3 pt-3">
        <Pressable testID="takeover-handback" accessibilityRole="button" accessibilityLabel={t("交还浏览器")} onPress={() => void handback()} disabled={!human || busy} className="rounded-full border border-foreground px-3 py-2 disabled:opacity-40"><Text className="text-xs font-semibold text-foreground">{t("交还")}</Text></Pressable>
        <View className="flex-row items-center gap-1"><View className="h-2 w-2 rounded-full bg-destructive"/><Text className="text-xs font-semibold text-foreground">{status}</Text></View>
        <IconButton icon={ChevronLeft} label={t("后退")} testID="takeover-landscape-back" onPress={() => send({ t: "back" })} disabled={!human || !selectedPage} />
        <IconButton icon={RotateCw} label={t("刷新")} testID="takeover-landscape-reload" onPress={() => send({ t: "reload" })} disabled={!human || !selectedPage} />
        <Pressable testID="takeover-pages" accessibilityRole="button" accessibilityLabel={t("页面，共 {count} 个", { count: pageCount })} onPress={() => openSheet("pages")} className="h-12 w-12 items-center justify-center rounded-xl bg-muted"><Text className="text-foreground">▢ {numberFormats[0].format(pageCount)}</Text></Pressable>
      </View>}
      <FrameViewport size={container} view={view} frame={frameCanvas} className="flex-1 bg-[#111]" onLayout={(event) => {
        const next = { w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height };
        const old = containerRef.current;
        if (old.w !== next.w) setLocalView(IDENTITY_VIEW);
        else if (old.h !== next.h && shownRef.current) setLocalView(clampView(viewRef.current, next, { w: shownRef.current.css[0], h: shownRef.current.css[1] }));
        containerRef.current = next; setContainer(next);
      }}>
        {/* Sibling native handlers own pointers by their initial hit region, even during another region's hold. */}
        <GestureDetector gesture={surfaceGesture}>
        <View collapsable={false} className="absolute inset-0">
        {frameCanvas && <View pointerEvents="none" testID={control ? "takeover-frame" : "viewer-frame"} className="absolute left-0 top-0 h-px w-px" accessibilityLabel={t("浏览器画面已显示")} />}
        {cursorCanvas}
        {feedback && human && focused && active && shown && <View pointerEvents="none" testID="takeover-contact-feedback" style={{ position: "absolute", left: feedback.x - 15, top: feedback.y - 15, width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: "#fff", backgroundColor: "#60a5fa80" }} />}
        </View>
        </GestureDetector>
        {control && human && stage && <>
          {noticePage && keyboard === 0 && <View className="absolute left-2 right-[64px] top-2 flex-row items-center gap-2 rounded-2xl border border-border bg-background px-3 py-2">
            <View className="min-w-0 flex-1"><Text numberOfLines={1} className="text-sm font-semibold text-foreground">{t("新页面：{page}", { page: pageLabel(noticePage) })}{currentNotice?.more ? ` · ${t("还有 {count} 个", { count: currentNotice.more })}` : ""}</Text><Text numberOfLines={1} className="text-xs text-muted-foreground">{hostOf(noticePage.url)}</Text></View>
            <Pressable testID="takeover-new-page-switch" accessibilityRole="button" accessibilityLabel={t("切换新页面")} onPress={() => stream.current?.switchPage(noticePage.id)} className="rounded-full border border-foreground px-3 py-2"><Text className="text-xs font-semibold text-foreground">{t("切换")}</Text></Pressable>
            <IconButton icon={X} label={t("关闭提示")} testID="takeover-new-page-dismiss" onPress={() => updatePages((before) => ({ ...before, ...dismissNotice(before, noticePage.id) }))} />
          </View>}
          {keyboard === 0 && <GestureDetector gesture={wheelGesture}><View collapsable={false} accessibilityLabel={t("滚动条")} style={{ position: "absolute", right: 8, top: "50%", marginTop: -(WHEEL_OPTIONS.travel + 22), width: 52, height: 2 * (WHEEL_OPTIONS.travel + 22), borderRadius: 26, backgroundColor: "#14141499", borderWidth: 1, borderColor: "#ffffff38", alignItems: "center" }}>
            <View pointerEvents="none" style={{ width: 2, height: "80%", marginTop: "10%", backgroundColor: "#ffffff55" }} />
            <View pointerEvents="none" style={{ position: "absolute", top: WHEEL_OPTIONS.travel + wheelOffset, width: 44, height: 44, borderRadius: 22, borderWidth: 1.5, borderColor: "#fff", backgroundColor: "#1c1c1c", alignItems: "center", justifyContent: "center" }}><Mouse color="#fff" size={24}/></View>
          </View></GestureDetector>}
          {buttonPositions && keyboard === 0 && (["left", "right"] as const).map((button) => <GestureDetector key={button} gesture={button === "left" ? leftGesture : rightGesture}><View collapsable={false} accessibilityLabel={t(button === "left" ? "左键" : "右键")} style={{ position: "absolute", ...buttonPositions[button], borderRadius: 32, backgroundColor: pressed[button] ? "#444c" : "#14141499", borderColor: "#ffffff55", borderWidth: 1, alignItems: "center", justifyContent: "center" }}>
            {button === "left" ? <MouseLeft color="#fff" size={28} /> : <MouseRight color="#fff" size={28} />}
          </View></GestureDetector>)}
        </>}
        {emptyControlPages && <View className="absolute inset-0 items-center justify-center gap-3 bg-[#111]"><Text className="text-[17px] font-semibold text-white">{t("没有页面")}</Text><Text className="text-[13px] text-white/70">{t("页面都已关闭，操作不会发送")}</Text><Pressable testID="takeover-empty-new-page" accessibilityRole="button" accessibilityLabel={t("新建页面")} onPress={() => { stream.current?.newPage(); }} className="h-11 items-center justify-center rounded-full bg-white px-5"><Text className="text-sm font-semibold text-[#141414]">{t("新建页面")}</Text></Pressable></View>}
        {stopped && <View className="absolute inset-0 items-center justify-center bg-[#111]"><Text className="text-lg font-semibold text-white">{t("浏览器已结束")}</Text></View>}
        {!shown && !stopped && !emptyControlPages && <View className="absolute inset-0 items-center justify-center gap-3">
          <Text className="text-sm text-white/70">{t(decodeFailed ? "画面解码失败" : streamState === "closed" ? "画面连接已断开" : "正在连接画面…")}</Text>
          {streamState === "closed" && <Pressable testID="browser-reconnect" accessibilityRole="button" accessibilityLabel={t("重新连接")} onPress={() => { setDecodeFailed(false); setReconnect((value) => value + 1); }} className="min-h-11 items-center justify-center rounded-full bg-white px-5"><Text className="text-sm font-semibold text-[#141414]">{t("重新连接")}</Text></Pressable>}
        </View>}
        {debug && <View pointerEvents="none" className="absolute bottom-2 left-2 right-2 rounded-lg bg-black/70 p-2">
          <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: "white" }}>{t("收/显")} {show(measured?.receiveFps, 1)}/{show(measured?.displayFps, 1)} fps · {t("二进制")} {show(measured?.binaryKbps, 1)} kbps · RTT {show(measured?.rttMs, 1)} ms</Text>
          <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: "white" }}>{t("JPEG 均/峰")} {show(measured?.jpegMeanKiB, 1)}/{show(measured?.jpegMaxKiB, 1)} KiB · {t("网丢")} {show(measured?.gatewayDropped)} {t("本弃")} {show(measured?.localDiscarded)} · ACK {show(measured?.ackWaitMs, 1)} ms</Text>
          <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: "white" }}>{t("窗口")} {measured?.windowMode ?? t("未知")} {show(measured?.inFlight)}/{show(measured?.maxInFlight)} (≤{show(measured?.maxInFlightLimit)}) · {t("帧龄")} {show(measured?.frameAgeMs, 1)} ms</Text>
          <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: "white" }}>{t("等额/发送锁")} {show(measured?.creditWaitMs, 1)}/{show(measured?.sendLockMs, 1)} ms · ACK {t("基线/平滑/排队")} {show(measured?.ackBaselineMs, 1)}/{show(measured?.ackSmoothedMs, 1)}/{show(measured?.queueDelayMs, 1)} ms</Text>
          <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: "white" }}>{t("输入等锁/派发/CDP 均")} {show(measured?.inputLockWaitMeanMs, 1)}/{show(measured?.inputDispatchMeanMs, 1)}/{show(measured?.inputCdpMeanMs, 1)} ms n{show(measured?.inputDoneSamples)}</Text>
          <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: "white" }}>{t("触显")} P50/P90 {show(measured?.inputMedianMs)}/{show(measured?.inputP90Ms)}ms {t("近20")} n{show(measured?.inputSamples)} {t("待定")}{show(measured?.pendingClicks)} · {t("失败")}{numberFormats[0].format(decodeFailures)} · {stage ? `#${stage.seq} e${stage.epoch}/v${stage.vp} ${stage.css.map((n) => numberFormats[0].format(n)).join("×")} ${show(view.z, 1)}×` : t("无画面")} {streamState}</Text>
          <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: "white" }}>{t("画质")} {stage?.quality_tier ?? t("未知")} · {stage?.quality_reason ?? t("未知")}</Text>
          <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: "white" }}>Ext JS/UI {show(measured?.extBytes == null ? null : measured.extBytes / 1e6, 1)}/{show(measured?.uiExtBytes == null ? null : measured.uiExtBytes / 1e6, 1)} MB · {t("重录 主/指")} {show(measured?.frameCanvasRenders)}/{show(measured?.cursorCanvasRenders)}</Text>
        </View>}
      </FrameViewport>
      {landscape && keyboard === 0 && <View className="w-[88px] items-center justify-center gap-2">{renderDock()}</View>}
    </View>
    {error && <Pressable accessibilityRole="button" accessibilityLabel={t("关闭错误提示")} onPress={() => setError(null)} className="bg-destructive px-4 py-2"><Text className="text-sm text-white">{t(error)}</Text></Pressable>}
    {typingNotice && <View testID="browser-input-notice" className="gap-2 bg-destructive px-4 py-2">
      <Text accessibilityRole="alert" className="text-sm text-white">{t(typingNotice === "pending"
        ? "部分文字尚未发送，已保留；画面恢复后可重试发送"
        : "部分输入未发送且已丢弃，请检查页面后重新输入")}</Text>
      <View className="flex-row gap-4">
        {typingNotice === "pending" && <Pressable testID="browser-input-retry" accessibilityRole="button" accessibilityLabel={t("重试发送")} disabled={!inputReady || streamState !== "open" || !human} onPress={() => flushTyping()}><Text className="text-sm text-white">{t("重试发送")}</Text></Pressable>}
        <Pressable accessibilityRole="button" accessibilityLabel={t("关闭错误提示")} onPress={() => setTypingNotice(null)}><Text className="text-sm text-white">{t("关闭提示")}</Text></Pressable>
      </View>
    </View>}
    {decodeFailed && shown && <Text className="bg-destructive px-4 py-2 text-sm text-white">{t("最新画面解码失败，正在显示上一帧")}</Text>}
    {control && <TextInput ref={input} testID="takeover-input-text" accessibilityLabel={t("远端键盘输入")} style={{ position: "absolute", left: 0, bottom: 0, width: 1, height: 1, opacity: 0 }} onFocus={() => {
      if (!human || !active || !focused || !shownRef.current || !stream.current?.isOpen) { endTyping(); return; }
      if (!typingActive.current) input.current?.clear();
      typingActive.current = true; setKeyboardTarget("remote");
    }} onBlur={() => { flushTyping(); setKeyboardTarget((before) => before === "remote" ? null : before); }} onChangeText={typed} onKeyPress={(event) => { if (typingActive.current && event.nativeEvent.key === "Backspace") buffer.current.backspace(sendOp); }} onSubmitEditing={() => flushTyping(true)} submitBehavior="submit" autoCorrect={false} autoComplete="off" spellCheck={false} autoCapitalize="none" importantForAutofill="no" contextMenuHidden caretHidden returnKeyType="send" />}
    {control && remoteKeyboard && <View className="flex-row gap-1 bg-background px-1 py-2">{HELPER_KEYS.map(({ name, label }) => <Pressable key={name} testID={`takeover-key-${name}`} accessibilityRole="button" accessibilityLabel={label} onPress={() => sendKey(name)} className="h-11 flex-1 items-center justify-center rounded-xl bg-muted"><Text className="text-sm text-foreground">{label}</Text></Pressable>)}<Pressable testID="takeover-keyboard-hide" accessibilityRole="button" accessibilityLabel={t("收起键盘")} onPress={() => input.current?.blur()} className="h-11 flex-1 items-center justify-center rounded-xl bg-muted"><Icon as={Keyboard} className="size-5 text-foreground"/></Pressable></View>}
    {control && keyboard === 0 && !landscape && <View className="flex-row items-center justify-around px-3 pt-1" style={{ minHeight: 64 }}>{renderDock()}</View>}
    {!control && <View className="gap-2 px-4 pb-4 pt-4">
      <View className="flex-row items-center justify-between"><Text className="text-sm text-muted-foreground">{t("显示调试信息")}</Text><BrowserSwitch testID="viewer-debug" label={t("显示调试信息")} value={debug} onValueChange={setDebug} /></View>
      <Pressable testID="viewer-takeover" accessibilityRole="button" accessibilityLabel={t(canHandback ? "继续操作浏览器" : "接管浏览器")} disabled={busy || stopped || effectiveState !== "requested" && effectiveState !== "agent" && !canHandback} onPress={() => void takeover()} className="h-12 items-center justify-center rounded-full border-[1.5px] border-foreground disabled:opacity-40"><Text className="text-base font-semibold text-foreground">{t(canHandback ? "继续操作" : "接管")}</Text></Pressable>
      {canHandback && <Pressable testID="viewer-handback" accessibilityRole="button" accessibilityLabel={t("交还浏览器")} disabled={busy} onPress={() => void handback()} className="h-11 items-center justify-center rounded-full bg-muted disabled:opacity-40"><Text className="text-sm font-semibold text-foreground">{t("交还")}</Text></Pressable>}
    </View>}
    {sheet && control && <View className="absolute inset-0 justify-end"><Pressable accessibilityLabel={t("关闭弹层")} onPress={() => setSheet(null)} className="absolute inset-0 bg-black/50"/><View className="max-h-[82%] gap-3 rounded-t-[24px] bg-background px-4 pb-5 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 16) }}><View className="mx-auto h-1 w-9 rounded-full bg-muted-foreground"/>
      {sheet === "pages" ? <><View className="flex-row items-center justify-between"><Text className="text-lg font-semibold text-foreground">{t("页面 · {count}", { count: numberFormats[0].format(pageCount) })}</Text><Text className="text-xs text-muted-foreground">{t("最多 {count} 个", { count: numberFormats[0].format(pageMax) })}</Text></View><ScrollView style={{ flexGrow: 0 }}>
        {(pages.snapshot?.pages ?? lease?.pages ?? []).map((item) => <View key={item.id} className={`mb-1 flex-row items-center rounded-[14px] ${item.id === pages.snapshot?.current ? "border border-foreground" : ""}`}><Pressable testID={`takeover-page-${item.id}`} accessibilityRole="button" accessibilityLabel={t("切换{page}", { page: pageLabel(item) })} onPress={() => { stream.current?.switchPage(item.id); setSheet(null); }} className="min-w-0 flex-1 px-3 py-2"><Text numberOfLines={1} className="text-base font-semibold text-foreground">{pageLabel(item)}</Text><Text numberOfLines={1} className="text-xs text-muted-foreground">{hostOf(item.url)}{item.id === pages.snapshot?.current ? ` · ${t("当前")}` : ""}</Text></Pressable><IconButton icon={X} testID={`takeover-close-page-${item.id}`} label={t("关闭{page}", { page: pageLabel(item) })} onPress={() => closePage(item.id)} disabled={!human}/></View>)}
      </ScrollView><Pressable testID="takeover-new-page" accessibilityRole="button" accessibilityLabel={t("新建页面")} disabled={!human || streamState !== "open" || pages.snapshot?.state !== "human" || pageCount >= pageMax || stopped} onPress={() => { stream.current?.newPage(); setSheet(null); }} className="h-11 items-center justify-center rounded-full border border-foreground disabled:opacity-40"><Text className="text-sm font-semibold text-foreground">{t("新建页面")}</Text></Pressable><Text className="text-center text-xs text-muted-foreground">{t("新页面需手动切换")}</Text></>
        : <ScrollView style={{ flexGrow: 0 }}><Text className="text-lg font-semibold text-foreground">{t("更多")}</Text>
          <View className="flex-row items-center gap-3 py-3"><Icon as={Smartphone} className="size-5 text-foreground" style={{ transform: [{ rotate: landscape ? "90deg" : "0deg" }] }} /><Text className="flex-1 text-base text-foreground">{t("横屏")}</Text><BrowserSwitch testID="takeover-landscape" label={t("横屏")} value={landscape} onValueChange={() => void toggleLandscape()} /></View>
          <Text className="text-xs font-semibold text-muted-foreground">{t("鼠标模式怎么操作")}</Text>{[
          ["轻点", "在指针处左键单击；快速轻点两次可双击"], ["单指滑动", "移动指针"], ["左 / 右键", "点击左键或右键；按住左键并滑动另一指可拖动"], ["右侧滚动条", "往下拖页面向下滚，松手回中"], ["双指", "缩放、平移画面；捏回即 1 倍"],
        ].map(([title, detail]) => <View key={title} className="flex-row border-t border-border py-2"><Text className="w-24 text-sm font-semibold text-foreground">{t(title)}</Text><Text className="min-w-0 flex-1 text-sm text-muted-foreground">{t(detail)}</Text></View>)}<Text className="text-xs text-muted-foreground">{t("触控模式：轻点 = 左键，长按 = 右键，单指拖动 = 平移画面，双指缩放。")}</Text><View className="flex-row items-center justify-between border-t border-border py-3"><View className="flex-1"><Text className="text-base text-foreground">{t("显示调试信息")}</Text><Text className="text-xs text-muted-foreground">{t("开启后每 5 秒输出调试日志")}</Text></View><BrowserSwitch testID="takeover-debug" label={t("显示调试信息")} value={debug} onValueChange={setDebug} /></View>
        </ScrollView>}
    </View></View>}
  </View>;

  function renderDock() {
    return <>
      <Pressable testID="takeover-mode" accessibilityRole="button" accessibilityLabel={t("当前{mode}模式，点按切换", { mode: t(mode === "mouse" ? "鼠标" : "触控") })} disabled={emptyControlPages} onPress={() => setMode(mode === "mouse" ? "touch" : "mouse")} className="min-w-[70px] items-center justify-center gap-0.5 py-1 disabled:opacity-40"><Icon as={mode === "mouse" ? MousePointer2 : Hand} className="size-6 text-foreground"/><Text className="text-xs text-foreground">{t(mode === "mouse" ? "鼠标" : "触控")}</Text></Pressable>
      <Pressable testID="takeover-keyboard" accessibilityRole="button" accessibilityLabel={t("打开键盘")} disabled={!human || emptyControlPages || streamState !== "open" || !inputReady} onPress={() => input.current?.focus()} className="min-w-[70px] items-center justify-center gap-0.5 py-1 disabled:opacity-40"><Icon as={Keyboard} className="size-6 text-foreground"/><Text className="text-xs text-foreground">{t("键盘")}</Text></Pressable>
      <Pressable testID="takeover-more" accessibilityRole="button" accessibilityLabel={t("更多")} onPress={() => openSheet("more")} className="min-w-[70px] items-center justify-center gap-0.5 py-1"><Icon as={MoreHorizontal} className="size-6 text-foreground"/><Text className="text-xs text-foreground">{t("更多")}</Text></Pressable>
    </>;
  }
  async function toggleLandscape() {
    try {
      await ScreenOrientation.lockAsync(landscape ? ScreenOrientation.OrientationLock.PORTRAIT_UP : ScreenOrientation.OrientationLock.LANDSCAPE);
      setSheet(null);
    } catch (reason) {
      console.warn("[browser-orientation] lock failed", reason);
      setError("无法切换屏幕方向，请检查设备是否允许旋转后重试");
    }
  }
}
