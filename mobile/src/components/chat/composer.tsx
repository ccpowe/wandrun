import { AlertCircle, ArrowUp, X } from "lucide-react-native";
import { useState } from "react";
import { Platform, Text as RNText, TextInput, View } from "react-native";

import { AttachmentDrafts } from "@/components/chat/attachment-drafts.tsx";
import { AttachmentPickerMenu } from "@/components/chat/attachment-picker-menu.tsx";
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
  /** Blocks another command without blurring/disabling the native text field. */
  sendDisabled?: boolean;
  attachmentsDisabled?: boolean;
  attachmentActionsDisabled?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  /** Send blocked before any request (known offline): shown in the field, text stays (chat.N4 / N7). */
  inlineError?: string | null;
};

/** Body 15/20 with 10 above and below: one line is 40, so its centre meets the 32 icon buttons (4 from the bottom). */
const INPUT_LINE_HEIGHT = 20;
const INPUT_FONT_SIZE = 15;
const INPUT_PADDING = 10;
const INPUT_MIN_HEIGHT = INPUT_LINE_HEIGHT + 2 * INPUT_PADDING;
const INPUT_MAX_HEIGHT = 120;


/** Composer holds the staged files above the input; no file is sent until the gateway gives its id. */
export function Composer({ draft, onChangeDraft, quote, onCancelQuote, attachments, uploadError, onPick, onRetry, onRemove, working, stopping, onSend, onStop, textOnly = false, disabledReason, sendDisabled = false, attachmentsDisabled = false, attachmentActionsDisabled = false, onFocus, onBlur, autoFocus, inlineError }: Props) {
  const { t } = useTranslation();
  const placeholder = disabledReason ? t(disabledReason) : working ? t("补充要求") : t("说点什么");
  // A terminal newline needs a following (invisible) glyph to measure its empty last line.
  const probeText = draft.endsWith("\n") ? `${draft}\u200b` : draft;
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  const readiness = sendReadiness({ text: draft, items: attachments });
  const action = sendDisabled || uploadError || disabledReason ? "disabled" : composerAction(working, draft, attachments.length, readiness.enabled);
  // design.md §5 / §7: flat muted field; attach, send and stop live inside it; quote and drafts sit on top.
  return (
    <View className="px-3">
      <View className="min-h-10 rounded-[20px] bg-muted">
        {inlineError ? <View testID="composer-inline-error" accessibilityRole="alert" accessibilityLiveRegion="polite" className="flex-row items-center gap-1.5 pl-4 pr-3 pt-2.5">
          <Icon as={AlertCircle} size={14} className="text-destructive" />
          <Text className="min-w-0 shrink text-xs text-destructive">{inlineError}</Text>
        </View> : null}
        {quote && <View className="flex-row items-start gap-1 pl-4 pr-1 pt-2">
          <View className="min-w-0 flex-1 border-l-2 border-muted-foreground/30 pl-2.5 pt-1">
            <Text testID="composer-quote" variant="caption" numberOfLines={3} className="text-muted-foreground">{quote}</Text>
          </View>
          <Button intent="quiet" size="icon-sm" accessibilityLabel={t("取消引用")} onPress={onCancelQuote}>
            <Icon as={X} size={16} />
          </Button>
        </View>}
        <AttachmentDrafts items={attachments} onRetry={onRetry} onRemove={onRemove} disabled={attachmentActionsDisabled} />
        <View className={`flex-row items-end pr-1 ${textOnly ? "pl-4" : "pl-1"}`}>
          {!textOnly && <AttachmentPickerMenu onPick={onPick} disabled={attachmentsDisabled || !!disabledReason} />}
          <View className={`min-w-0 flex-1 ${textOnly ? "" : "pl-1"}`}>
            <TextInput
              className="w-full px-0 text-body text-foreground"
              style={{ height: draft ? inputHeight : INPUT_MIN_HEIGHT, paddingVertical: INPUT_PADDING, fontSize: INPUT_FONT_SIZE, lineHeight: INPUT_LINE_HEIGHT, includeFontPadding: false }}
              textAlignVertical="top"
              value={draft}
              editable={!disabledReason}
              onChangeText={onChangeDraft}
              onFocus={onFocus}
              onBlur={onBlur}
              autoFocus={autoFocus}
              multiline
              numberOfLines={Platform.OS === "web" ? 1 : undefined}
              aria-label={t("消息")}
              testID="composer-input"
            />
            {/* Native multiline placeholders can wrap. Keep the hint outside the input's
                measurement and touch/a11y trees; only the draft determines its height.
                Same metrics as the input, so the hint sits exactly on its first line. */}
            {!draft && <RNText
              numberOfLines={1}
              ellipsizeMode="tail"
              accessible={false}
              importantForAccessibility="no"
              aria-hidden={true}
              pointerEvents="none"
              className="text-muted-foreground"
              style={{ position: "absolute", left: 0, right: 0, top: INPUT_PADDING, fontSize: INPUT_FONT_SIZE, lineHeight: INPUT_LINE_HEIGHT, includeFontPadding: false }}
            >{placeholder}</RNText>}
            {/* Match the input's text metrics and width, independently of its scrollable viewport. */}
            <RNText
              accessible={false}
              importantForAccessibility="no"
              aria-hidden={true}
              pointerEvents="none"
              style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: 0, fontSize: INPUT_FONT_SIZE, lineHeight: INPUT_LINE_HEIGHT, includeFontPadding: false }}
              onLayout={({ nativeEvent }) => {
                const height = draft ? Math.min(INPUT_MAX_HEIGHT, Math.max(INPUT_MIN_HEIGHT, Math.ceil(nativeEvent.layout.height + 2 * INPUT_PADDING))) : INPUT_MIN_HEIGHT;
                setInputHeight((current) => current === height ? current : height);
              }}
            >{probeText}</RNText>
          </View>
          {action === "stop" ? (
            <Button
              intent="quiet"
              size="icon-sm"
              className={`mb-1 border-[1.5px] ${stopping ? "border-muted-foreground/40" : "border-foreground"}`}
              onPress={onStop}
              disabled={stopping}
              aria-label={t("停止这一轮")}
              accessibilityHint={t("停止当前会话及其全部下属工作")}
            >
              <View className={`size-2.5 rounded-[2px] ${stopping ? "bg-muted-foreground/40" : "bg-foreground"}`} />
            </Button>
          ) : (
            // Not sendable: only a muted arrow, no grey disc (design.md §7).
            <Button
              testID="composer-send"
              intent={action === "send" ? "primary" : "quiet"}
              size="icon-sm"
              className="mb-1"
              onPress={onSend}
              disabled={action === "disabled"}
              aria-label={action === "disabled" && (disabledReason || uploadError || attachments.length) ? t("发送不可用：{reason}", { reason: t(disabledReason ?? uploadError ?? readiness.reason ?? "") }) : t("发送")}
            >
              <Icon as={ArrowUp} size={18} />
            </Button>
          )}
        </View>
        {(uploadError || (attachments.length > 0 && readiness.reason)) && (
          <Text className={uploadError ? "px-4 pb-2 text-xs text-destructive" : "px-4 pb-2 text-xs text-muted-foreground"}>
            {uploadError ? t(uploadError) : t(readiness.reason ?? "")}
          </Text>
        )}
      </View>
    </View>
  );
}
