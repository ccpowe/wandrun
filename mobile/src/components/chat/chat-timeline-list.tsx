import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { type ComponentProps, useState } from "react";

import type { Item } from "@/lib/chat-timeline.ts";

type Props = ComponentProps<typeof KeyboardAwareLegendList<Item>>;

/**
 * ChatScreen mounts this boundary only after composer/target readiness. This
 * instance owns both initial props: freeze them together on mount, never rewrite
 * them for highlight, reading intent or prepend. Route changes and error/retry
 * remounts discard the snapshot with the list, not with a business cancellation.
 */
export function ChatTimelineList(props: Props) {
  const [initialPosition] = useState(() => ({
    initialScrollIndex: props.initialScrollIndex,
    initialScrollAtEnd: props.initialScrollAtEnd,
  }));
  return <KeyboardAwareLegendList {...props} {...initialPosition} />;
}
