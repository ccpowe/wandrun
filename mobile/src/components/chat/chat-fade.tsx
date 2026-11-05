import { LinearGradient } from "expo-linear-gradient";
import { useCSSVariable } from "uniwind";

/** design.md §5：顶部从状态栏下开始变淡，透明标题段保留约 88% 底色，顶栏下方 40 内淡出。 */
export const CHAT_TOP_FADE_BELOW = 40;

type Props =
  /** `headerBottom`：顶栏（及其下横幅）底边离屏顶的距离；`statusBar`：状态栏高度，此前保持实色。 */
  | { edge: "top"; statusBar: number; headerBottom: number }
  /** 底部只在输入条上方留一小段轻过渡；`solidHeight` 是输入条下方的实色区。 */
  | { edge: "bottom"; height: number; solidHeight: number };

/** Theme palettes define background as #RRGGBB; retain its hue at every opacity stop. */
export function ChatFade(props: Props) {
  const background = String(useCSSVariable("--color-background"));
  if (props.edge === "top") {
    const { statusBar, headerBottom } = props;
    const height = headerBottom + CHAT_TOP_FADE_BELOW;
    // Transparent title text needs ~88% background behind it; content below fades in over 40.
    return <LinearGradient pointerEvents="none" testID="chat-top-fade"
      colors={[background, background, `${background}E0`, `${background}99`, `${background}00`]}
      locations={[0, statusBar / height, Math.max(statusBar, headerBottom - 4) / height, (headerBottom + 14) / height, 1]}
      style={{ position: "absolute", left: 0, right: 0, top: 0, height }} />;
  }
  const { height, solidHeight } = props;
  const solid = Math.min(solidHeight / height, 1);
  // The bottom edge never turns fully solid: content stays faintly visible below the composer bar.
  return <LinearGradient pointerEvents="none" testID="chat-bottom-fade"
    colors={[`${background}E6`, `${background}E6`, `${background}00`]}
    locations={[0, solid, 1]}
    start={{ x: 0, y: 1 }} end={{ x: 0, y: 0 }}
    style={{ position: "absolute", left: 0, right: 0, bottom: 0, height }} />;
}
