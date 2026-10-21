import { useState } from "react";
import { Gesture, type GestureTouchEvent } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";

import type { TouchEvent } from "../takeover-lab/gestures.ts";
import { gestureTouches } from "./touches.ts";
import { useRuntimeCallback } from "./use-runtime-callback.ts";

/** Native per-region tracking, without Pan's activation slop or RN's first-finger target.
 * Manual state changes run on UI; the lifetime-stable RN entry reads the latest
 * committed handler. No per-render RN closure is serialized into these worklets.
 */
export function useRegionGesture(deliver: (event: TouchEvent) => void) {
  const receive = useRuntimeCallback((type: TouchEvent["type"], event?: GestureTouchEvent) => {
    deliver(event ? gestureTouches(type, event, performance.now())
      : { type: "cancel", touches: [], t: performance.now() });
  });
  const [gesture] = useState(() => Gesture.Manual().shouldCancelWhenOutside(false)
    .onTouchesDown((event, manager) => {
      "worklet";
      manager.activate();
      scheduleOnRN(receive, "start", event);
    })
    .onTouchesMove((event) => {
      "worklet";
      scheduleOnRN(receive, "move", event);
    })
    .onTouchesUp((event, manager) => {
      "worklet";
      scheduleOnRN(receive, "end", event);
      if (event.numberOfTouches === 0) manager.end();
    })
    .onTouchesCancelled((_event, manager) => {
      "worklet";
      manager.fail();
    })
    .onFinalize((_event, success) => {
      "worklet";
      if (!success) scheduleOnRN(receive, "cancel");
    }));
  return gesture;
}
