import { useState } from "react";
import { Gesture } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";

import type { TouchEvent } from "../takeover-lab/gestures.ts";
import { gestureTouches, type GestureTouchSnapshot } from "./touches.ts";
import { useRuntimeCommit } from "../lib/use-runtime-commit.ts";

/** Native per-region tracking, without Pan's activation slop or RN's first-finger target.
 * Manual state changes run on UI; the lifetime-stable RN entry reads the latest
 * committed handler. No per-render RN closure is serialized into these worklets.
 */
export function useRegionGesture(deliver: (event: TouchEvent) => void) {
  const receive = useRuntimeCommit((event: GestureTouchSnapshot) => {
    // All regions retain the same RN monotonic clock; native touch events have none.
    deliver({ ...event, t: performance.now() });
  });
  const [gesture] = useState(() => Gesture.Manual().shouldCancelWhenOutside(false)
    .onTouchesDown((event, manager) => {
      "worklet";
      const snapshot = gestureTouches("start", event);
      manager.activate();
      scheduleOnRN(receive, snapshot);
    })
    .onTouchesMove((event) => {
      "worklet";
      scheduleOnRN(receive, gestureTouches("move", event));
    })
    .onTouchesUp((event, manager) => {
      "worklet";
      scheduleOnRN(receive, gestureTouches("end", event));
      if (event.numberOfTouches === 0) manager.end();
    })
    .onTouchesCancelled((_event, manager) => {
      "worklet";
      manager.fail();
    })
    .onFinalize((_event, success) => {
      "worklet";
      if (!success) scheduleOnRN(receive, { type: "cancel", touches: [] });
    }));
  return gesture;
}
