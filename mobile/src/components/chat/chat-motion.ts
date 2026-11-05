import { reduceMotion } from '../../lib/motion.ts';

/** User-tuned physical springs from the accepted on-device carousel prototype. */
export const CHAT_SPRINGS = {
  morph: { stiffness: 260, damping: 26, mass: 1, reduceMotion },
  snap: { stiffness: 280, damping: 24, mass: 0.9, reduceMotion },
} as const;
