import { useContext, useMemo, type ReactElement } from "react";
import { DrawerGestureContext } from "react-native-drawer-layout";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

/** Attach only to the actual native horizontal ScrollView (or FlatList), not a container:
 * its own interception decides when to activate, while an active scroll blocks drawer handoff. */
export function DrawerHorizontalGesture({ children }: { children: ReactElement }) {
  const drawerPan = useContext(DrawerGestureContext);
  const scroll = useMemo(() => {
    if (!drawerPan) return null;
    return Gesture.Native().shouldCancelWhenOutside(false).disallowInterruption(true).blocksExternalGesture(drawerPan);
  }, [drawerPan]);
  return scroll ? <GestureDetector gesture={scroll}>{children}</GestureDetector> : children;
}
