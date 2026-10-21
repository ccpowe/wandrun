import { Canvas, Image as SkiaImage, Path, type SkImage } from "@shopify/react-native-skia";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { useAnimatedReaction, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";

import type { Size, View as LocalView } from "../takeover-lab/geometry.ts";
import type { Frame } from "./protocol.ts";
import type { BrowserStream } from "./stream.ts";
import { useRuntimeCallback } from "./use-runtime-callback.ts";

/** The native clipping boundary encloses the transformed frame and untransformed overlays.
 * Keep it outside the zoomed View: clipping the Canvas itself would move the boundary
 * with the image, allowing high-zoom pixels to draw over the toolbar.
 */
export function FrameViewport({ size, view, frame, children, style, ...props }: ViewProps & {
  size: Size; view: LocalView; frame: ReactNode;
}) {
  return <View {...props} collapsable={false} style={[style, { overflow: "hidden" }]}>
    <View pointerEvents="none" style={{ width: size.w, height: size.h, transform: [
      { translateX: view.tx + (view.z - 1) * size.w / 2 },
      { translateY: view.ty + (view.z - 1) * size.h / 2 },
      { scale: view.z },
    ] }}>
      {frame}
    </View>
    {children}
  </View>;
}

export type FrameCandidate = { frame: Frame; image: SkImage; source: BrowserStream; connectionId: string };

/** One generation of a frame surface. React commits metadata/layout, but Skia children
 * retain their identity: only shared values replace the image and its fitted rectangle.
 * The initial image shared value also retains this generation's first image (one bounded
 * reference) until unmount. onDisplayed runs after submission's next UI callback; this
 * does not guarantee the first draw or GPU completion. The caller still owns transport/
 * generation validation; images remain GC-owned. Unmount clears the RN candidate as
 * well as cancelling the UI rAF, so queued RN callbacks cannot acknowledge this surface.
 */
export const FrameCanvas = memo(function FrameCanvas({ candidate, containerWidth, containerHeight, x, y, width, height, onDisplayed }: {
  candidate: FrameCandidate;
  containerWidth: number; containerHeight: number;
  x: number; y: number; width: number; height: number;
  onDisplayed(candidate: FrameCandidate): void;
}) {
  const image = useSharedValue(candidate.image);
  const imageX = useSharedValue(x);
  const imageY = useSharedValue(y);
  const imageWidth = useSharedValue(width);
  const imageHeight = useSharedValue(height);
  const submittedSeq = useSharedValue(-1);
  const ackHandle = useSharedValue(-1);
  const pending = useRef<FrameCandidate | null>(null);
  const source = candidate.source;
  const children = useMemo(() => <SkiaImage image={image} fit="fill" x={imageX} y={imageY} width={imageWidth} height={imageHeight} />,
    [image, imageX, imageY, imageWidth, imageHeight]);

  // Same children-identity boundary as Skia 2.6.2 Canvas.tsx, not shared-value draws.
  useLayoutEffect(() => {
    if (source.isOpen) source.measurements.canvasRendered("frame");
  }, [children, source]);
  useLayoutEffect(() => {
    pending.current = candidate;
    return () => { pending.current = null; };
  }, [candidate]);
  // UI retains only the stable RN entry; its latest callback is replaced after
  // each commit and cleared on unmount, never pinning an old image render.
  const confirm = useRuntimeCallback((seq: number) => {
    const next = pending.current;
    if (next?.frame.seq === seq) onDisplayed(next);
  });

  useAnimatedReaction(() => submittedSeq.value, (seq, previous) => {
    if (seq < 0 || seq === previous) return;
    if (ackHandle.value !== -1) cancelAnimationFrame(ackHandle.value);
    // Reanimated 4.5 native mappers run in the UI frame's finalizer phase. Scheduling
    // here (inside that pass), not immediately after a JS write, lets Skia applyUpdates
    // run before the next rAF can notify RN. Mapper order within the pass does not matter.
    ackHandle.value = requestAnimationFrame(() => {
      ackHandle.value = -1;
      scheduleOnRN(confirm, seq);
    });
  });
  useEffect(() => {
    const nextImage = candidate.image;
    const seq = candidate.frame.seq;
    // This per-frame UI worklet captures the image/scalars/shared values, but no RN
    // callback or candidate/stream.
    scheduleOnUI(() => {
      "worklet";
      image.value = nextImage;
      imageX.value = x; imageY.value = y;
      imageWidth.value = width; imageHeight.value = height;
      submittedSeq.value = seq;
    });
  }, [candidate, x, y, width, height, image, imageX, imageY, imageWidth, imageHeight, submittedSeq]);
  useEffect(() => () => {
    scheduleOnUI(() => {
      "worklet";
      if (ackHandle.value !== -1) cancelAnimationFrame(ackHandle.value);
      ackHandle.value = -1;
    });
  }, [ackHandle]);

  return <Canvas pointerEvents="none" style={{ width: containerWidth, height: containerHeight }}>{children}</Canvas>;
});

const ARROW = "M0 0 L0 17 L4.2 13 L7 19.5 L9.6 18.4 L6.9 12 L12.5 12 Z";

/** Position belongs to the outer native View; pointer movement never changes this tree. */
export const CursorCanvas = memo(function CursorCanvas({ source }: { source: BrowserStream }) {
  const children = useMemo(() => <><Path path={ARROW} color="#fff"/><Path path={ARROW} color="#000" style="stroke" strokeWidth={1.5}/></>, []);
  useLayoutEffect(() => {
    if (source.isOpen) source.measurements.canvasRendered("cursor");
  }, [children, source]);
  return <Canvas pointerEvents="none" style={{ width: 20, height: 28 }}>{children}</Canvas>;
});
