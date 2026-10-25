import { useIsFocused } from "expo-router";
import { Download, Share2 } from "lucide-react-native";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";

import { mediaErrorMessage } from "./rich-message/media.tsx";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Text } from "./ui/text.tsx";
import { GatewayError, type GatewayApi } from "../gateway/api.ts";
import { deliverImage, type ImageAction, type ImageSource } from "../lib/image-delivery.ts";
import { useTranslation } from "../lib/i18n.ts";
import { userErrorMessage } from "../lib/user-error.ts";

type ActionScope = { valid: boolean; pending: boolean };
type ActionState = { owner: object; working: ImageAction | null; error: string | null; saved: boolean };
/** A mounted control owns only pre-handoff work; completed native saves/shares own their resources. */
export function ImageActions({ api, source, light = false }: {
  api?: GatewayApi; source: ImageSource; light?: boolean;
}) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const owner = useMemo(() => ({ api, focused }), [api, focused]);
  const scopeRef = useRef<ActionScope | null>(null);
  // A new focus/page/API scope cannot display a previous operation's state.
  const [state, setState] = useState<ActionState | null>(null);
  const visible = state?.owner === owner ? state : null;
  const working = visible?.working ?? null;
  const error = visible?.error ?? null;
  const saved = visible?.saved ?? false;
  useLayoutEffect(() => {
    if (!focused || !api || Platform.OS === "web") return;
    const scope: ActionScope = { valid: !api.signal.aborted, pending: false };
    scopeRef.current = scope;
    const closed = () => { scope.valid = false; };
    api.signal.addEventListener("abort", closed, { once: true });
    return () => {
      scope.valid = false;
      if (scopeRef.current === scope) scopeRef.current = null;
      api.signal.removeEventListener("abort", closed);
    };
  }, [api, focused, owner]);
  const disabled = !api || !focused || Platform.OS === "web" || !!working || api.signal.aborted;
  const open = async (action: ImageAction) => {
    const scope = scopeRef.current;
    if (!api || !scope?.valid || scope.pending || disabled) return;
    const current = () => scope.valid && scopeRef.current === scope && !api.signal.aborted;
    scope.pending = true;
    setState({ owner, working: action, error: null, saved: false });
    let result = false;
    let failure: string | null = null;
    try {
      result = await deliverImage(api, source, action, current);
    } catch (cause) {
      failure = source.location && cause instanceof GatewayError
        ? mediaErrorMessage(cause)
        : userErrorMessage(cause, action === "download"
          ? "无法保存图片，请检查网络、存储空间和文件权限后重试"
          : "无法分享图片，请重新打开图片后重试");
    } finally {
      scope.pending = false;
      if (current()) setState({ owner, working: null, error: failure, saved: result });
    }
  };
  return <View className="items-end">
    <View className="flex-row items-center gap-1">
      <Button testID="media-download" variant="ghost" size="icon" className="size-11 bg-transparent"
        aria-label={working === "download" ? t("正在保存图片") : t("下载图片")}
        disabled={disabled} onPress={() => void open("download")}>
        {working === "download" ? <ActivityIndicator size="small" /> : <Icon as={Download} className={`size-5 ${light ? "text-white" : ""}`} />}
      </Button>
      <Button testID="media-share" variant="ghost" size="icon" className="size-11 bg-transparent"
        aria-label={working === "share" ? t("正在准备分享图片") : t("分享图片")}
        disabled={disabled} onPress={() => void open("share")}>
        {working === "share" ? <ActivityIndicator size="small" /> : <Icon as={Share2} className={`size-5 ${light ? "text-white" : ""}`} />}
      </Button>
    </View>
    {error && <Text testID="media-action-error" accessibilityLiveRegion="polite" className="max-w-56 text-right text-xs text-destructive">{t(error)}</Text>}
    {saved && <Text testID="media-saved" accessibilityLiveRegion="polite" className={`text-xs ${light ? "text-white" : "text-muted-foreground"}`}>{t("已保存到所选位置")}</Text>}
  </View>;
}
