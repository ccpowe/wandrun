/** Shared between the LegendList boundary in chat-timeline-contract and its assertions. */
export const listSignals: { setAtEnd(value: boolean): void }[] = [];
/** Calls the page made on the LegendList double (chat-send-pin): a count, not geometry. */
export const listCalls: { scrollToEnd: number; animated: (boolean | undefined)[] } = { scrollToEnd: 0, animated: [] };
