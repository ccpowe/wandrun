import type { ViewStyle } from "react-native";

/** Floating chat chrome shares one elevation; card and border colors stay theme-owned. */
export const CHAT_FLOATING_SURFACE: ViewStyle = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 10,
  elevation: 2,
};

export const CHAT_LAYOUT = {
  contentInsetHorizontal: 16,
  composerBottomGap: 20,
  composerKeyboardGap: 8,
  listBottomGap: 16,
  returnButtonSize: 40,
  returnButtonGap: 12,
  bottomFadeMinHeight: 130,
  bottomFadeAboveMidpoint: 80,
} as const;

/** Measured height includes the closed-state bottom gap, but excludes the jump hit area.
 * StickyView and the list must use the same keyboard compensation so their edges stay aligned. */
export function chatBottomLayout(measuredHeight: number, bottomInset: number) {
  const fadeSolidHeight = (measuredHeight + CHAT_LAYOUT.composerBottomGap) / 2;
  return {
    keyboardOffset: bottomInset + CHAT_LAYOUT.composerBottomGap - CHAT_LAYOUT.composerKeyboardGap,
    returnButtonBottom: measuredHeight + CHAT_LAYOUT.returnButtonGap,
    stickyPaddingTop: CHAT_LAYOUT.returnButtonSize + CHAT_LAYOUT.returnButtonGap,
    fadeSolidHeight,
    fadeHeight: Math.max(CHAT_LAYOUT.bottomFadeMinHeight, fadeSolidHeight + CHAT_LAYOUT.bottomFadeAboveMidpoint),
  };
}
