import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the installed, patched native functions, not a reimplementation or
// source-text assertions. React/native rendering and completion observations are
// outside this function harness; geometry, state, cancellation, promises and the
// pending-adjust handler are the package's actual code in both distributions.
const names = new Set([
  "PlatformAdjustBreaksScroll", "EDGE_POSITION_EPSILON", "INITIAL_DRAW_DISTANCE",
  "HYSTERESIS_MULTIPLIER", "INITIAL_SCROLL_MIN_TARGET_OFFSET",
  "peek$", "set$", "getContentInsetEndAdjustmentEnd", "getContentInsetEnd", "getContentSize",
  "isRTLProps", "isHorizontalRTLProps", "isHorizontalRTL", "getHorizontalInsetEnd",
  "clampHorizontalOffset", "getHorizontalMaxOffset", "getDefaultHorizontalRTLScrollType", "toLogicalHorizontalOffset",
  "resetSharedEdgeGateIfOutsideHysteresis", "isOutsideThresholdHysteresis", "checkThreshold",
  "canDispatchReachedEdge", "markReachedEdge", "prepareReachedEdgeForNextUserScroll",
  "hasActiveInitialScroll", "checkAtBottom", "checkAtTop", "checkThresholds",
  "getRawContentLength", "getAlignItemsAtEndPadding", "clampScrollOffset",
  "getStartOffsetAdjustment", "calculateOffsetForIndex", "calculateOffsetWithOffsetPosition",
  "getScrollRequestTracker", "doMaintainScrollAtEnd", "finishMaintainScrollAtEnd", "interruptMaintainScrollAtEnd",
  "cancelScrollCompletionChecks", "settlePendingImperativeScroll", "cancelImperativeScroll",
  "syncInitialScrollOffset", "supersedeInitialScroll", "finishInitialScroll", "finishScrollTo",
  "clearPreservedInitialScrollTargetTimeout", "clearPreservedInitialScrollTarget", "setInitialRenderState", "setAdaptiveRender",
  "setInitialScrollSession", "hasInitialScrollSessionCompletion", "clearInitialScrollSession", "createInitialScrollSession",
  "ensureInitialScrollSessionCompletion", "initialScrollCompletion", "initialScrollWatchdog",
  "recalculateSettledScroll", "ScheduledWork", "ScrollAdjustHandler",
]);

function installedNative(bundle: string, platform: "android" | "ios" = "android") {
  const source = readFileSync(new URL(`../node_modules/@legendapp/list/${bundle}`, import.meta.url), "utf8");
  const tree = ts.createSourceFile(bundle, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = new Map<string, string>();
  let drag: string | undefined;
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement.getText(tree));
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, `var ${declaration.getText(tree)};`);
    }
  }
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "onScrollBeginDrag" && ts.isArrowFunction(node.initializer)) {
      assert.equal(drag, undefined, "native drag handler must be unambiguous");
      drag = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(drag, "native drag handler exists");
  const executable = [...names].map((name) => {
    assert.ok(declarations.has(name), `installed bundle declares ${name}`);
    return declarations.get(name);
  }).join("\n");
  let nextJob = 0;
  const jobs = new Map<number, () => void>();
  const schedule = (callback: () => void) => { const id = ++nextJob; jobs.set(id, callback); return id; };
  // The VM returns our explicit function table from the locked installed bundle.
  const api: NativeApi = runInNewContext(`${executable}\n({
    ${[...names].join(",")},
    drag(ctx, event) { const state = ctx.state; (${drag})(event); }
  })`, {
    Platform: { OS: platform }, ReactNative: { I18nManager: { isRTL: false } },
    requestAnimationFrame: schedule, cancelAnimationFrame: (id: number) => jobs.delete(id),
    setTimeout: schedule, clearTimeout: (id: number) => jobs.delete(id), queueMicrotask,
    // No native layout tree or animated offset observer in this unit harness.
    calculateItemsInView() {}, checkFinishedScroll() {},
  });
  return { api, jobs, flush() {
    for (let passes = 0; jobs.size; passes++) {
      assert.ok(passes < 20, "scheduled work settles");
      const batch = [...jobs.values()]; jobs.clear();
      for (const callback of batch) callback();
    }
  } };
}

