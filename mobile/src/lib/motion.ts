import { Easing, ReduceMotion } from 'react-native-reanimated';

/** Milliseconds for application-owned transitions; navigator/drawer libraries keep their defaults. */
export const duration = { exit: 150, base: 200, enter: 240 } as const;
export const reduceMotion = ReduceMotion.System;

export const easing = {
  enter: Easing.out(Easing.cubic),
  exit: Easing.in(Easing.cubic),
  // Preserve existing Reanimated timing curves during the parameter-only cutover.
  standard: Easing.inOut(Easing.quad),
  linear: Easing.linear,
};

// Dialog content and dropdowns previously used Reanimated's implicit 300ms FadeIn default.
export const presetFade = 300;
// Stagger dialog content behind its overlay without changing the existing visual sequence.
export const dialogContentDelay = 50;
// One complete typing-indicator pulse, not a UI transition.
export const typingCycle = 1200;
// Link thumbnails fade over their source-site mark after the image decodes.
export const thumbnailFade = 180;
// Progress must settle without overshooting its percentage; retain Reanimated's spring defaults.
export const progressSpring = { overshootClamping: true, reduceMotion } as const;

// Static Tailwind tokens keep the non-product Web presentation discoverable by the CSS scanner.
export const webDuration = { base: 'duration-200' } as const;
