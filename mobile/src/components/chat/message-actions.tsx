import * as Clipboard from "expo-clipboard";
import { Copy, Quote } from "lucide-react-native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, Alert, View } from "react-native";

import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { messageTextForItem, quotePreview } from "@/lib/message-actions.ts";
import type { Item } from "@/lib/chat-timeline.ts";
import { userErrorMessage } from "@/lib/user-error.ts";
import { useTranslation } from "@/lib/i18n.ts";

/** Message content keeps native long-press selection; actions live in a separate row below it. */
export function MessageActions({ item, onQuote, children }: { item: Item; onQuote(text: string): void; children: ReactNode }) {
  const { t } = useTranslation();
  const { pending, event, browser } = item;
  const text = useMemo(() => messageTextForItem({ key: "", pending, event, browser }), [pending, event, browser]);
  const [copied, setCopied] = useState(0);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(0), 2200);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!text) return children;
  const mine = !!item.pending || item.event?.type === "message.user";
  const copy = async () => {
    try {
      if (!await Clipboard.setStringAsync(text.copy)) throw new Error(t("剪贴板不可用，请稍后重试。"));
      setCopied(Date.now());
      AccessibilityInfo.announceForAccessibility(t("已复制"));
    } catch (error) {
      Alert.alert(t("无法复制"), t(userErrorMessage(error, "剪贴板不可用，请稍后重试")));
    }
  };
  return <View>
    {children}
    <View className={mine ? "flex-row items-center justify-end" : "flex-row items-center"}>
      <Button variant="ghost" size="icon" className="size-11 bg-transparent" accessibilityRole="button"
        accessibilityLabel={t("复制")} testID={`message-copy-${item.key}`} onPress={() => void copy()}>
        <Icon as={Copy} className="size-[18px] text-muted-foreground" />
      </Button>
      <Button variant="ghost" size="icon" className="size-11 bg-transparent" accessibilityRole="button"
        accessibilityLabel={t("引用")} testID={`message-quote-${item.key}`} disabled={!text.quote.trim()}
        onPress={() => onQuote(quotePreview(text.quote))}>
        <Icon as={Quote} className="size-[18px] text-muted-foreground" />
      </Button>
      {!!copied && <Text accessibilityLiveRegion="polite" className="px-2 text-xs text-muted-foreground">{t("已复制")}</Text>}
    </View>
  </View>;
}