type ScrollTarget = {
  index?: number; offset?: number; viewPosition?: number; animated?: boolean;
  isInitialScroll?: boolean; isScrollToEnd?: boolean; waitForInitialScrollCompletionFrame?: boolean;
};
type AdjustHandler = {
  pendingAdjust: number; appliedAdjust: number; requestAdjust(add: number): void;
};
type ScheduledWork = {
  frame(callback: () => void, key: string): void;
};
type Inset = { left?: number; right?: number; bottom?: number };
type DragEvent = {
  nativeEvent: { contentOffset: { x: number; y: number }; contentSize: { width: number; height: number } };
};
type Context = {
  state: {
    props: {
      data: number[]; maintainScrollAtEnd: { animated: boolean }; maintainScrollAtEndThreshold: number;
      onEndReachedThreshold: number; onStartReachedThreshold: number; drawDistance: number;
      horizontal?: boolean; rtl?: boolean; contentInset?: Inset; contentInsetEndAdjustment?: number;
      stylePaddingBottom?: number; anchoredEndSpace?: boolean; onReady?: () => void;
    };
    scroll: number; scrollPending: number; scrollPrev: number; scrollLength: number; totalSize: number;
    pendingTotalSize?: number; contentInsetOverride?: Inset; edgeReachedGate?: string;
    queuedInitialLayout: boolean; didContainersLayout: boolean; didFinishInitialScroll: boolean;
    lastLayout: { width: number; height: number }; refScroller: { current: object };
    scrollHistory: number[]; positions: number[]; scheduledWork: ScheduledWork; scrollAdjustHandler: AdjustHandler;
    scrollingTo?: ScrollTarget; initialScroll?: ScrollTarget;
    initialScrollSession?: {
      kind: string; completion?: { didDispatchNativeScroll?: boolean }; bootstrap?: { frameHandle: number };
    };
    pendingScrollResolve?: () => void; maintainingScrollAtEnd?: string; pendingMaintainScrollAtEnd?: boolean;
  };
  values: Map<string, unknown>;
  listeners: Map<string, Set<(value: unknown) => void>>;
  scrollAxisGap: number;
  scrollToEnd: () => boolean;
};
type NativeApi = {
  ScheduledWork: new () => ScheduledWork;
  ScrollAdjustHandler: new (ctx: Context) => AdjustHandler;
  getContentSize(ctx: Context): number;
  clampScrollOffset(ctx: Context, offset: number): number;
  checkAtBottom(ctx: Context): void;
  doMaintainScrollAtEnd(ctx: Context): boolean;
  setInitialRenderState(ctx: Context, options: { didLayout: boolean }): void;
  finishScrollTo(ctx: Context): void;
  drag(ctx: Context, event: DragEvent): void;
};
function context(api: NativeApi): Context {
  let handler: AdjustHandler;
  const ctx: Context = {
    state: {
      props: {
        data: Array.from({ length: 10 }, (_, index) => index),
        maintainScrollAtEnd: { animated: false }, maintainScrollAtEndThreshold: 0.1,
        onEndReachedThreshold: 0.1, onStartReachedThreshold: 0.1, drawDistance: 0,
      },
      scroll: 0, scrollPending: 0, scrollPrev: 0, scrollLength: 600, totalSize: 3000,
      queuedInitialLayout: true, didContainersLayout: true, didFinishInitialScroll: true,
      lastLayout: { width: 600, height: 600 }, refScroller: { current: {} }, scrollHistory: [],
      positions: [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700],
      scheduledWork: new api.ScheduledWork(),
      get scrollAdjustHandler() { return handler; },
    },
    values: new Map<string, unknown>([["readyToRender", true], ["alignItemsAtEndPadding", 0], ["scrollAdjustPending", 0], ["scrollAdjust", 0]]),
    listeners: new Map(), scrollAxisGap: 0, scrollToEnd: () => true,
  };
  handler = new api.ScrollAdjustHandler(ctx);
  return ctx;
}
const dragEvent = (offset: number) => ({ nativeEvent: { contentOffset: { x: offset, y: offset }, contentSize: { width: 3000, height: 3000 } } });

