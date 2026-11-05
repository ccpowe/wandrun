import type { LucideIcon } from "lucide-react-native";
import { View, type AccessibilityRole } from "react-native";

import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";

/** 横幅右侧的单个图标操作（如就地提示的关闭 ×）；label 是无障碍名称，视觉只有图标。 */
export type StatusBannerAction = { icon: LucideIcon; label: string; onPress(): void; testID?: string };

/** Shared banner appearance; callers own visibility, priority and translated copy. */
export function StatusBanner({ icon, title, description, accessibilityRole, action }: {
  icon: LucideIcon;
  title: string;
  description?: string;
  accessibilityRole?: AccessibilityRole;
  /** design.md §6：就地提示的关闭放在横幅内右侧，不再另起一行文字。 */
  action?: StatusBannerAction;
}) {
  // The alert container stays a single accessible element only when it has no nested control.
  const grouped = accessibilityRole && !action ? true : undefined;
  return <View accessible={grouped} accessibilityRole={accessibilityRole} className={`mx-4 mb-2 flex-row items-center gap-3 rounded-md bg-muted py-2.5 pl-3.5 ${action ? "pr-1.5" : "pr-3.5"}`}>
    <Icon as={icon} className="size-5 text-muted-foreground" />
    <View className="min-w-0 flex-1 gap-0.5">
      {/* With a nested control the container is not one alert element; the title still announces itself. */}
      <Text className="text-sm font-semibold" accessibilityLiveRegion={action && accessibilityRole === "alert" ? "polite" : undefined}>{title}</Text>
      {description ? <Text className="text-xs text-muted-foreground">{description}</Text> : null}
    </View>
    {action ? <Button intent="quiet" size="icon-sm" testID={action.testID} accessibilityLabel={action.label} onPress={action.onPress}>
      <Icon as={action.icon} size={18} />
    </Button> : null}
  </View>;
}
