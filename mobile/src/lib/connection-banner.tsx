import { useIsFocused } from "expo-router";
import { WifiOff } from "lucide-react-native";
import { useMemo, useSyncExternalStore } from "react";

import { StatusBanner } from "@/components/status-banner.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { useTranslation } from "./i18n.ts";
import { NoticeDeadline } from "./notice-deadline.ts";

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

/** 仅供显示：连续离线满 3 秒才提示；认证失效仍由 Credentials 立即撤销会话并提供重新配对入口。 */
export function useConnectionLabel(session: ChatSession | null): string | null {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const offline = !!session && session.connection !== "open";
  const deadline = useMemo(() => new NoticeDeadline(
    () => focused && offline && session && session.connection !== "open" ? "offline" : null, focused ? session?.subscribe : undefined,
  ), [session, offline, focused]);
  const visible = useSyncExternalStore(deadline.subscribe, deadline.snapshot, deadline.snapshot);
  if (!session || session.connection === "open" || !visible) return null;
  return t(connectionLabel(session) ?? "");
}

/** 短暂断线与可重试错误不闪横幅，恢复在线立即移除。 */
export function ConnectionBanner({ session }: { session: ChatSession }) {
  const { t } = useTranslation();
  const label = useConnectionLabel(session);
  if (!label) return null;
  return <StatusBanner icon={WifiOff} title={label} description={t("内容可能不是最新的")} />;
}