for (const bundle of ["react-native.js", "react-native.mjs"]) {
  test(`${bundle}: effective end counts all padding and the combined inset exactly once`, () => {
    const { api } = installedNative(bundle);
    const ctx = context(api);
    ctx.scrollAxisGap = 12;
    ctx.values.set("stylePaddingTop", 12);
    ctx.values.set("headerSize", 20);
    ctx.values.set("footerSize", 30);
    ctx.state.props.stylePaddingBottom = 12;
    ctx.state.contentInsetOverride = { bottom: 150 };
    // 3000 total includes the final 12 gap; header/footer/style + native inset.
    assert.equal(api.getContentSize(ctx), 3212);
    assert.equal(api.clampScrollOffset(ctx, Infinity), 2612);
    for (const [gap, atEnd, within] of [[0, true, true], [1, true, true], [2, false, true], [60, false, true], [61, false, false], [100, false, false]] as const) {
      ctx.state.scroll = 2612 - gap;
      api.checkAtBottom(ctx);
      assert.equal(ctx.values.get("isAtEnd"), atEnd, `gap ${gap}: end`);
      assert.equal(ctx.values.get("isWithinMaintainScrollAtEndThreshold"), within, `gap ${gap}: maintenance`);
    }
    ctx.state.scroll = 2612;
    ctx.state.pendingTotalSize = 3080;
    api.checkAtBottom(ctx);
    assert.equal(ctx.values.get("isAtEnd"), false, "pending measured growth uses the same end");
  });

  test(`${bundle}: leaving the composer-adjusted end prevents later maintenance and releases the edge gate`, async () => {
    const { api, flush } = installedNative(bundle);
    const ctx = context(api);
    ctx.state.contentInsetOverride = { bottom: 150 };
    ctx.state.scroll = 2450; // effective end 2550, not the row-only end 2400
    ctx.state.edgeReachedGate = "closed";
    let scrolls = 0;
    ctx.scrollToEnd = () => { scrolls++; return true; };
    api.checkAtBottom(ctx);
    assert.equal(ctx.values.get("isAtEnd"), false);
    assert.equal(ctx.state.edgeReachedGate, undefined, "100 exceeds the 78dp end hysteresis");
    ctx.state.totalSize += 80;
    api.doMaintainScrollAtEnd(ctx);
    flush(); await Promise.resolve();
    assert.equal(scrolls, 0, "READ must not be pulled to the growing end");
    ctx.state.scroll = 2630;
    api.checkAtBottom(ctx);
    api.doMaintainScrollAtEnd(ctx);
    flush(); await Promise.resolve();
    assert.equal(scrolls, 1, "actual end still follows");
  });

  test(`${bundle}: empty, short, horizontal and overridden insets share the clamp's end`, () => {
    const { api } = installedNative(bundle);
    const ctx = context(api);
    for (const data of [[], [1]]) {
      ctx.state.props.data = data;
      ctx.state.totalSize = 100;
      ctx.state.contentInsetOverride = { bottom: 150 };
      api.checkAtBottom(ctx);
      assert.equal(ctx.values.get("isAtEnd"), true);
      assert.equal(api.clampScrollOffset(ctx, Infinity), 0);
    }
    ctx.state.props.horizontal = true;
    ctx.state.props.rtl = true;
    ctx.state.props.contentInset = { left: 10, right: 5 };
    ctx.state.contentInsetOverride = { left: 100 };
    ctx.state.props.contentInsetEndAdjustment = 50;
    ctx.state.props.anchoredEndSpace = true;
    ctx.values.set("anchoredEndSpaceSize", 200);
    ctx.state.totalSize = 3000;
    assert.equal(api.getContentSize(ctx), 3200, "anchor max, not a second additive inset");
    ctx.state.scroll = 2500;
    api.checkAtBottom(ctx);
    assert.equal(ctx.values.get("isAtEnd"), false);
    assert.equal(ctx.values.get("isWithinMaintainScrollAtEndThreshold"), false);
    ctx.state.scroll = api.clampScrollOffset(ctx, Infinity);
    api.checkAtBottom(ctx);
    assert.equal(ctx.values.get("isAtEnd"), true);
  });

  for (const kind of ["offset", "bootstrap", "preserved-end"]) {
    test(`${bundle}: drag supersedes ${kind} initialization and keeps the observed user position`, () => {
      const { api, flush, jobs } = installedNative(bundle);
      const ctx = context(api);
      const state = ctx.state;
      let ready = 0, settled = 0, cancelledBootstrap = 0, unexpectedCompletion = 0;
      state.props.onReady = () => ready++;
      state.didFinishInitialScroll = false;
      ctx.values.set("readyToRender", false);
      state.scroll = state.scrollPending = 1800;
      state.initialScroll = kind === "preserved-end" ? { index: 9, viewPosition: 1 } : { offset: 1800 };
      state.initialScrollSession = { kind: kind === "bootstrap" ? "bootstrap" : "offset", completion: { didDispatchNativeScroll: true } };
      if (kind === "bootstrap") {
        jobs.set(999, () => cancelledBootstrap++);
        state.initialScrollSession.bootstrap = { frameHandle: 999 };
      } else state.scrollingTo = { ...state.initialScroll, isInitialScroll: true, waitForInitialScrollCompletionFrame: true };
      state.pendingScrollResolve = () => settled++;
      for (const key of ["checkFinishedScrollFrame", "checkFinishedScrollRetryFrame", "checkFinishedScrollFallback", "platformScrollCompletion", "imperativeScrollReady"]) {
        state.scheduledWork.frame(() => unexpectedCompletion++, key);
      }
      api.drag(ctx, dragEvent(350));
      assert.equal(state.initialScroll, undefined);
      assert.equal(state.initialScrollSession, undefined);
      assert.equal(state.scrollingTo, undefined);
      assert.equal(state.didFinishInitialScroll, true);
      assert.equal(ctx.values.get("readyToRender"), true);
      assert.equal(state.scroll, 350);
      assert.equal(state.scrollPending, 350);
      assert.equal(ready, 1);
      assert.equal(settled, 1);
      api.drag(ctx, dragEvent(350));
      flush();
      assert.equal(ready, 1, "onReady is not repeated by another drag");
      assert.equal(settled, 1, "public promise settles exactly once");
      assert.equal(unexpectedCompletion, 0);
      assert.equal(cancelledBootstrap, 0);
      assert.equal(state.scroll, 350, "no delayed old-target replay");
    });
  }

  test(`${bundle}: drag before layout finishes does not announce readiness prematurely`, () => {
    const { api } = installedNative(bundle);
    const ctx = context(api);
    ctx.state.didContainersLayout = ctx.state.didFinishInitialScroll = false;
    ctx.values.set("readyToRender", false);
    ctx.state.initialScroll = { offset: 1800 };
    let ready = 0;
    ctx.state.props.onReady = () => ready++;
    api.drag(ctx, dragEvent(200));
    assert.equal(ctx.state.didFinishInitialScroll, true);
    assert.equal(ctx.values.get("readyToRender"), false);
    assert.equal(ready, 0);
    api.setInitialRenderState(ctx, { didLayout: true });
    assert.equal(ctx.values.get("readyToRender"), true);
    assert.equal(ready, 1);
  });

  for (const maintaining of [false, true]) {
    test(`${bundle}: Android drag settles pending MVCP at the user position (${maintaining ? "maintenance" : "public index"})`, () => {
      const { api, flush } = installedNative(bundle);
      const ctx = context(api);
      const state = ctx.state;
      state.scroll = 900; // deliberately older than the begin-drag event
      state.scrollingTo = { index: 7, offset: 2100, animated: true, isScrollToEnd: maintaining };
      if (maintaining) { state.maintainingScrollAtEnd = "animated"; state.pendingMaintainScrollAtEnd = true; }
      let settled = 0;
      state.pendingScrollResolve = () => settled++;
      state.scrollAdjustHandler.requestAdjust(120);
      assert.equal(state.scrollAdjustHandler.pendingAdjust, 120);
      api.drag(ctx, dragEvent(400));
      assert.equal(state.scrollingTo, undefined);
      assert.equal(state.scrollAdjustHandler.pendingAdjust, 0);
      assert.equal(ctx.values.get("scrollAdjustPending"), 0);
      assert.equal(state.scroll, 520, "preserve the user's anchor plus 120 moved content, not index 7");
      assert.equal(state.scrollAdjustHandler.appliedAdjust, 120);
      state.scrollAdjustHandler.requestAdjust(30);
      assert.equal(state.scrollAdjustHandler.appliedAdjust, 150);
      assert.equal(state.scrollAdjustHandler.pendingAdjust, 0);
      assert.equal(settled, 1);
      flush();
      assert.ok(!state.pendingMaintainScrollAtEnd);
      assert.equal(state.scroll, 520, "old maintenance cannot resume after drag");
    });
  }

  test(`${bundle}: ordinary completion still commits against its index, unlike cancellation`, () => {
    const { api } = installedNative(bundle);
    const ctx = context(api);
    ctx.state.scroll = 400;
    ctx.state.scrollingTo = { index: 7, offset: 2100, animated: true };
    ctx.state.scrollAdjustHandler.requestAdjust(120);
    api.finishScrollTo(ctx);
    assert.equal(ctx.state.scroll, 2100);
    assert.equal(ctx.state.scrollAdjustHandler.appliedAdjust, 1700);
    assert.equal(ctx.state.scrollAdjustHandler.pendingAdjust, 0);
  });

  test(`${bundle}: iOS does not apply an already committed adjustment twice on drag`, () => {
    const { api } = installedNative(bundle, "ios");
    const ctx = context(api);
    ctx.state.scrollingTo = { index: 7, offset: 2100, animated: true };
    ctx.state.scrollAdjustHandler.requestAdjust(120);
    assert.equal(ctx.state.scrollAdjustHandler.appliedAdjust, 120);
    api.drag(ctx, dragEvent(400));
    assert.equal(ctx.state.scroll, 400);
    assert.equal(ctx.state.scrollAdjustHandler.appliedAdjust, 120);
    assert.equal(ctx.state.scrollAdjustHandler.pendingAdjust, 0);
  });
}
