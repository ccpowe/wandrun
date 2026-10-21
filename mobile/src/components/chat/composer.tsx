import { ArrowUp, Quote, X } from "lucide-react-native";
import { TextInput, View } from "react-native";

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
};

/** Composer holds the staged files above the input; no file is sent until the gateway gives its id. */
export function Composer({ draft, onChangeDraft, quote, onCancelQuote, attachments, uploadError, onPick, onRetry, onRemove, working, stopping, onSend, onStop, textOnly = false, disabledReason }: Props) {
  const { t } = useTranslation();
  const readiness = sendReadiness({ text: draft, items: attachments });
  const action = uploadError || disabledReason ? "disabled" : composerAction(working, draft, attachments.length, readiness.enabled);
  return (
    <View className="mx-4 mb-2 mt-2 rounded-[26px] border border-border bg-card p-1.5">
      {quote && <View className="mx-2 mb-1 flex-row items-center gap-2 rounded-2xl bg-muted px-3 py-2">
        <Icon as={Quote} className="size-4 text-muted-foreground" />
        <Text testID="composer-quote" numberOfLines={3} className="flex-1 border-l-2 border-border pl-2 text-sm text-muted-foreground">{quote}</Text>
        <Button variant="ghost" size="icon" className="size-11" accessibilityLabel={t("取消引用")} onPress={onCancelQuote}>
          <Icon as={X} className="size-4" />
        </Button>
      </View>}
      <AttachmentDrafts items={attachments} onRetry={onRetry} onRemove={onRemove} />
      <View className="flex-row items-end gap-1.5">
        {!textOnly && <AttachmentPickerMenu onPick={onPick} />}
        <TextInput
          className="max-h-[120px] min-h-10 flex-1 px-1 py-2 text-base text-foreground"
          placeholderTextColorClassName="accent-muted-foreground"
          value={draft}
          editable={!disabledReason}
          onChangeText={onChangeDraft}
          placeholder={disabledReason ? t(disabledReason) : working ? t("补充要求（会打断这一轮）") : t("说点什么")}
          multiline
          aria-label={t("消息")}
          testID="composer-input"
        />
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
            <Icon as={ArrowUp} className={action === "send" ? "size-5 text-primary-foreground" : "size-5 text-muted-foreground"} strokeWidth={2} />
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
