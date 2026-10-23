import { LinearGradient } from "expo-linear-gradient";
import { useCSSVariable } from "uniwind";

/** Theme palettes define background as #RRGGBB; retain its hue at every opacity stop.
 * The bottom fade's solid region ends at the measured capsule's vertical centre. */
export function ChatFade({ edge, height, solidHeight }: {
  edge: "top" | "bottom";
  height: number;
  solidHeight: number;
}) {
  const background = String(useCSSVariable("--color-background"));
  const solid = Math.min(solidHeight / height, 1);
  // The bottom edge never turns fully solid: content stays faintly visible around and below the floating capsule.
  const bottom = edge === "bottom";
  return <LinearGradient pointerEvents="none" testID={`chat-${edge}-fade`}
    colors={bottom
      ? [`${background}E6`, `${background}99`, `${background}00`]
      : [background, background, `${background}B3`, `${background}00`]}
    locations={bottom ? [0, 0.45, 1] : [0, solid, solid + (1 - solid) * 0.46, 1]}
    start={{ x: 0, y: edge === "top" ? 0 : 1 }}
    end={{ x: 0, y: edge === "top" ? 1 : 0 }}
    style={{ position: "absolute", left: 0, right: 0, [edge]: 0, height }} />;
}
