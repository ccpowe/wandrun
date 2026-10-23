import { WifiOff } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { useTranslation } from "./i18n.ts";

const LABELS: Record<string, string> = {
  listing: "正在连接…",
  connecting: "正在连接…",
  reconnecting: "连接断开，正在重连…",
  error: "连不上网关",
};

/** 事件流不在线时的提示文字；在线时为 null。 */
export function connectionLabel(session: ChatSession): string | null {
  if (session.connection === "open") return null;
  const label = LABELS[session.connection] ?? session.connection;
  return session.connection === "error" && session.notice ? session.notice : label;
}

/** 仅供显示：连续离线 1 秒后提示，错误立即提示；操作权限仍读真实 connection。 */
export function useConnectionLabel(session: ChatSession | null): string | null {
  const { t } = useTranslation();
  const offline = !!session && session.connection !== "open";
  const [display, setDisplay] = useState({ session, offline, visible: false });
  // 在提交画面前清掉上一段离线状态，不等 effect 再补一次渲染。
  if (display.session !== session || display.offline !== offline) {
    setDisplay({ session, offline, visible: false });
  }
  useEffect(() => {
    if (!offline || !session) return;
    const timer = setTimeout(() => setDisplay({ session, offline, visible: true }), 1000);
    return () => clearTimeout(timer);
    // connecting/reconnecting 之间切换不重启计时，换电脑则独立计时。
  }, [session, offline]);
  if (!session || !offline) return null;
  return session.connection === "error" || display.visible ? t(connectionLabel(session) ?? "") : null;
}

/** 短暂断线不闪横幅；错误立即显示，恢复在线立即移除。 */
export function ConnectionBanner({ session }: { session: ChatSession }) {
  const { t } = useTranslation();
  const label = useConnectionLabel(session);
  if (!label) return null;
  return (
    <View className="mx-4 mb-2 flex-row items-center gap-3 rounded-md bg-muted px-3.5 py-2.5">
      <Icon as={WifiOff} className="size-5 text-muted-foreground" />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-sm font-semibold">{label}</Text>
        <Text className="text-xs text-muted-foreground">{t("内容可能不是最新的")}</Text>
      </View>
    </View>
  );
}
