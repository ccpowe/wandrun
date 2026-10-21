import type { LucideIcon } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";

export type MenuItem = {
  label: string;
  testID?: string;
  icon: LucideIcon;
  onPress: () => void;
  /** 置灰且不可点；note 是右侧小字，说明为什么不可用（如“即将支持”）。 */
  disabled?: boolean;
  note?: string;
};

type Props = {
  /** 触发按钮的图标与无障碍名称。 */
  trigger: { icon: LucideIcon; label: string };
  items: MenuItem[];
  /** 整个菜单不可用（如离线）：触发按钮置灰。 */
  disabled?: boolean;
};

/** 右上角图标按钮弹出的菜单（首页 ＋）：RNR DropdownMenu 的薄封装，条目为“图标 + 文字”。 */
export function PopoverMenu({ trigger, items, disabled }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="ghost" size="icon" className="size-11 rounded-full bg-muted" aria-label={trigger.label} disabled={disabled}>
          <Icon as={trigger.icon} className="size-[22px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[260px] rounded-[16px] p-1.5">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            testID={item.testID}
            disabled={item.disabled}
            onPress={item.onPress}
            className="min-h-12 gap-3 rounded-[10px] px-3"
          >
            <View className="size-8 shrink-0 items-center justify-center rounded-[9px] bg-muted">
              <Icon as={item.icon} className="size-[18px]" />
            </View>
            <Text className="flex-1 text-[15px]">{item.label}</Text>
            {item.note ? <Text className="shrink-0 text-xs text-muted-foreground">{item.note}</Text> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
