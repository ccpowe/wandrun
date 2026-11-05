import { ChevronRight, Server } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { Icon } from "./ui/icon.tsx";
import { SurfacePressable } from "./ui/surface-pressable.tsx";
import { Text } from "./ui/text.tsx";
import type { ChatSession } from "../gateway/session.ts";
import type { SavedComputer } from "../lib/credentials.ts";
import { useTranslation } from "../lib/i18n.ts";

/** Status belongs only to the active session; saved servers are never probed implicitly. */
export function SettingsComputerCard({ computer, session, name, version, large = false, onPress, footer, inset = true, current = true, testID = "settings-connection" }: {
  computer?: SavedComputer | null; session: ChatSession | null; name?: string; version?: string;
  large?: boolean; onPress?: () => void; footer?: ReactNode; inset?: boolean; current?: boolean; testID?: string;
}) {
  const { t } = useTranslation();
  const online = session?.connection === "open";
  const invalid = computer?.authStatus === "invalid";
  const failed = invalid || session?.connection === "error";
  const label = invalid ? t("需要重新配对") : online ? t("已连接") : failed ? t("连接失败") : session ? t("正在重连…") : t("未连接");
  const content = <>
    <View className="flex-row items-center justify-between">
      <Icon as={Server} size={large ? 36 : 28} className="text-device-foreground" />
      {onPress ? <Icon as={ChevronRight} size={20} className="text-device-foreground/60" /> : null}
    </View>
    <View className="min-w-0 gap-2">
      <Text testID={large ? "connection-name" : current ? "settings-computer-name" : undefined} numberOfLines={1} className="text-2xl font-medium leading-8 text-device-foreground">{computer?.localName || name || computer?.computerName || t("服务器")}</Text>
      <View className="flex-row items-center gap-2">
        <View testID={large ? "connection-status-dot" : current ? "settings-status-dot" : undefined} className={`size-2 rounded-full ${online ? "bg-rich-success" : failed ? "bg-destructive" : session ? "bg-rich-warning" : "bg-device-foreground/50"}`} />
        <Text testID={large ? "connection-status" : current ? "settings-connection-status" : undefined} variant="caption" numberOfLines={1} className="shrink text-device-foreground/60">{label}{online && version ? ` · Wandrun ${version}` : ""}</Text>
      </View>
    </View>
    {footer}
  </>;
  const className = `${inset ? "mx-4" : "ml-4 mr-2"} min-h-44 justify-between gap-3 overflow-hidden rounded-lg bg-device-surface p-5`;
  return onPress ? <SurfacePressable testID={testID} accessibilityRole="button" accessibilityLabel={current ? t("服务器与连接") : t("查看服务器：{name}", { name: computer?.localName || computer?.computerName || t("服务器") })} onPress={onPress} feedback="surface" overlayClassName="bg-device-foreground/7" className={className}>{content}</SurfacePressable>
    : <View testID="connection-current" className={className}>{content}</View>;
}
