import { ArrowUp, Quote, X } from "lucide-react-native";
import { useState } from "react";
import { Platform, Text as RNText, TextInput, View } from "react-native";

import { AttachmentDrafts } from "@/components/chat/attachment-drafts.tsx";
import { AttachmentPickerMenu } from "@/components/chat/attachment-picker-menu.tsx";
import { CHAT_FLOATING_SURFACE, CHAT_LAYOUT } from "@/components/chat/chat-surface.ts";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { composerAction } from "@/lib/chat-timeline.ts";
import type { AttachmentSource } from "@/lib/pick-upload.ts";
import { sendReadiness, type UploadItem } from "@/lib/upload-draft-state.ts";
import { useTranslation } from "@/lib/i18n.ts";

type Props = {
  draft: string;
  onChangeDraft(text: string): void;
  quote: string | null;
  onCancelQuote(): void;
  attachments: UploadItem[];
  uploadError: string | null;
  onPick(source: AttachmentSource): void;
  onRetry(id: string): void;
  onRemove(id: string): void;
  working: boolean;
  stopping: boolean;
  onSend(): void;
  onStop(): void;
  textOnly?: boolean;
  disabledReason?: string;
};

const INPUT_MIN_HEIGHT = 40;
const INPUT_MAX_HEIGHT = 120;
const INPUT_VERTICAL_PADDING = 16;
const COMPOSER_SURFACE = { ...CHAT_FLOATING_SURFACE, marginHorizontal: CHAT_LAYOUT.contentInsetHorizontal };

/** Composer holds the staged files above the input; no file is sent until the gateway gives its id. */
export function Composer({ draft, onChangeDraft, quote, onCancelQuote, attachments, uploadError, onPick, onRetry, onRemove, working, stopping, onSend, onStop, textOnly = false, disabledReason }: Props) {
  const { t } = useTranslation();
  const placeholder = disabledReason ? t(disabledReason) : working ? t("补充要求") : t("说点什么");
  // A terminal newline needs a following (invisible) glyph to measure its empty last line.
  const probeText = draft.endsWith("\n") ? `${draft}\u200b` : draft;
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  const readiness = sendReadiness({ text: draft, items: attachments });
  const action = uploadError || disabledReason ? "disabled" : composerAction(working, draft, attachments.length, readiness.enabled);
  return (
    <View className={`min-h-[52px] border border-border bg-card p-[5px] ${quote || attachments.length ? "rounded-[24px]" : "rounded-[26px]"}`} style={COMPOSER_SURFACE}>
      {quote && <View className="mx-2 mb-1 flex-row items-center gap-2 rounded-2xl bg-muted px-3 py-2">
        <Icon as={Quote} className="size-4 text-muted-foreground" />
        <Text testID="composer-quote" numberOfLines={3} className="flex-1 border-l-2 border-border pl-2 text-sm text-muted-foreground">{quote}</Text>
        <Button variant="ghost" size="icon" className="size-7 bg-transparent" hitSlop={8} accessibilityLabel={t("取消引用")} onPress={onCancelQuote}>
          <Icon as={X} className="size-4" />
        </Button>
      </View>}
      <AttachmentDrafts items={attachments} onRetry={onRetry} onRemove={onRemove} />
      <View className="flex-row items-end gap-0.5">
        {!textOnly && <AttachmentPickerMenu onPick={onPick} />}
        <View className="min-w-0 flex-1">
          <TextInput
            className="w-full px-1 py-2 text-base text-foreground"
            style={{ height: draft ? inputHeight : INPUT_MIN_HEIGHT, lineHeight: 24, includeFontPadding: false }}
            textAlignVertical="top"
            value={draft}
            editable={!disabledReason}
            onChangeText={onChangeDraft}
            multiline
            numberOfLines={Platform.OS === "web" ? 1 : undefined}
            aria-label={t("消息")}
            testID="composer-input"
          />
          {/* Native multiline placeholders can wrap. Keep the hint outside the input's
              measurement and touch/a11y trees; only the draft determines its height. */}
          {!draft && <RNText
            numberOfLines={1}
            ellipsizeMode="tail"
            accessible={false}
            importantForAccessibility="no"
            aria-hidden={true}
            pointerEvents="none"
            className="text-base text-muted-foreground"
            style={{ position: "absolute", left: 4, right: 4, top: 8, lineHeight: 24, includeFontPadding: false }}
          >{placeholder}</RNText>}
          {/* Match the input's text metrics and width, independently of its scrollable viewport. */}
          <RNText
            accessible={false}
            importantForAccessibility="no"
            aria-hidden={true}
            pointerEvents="none"
            style={{ position: "absolute", left: 4, right: 4, top: 0, opacity: 0, fontSize: 16, lineHeight: 24, includeFontPadding: false }}
            onLayout={({ nativeEvent }) => {
              const height = draft ? Math.min(INPUT_MAX_HEIGHT, Math.max(INPUT_MIN_HEIGHT, Math.ceil(nativeEvent.layout.height + INPUT_VERTICAL_PADDING))) : INPUT_MIN_HEIGHT;
              setInputHeight((current) => current === height ? current : height);
            }}
          >{probeText}</RNText>
        </View>
        {action === "stop" ? (
          <Button
            variant="outline"
            size="icon"
            className="size-10 border-[1.5px] border-foreground bg-transparent"
            onPress={onStop}
            disabled={stopping}
            aria-label={t("停止这一轮")}
            accessibilityHint={t("停止当前会话及其全部下属工作")}
          >
            <View className="size-3 rounded-[3px] bg-foreground" />
          </Button>
        ) : (
          <Button
            testID="composer-send"
            size="icon"
            className={action === "send" ? "size-10 bg-primary" : "size-10 bg-muted"}
            onPress={onSend}
            disabled={action === "disabled"}
            aria-label={action === "disabled" && (disabledReason || uploadError || attachments.length) ? t("发送不可用：{reason}", { reason: t(disabledReason ?? uploadError ?? readiness.reason ?? "") }) : t("发送")}
          >
            <Icon as={ArrowUp} size={22} className={action === "send" ? "text-primary-foreground" : "text-muted-foreground"} style={{ width: 22, height: 22 }} />
          </Button>
        )}
      </View>
      {(uploadError || (attachments.length > 0 && readiness.reason)) && (
        <Text className={uploadError ? "px-3 pb-1 text-xs text-destructive" : "px-3 pb-1 text-xs text-muted-foreground"}>
          {uploadError ? t(uploadError) : t(readiness.reason ?? "")}
        </Text>
      )}
    </View>
  );
}
