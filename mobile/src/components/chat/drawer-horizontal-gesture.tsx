import { useContext, useMemo, type ReactElement } from "react";
import { DrawerGestureContext } from "react-native-drawer-layout";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { View } from "react-native";

function useDrawerNativeGesture(activateOnStart: boolean) {
  const drawerPan = useContext(DrawerGestureContext);
  return useMemo(() => drawerPan
    ? Gesture.Native().shouldActivateOnStart(activateOnStart).shouldCancelWhenOutside(false)
      .disallowInterruption(true).blocksExternalGesture(drawerPan)
    : null, [drawerPan, activateOnStart]);
}

/** Native scroll views choose when to intercept. Chart Pan takes precedence over
 * Tap, while the orthogonal direction remains with chat scrolling. */
export function DrawerHorizontalGesture({ children, onDrag, onTap, vertical = false }: {
  children: ReactElement; onDrag?: (x: number, y: number) => void; onTap?: (x: number, y: number) => void; vertical?: boolean;
}) {
  const native = useDrawerNativeGesture(false);
  const drawerPan = useContext(DrawerGestureContext);
  const pan = useMemo(() => {
    if (!onDrag) return null;
    const gesture = Gesture.Pan().withTestId('drawer-content-scrub').maxPointers(1).runOnJS(true)
      .onStart((event) => onDrag(event.x, event.y))
      .onUpdate((event) => onDrag(event.x, event.y));
    if (vertical) gesture.activeOffsetY([-8, 8]).failOffsetX([-8, 8]);
    else gesture.activeOffsetX([-8, 8]).failOffsetY([-8, 8]);
    if (drawerPan) gesture.blocksExternalGesture(drawerPan);
    if (!onTap) return gesture;
    const tap = Gesture.Tap().withTestId('drawer-content-tap').runOnJS(true)
      .onEnd((event, success) => { if (success) onTap(event.x, event.y); });
    if (drawerPan) tap.blocksExternalGesture(drawerPan);
    return Gesture.Exclusive(gesture, tap);
  }, [drawerPan, onDrag, onTap, vertical]);
  const gesture = pan ?? native;
  return gesture ? <GestureDetector gesture={gesture}>{children}</GestureDetector> : children;
}

/** Slider 5.x adds a flattenable layout View, so materialize its control-sized hit area.
 * Android starts tracking on touch-down instead of waiting for that layout View to intercept. */
export function DrawerNativeControlGesture({ children }: { children: ReactElement }) {
  const gesture = useDrawerNativeGesture(true);
  return gesture ? <GestureDetector gesture={gesture}><View collapsable={false}>{children}</View></GestureDetector> : children;
}
