import * as Clipboard from "expo-clipboard";
import { Copy, Quote, Trash2 } from "lucide-react-native";
import { useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";

import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { messageTextForItem, quotePreview } from "@/lib/message-actions.ts";
import type { ChatRow } from "@/lib/chat-timeline.ts";
import { userErrorMessage } from "@/lib/user-error.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useMountEffect } from "@/lib/use-mount-effect.ts";
import { DropdownMenu, DropdownMenuAnchor, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu.tsx";

/** User messages expose a long-press menu; failed local items allow copy/discard, never quote. */
export function MessageActions({ item, onQuote, onDiscard, children }: {
  item: ChatRow; onQuote(text: string): void; onDiscard?: () => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  const { pending, event, browser } = item;
  const text = useMemo(() => messageTextForItem({ key: "", pending, event, browser }), [pending, event, browser]);
  // One feedback per copy attempt; its keyed child owns the 2.2 s lifetime.
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null);
  const [point, setPoint] = useState<{ pageX: number; pageY: number } | null>(null);
  if (!text && !onDiscard) return children;
  const mine = !!item.pending || item.event?.type === "message.user";
  const failed = item.kind === "user" && item.pending && item.delivery !== "sending";
  const copy = async () => {
    if (!text) return;
    const id = Date.now();
    try {
      if (!await Clipboard.setStringAsync(text.copy)) throw new Error(t("剪贴板不可用，请稍后重试。"));
      setFeedback({ id, message: t("已复制") });
      AccessibilityInfo.announceForAccessibility(t("已复制"));
    } catch (error) {
      setFeedback({ id, message: t("无法复制：{error}", { error: t(userErrorMessage(error, "剪贴板不可用，请稍后重试")) }) });
    }
  };
  return <DropdownMenu onOpenChange={(open) => { if (!open) setPoint(null); }}>
    {mine ? <Pressable testID={`message-menu-trigger-${item.key}`}
      onLongPress={(event) => setPoint({ pageX: event.nativeEvent.pageX, pageY: event.nativeEvent.pageY })}>
      {children}
    </Pressable> : children}
    {text && !mine && <View className="flex-row items-center">
      <Button intent="quiet" size="icon" accessibilityRole="button"
        accessibilityLabel={t("复制")} testID={`message-copy-${item.key}`} onPress={() => void copy()}>
        <Icon as={Copy} className="size-[18px] text-muted-foreground" />
      </Button>
      <Button intent="quiet" size="icon" accessibilityRole="button"
        accessibilityLabel={t("引用")} testID={`message-quote-${item.key}`} disabled={!text.quote.trim()}
        onPress={() => onQuote(quotePreview(text.quote))}>
        <Icon as={Quote} className="size-[18px] text-muted-foreground" />
      </Button>
      {feedback && <CopyFeedbackText key={feedback.id} feedback={feedback} className="px-2" onExpire={() => setFeedback((current) => current === feedback ? null : current)} />}
    </View>}
    {mine && feedback && <CopyFeedbackText key={feedback.id} feedback={feedback} className="self-end" onExpire={() => setFeedback((current) => current === feedback ? null : current)} />}
    {point && <>
      <DropdownMenuAnchor point={point} />
      <DropdownMenuContent>
        {text && <>
          <DropdownMenuItem testID={`message-menu-copy-${item.key}`} onPress={() => void copy()}>
            <Icon as={Copy} className="size-4" /><Text>{t("复制")}</Text>
          </DropdownMenuItem>
          {!failed && <DropdownMenuItem testID={`message-menu-quote-${item.key}`} disabled={!text.quote.trim()}
            onPress={() => onQuote(quotePreview(text.quote))}>
            <Icon as={Quote} className="size-4" /><Text>{t("引用")}</Text>
          </DropdownMenuItem>}
        </>}
        {onDiscard && <DropdownMenuItem testID={`message-menu-delete-${item.key}`} onPress={onDiscard}>
          <Icon as={Trash2} className="size-4 text-destructive" /><Text className="text-destructive">{t("删除消息")}</Text>
        </DropdownMenuItem>}
      </DropdownMenuContent>
    </>}
  </DropdownMenu>;
}

type CopyFeedback = Readonly<{ id: number; message: string }>;

/** Shown in place of a system dialog; each copy attempt restarts the lifetime via its key. */
function CopyFeedbackText({ feedback, className, onExpire }: { feedback: CopyFeedback; className: string; onExpire(): void }) {
  useMountEffect(() => {
    const timer = setTimeout(onExpire, 2200);
    return () => clearTimeout(timer);
  });
  return <Text accessibilityLiveRegion="polite" className={`${className} text-xs text-muted-foreground`}>{feedback.message}</Text>;
}
