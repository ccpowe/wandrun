import type { ViewStyle } from "react-native";

/** Only the floating “return to latest” button keeps this elevation (design.md §3.3); header and composer have none. */
export const CHAT_FLOATING_SURFACE = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 10,
  elevation: 2,
} satisfies ViewStyle;

export const CHAT_LAYOUT = {
  /** ScreenBar row height below the status bar; overlays and the top fade start from here. */
  headerHeight: 52,
  /** Notices hang just below the header row. */
  bannerTop: 56,
  contentInsetHorizontal: 16,
  composerBottomGap: 12,
  composerKeyboardGap: 8,
  listBottomGap: 16,
  returnButtonSize: 40,
  returnButtonGap: 12,
  /** The flat composer field is opaque, so the fade only needs a short transition above it. */
  bottomFadeAboveComposer: 24,
} as const;

/** Measured height includes the closed-state bottom gap, but excludes the jump hit area.
 * StickyView and the list use the same keyboard compensation. The list does not always follow the keyboard edge:
 * while a sent message is pinned (chat.C9) only the StickyView moves and the content stays. */
export function chatBottomLayout(measuredHeight: number, bottomInset: number) {
  return {
    keyboardOffset: bottomInset + CHAT_LAYOUT.composerBottomGap - CHAT_LAYOUT.composerKeyboardGap,
    returnButtonBottom: measuredHeight + CHAT_LAYOUT.returnButtonGap,
    stickyPaddingTop: CHAT_LAYOUT.returnButtonSize + CHAT_LAYOUT.returnButtonGap,
    fadeSolidHeight: CHAT_LAYOUT.composerBottomGap,
    fadeHeight: measuredHeight + CHAT_LAYOUT.bottomFadeAboveComposer,
  };
}
