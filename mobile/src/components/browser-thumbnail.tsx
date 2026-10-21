import { Image } from "expo-image";
import { useIsFocused } from "expo-router";
import { Monitor } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";

import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { BrowserTask, GatewayApi } from "@/gateway/api.ts";
import { nextThumbnailRequest, THUMBNAIL_REFRESH_MS, type ThumbnailRequest } from "@/lib/browser-thumbnail.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { loadLocalImage } from "@/lib/local-image.ts";
import { useSession } from "@/lib/session-context.tsx";
import { cn } from "@/lib/utils.ts";

/** Authenticated, uncached still image. Only visible chat cards opt into periodic refresh;
 * other surfaces load once per visible visit. No requests while unfocused or backgrounded. */
export function BrowserThumbnail({ task, page, active, refresh = false, className }: {
  task: BrowserTask; page?: string; active: boolean; refresh?: boolean; className?: string;
}) {
  const session = useSession();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const target = page ?? task.current;
  const visible = active && focused && foreground && session?.connection === "open" &&
    task.state !== "released" && task.pages.some((item) => item.id === target);
  const source = visible && session && target ? session.api.browserThumbnailPath(task.id, target) : null;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);

  return <View testID={`browser-thumbnail-${task.id}`} className={cn("h-[150px] items-center justify-center overflow-hidden bg-muted", className)}>
    <ThumbnailImage key={`${session?.api.config.computerId}:${source ?? "inactive"}`} source={source} api={session?.api} taskId={task.id} refresh={refresh} />
  </View>;
}

/** A source/visibility change remounts the request owner, cancelling the old body
 * before Expo Image sees only local bytes in its computer's private cache. */
function ThumbnailImage({ source, api, taskId, refresh }: {
  source: string | null; api?: GatewayApi; taskId: string; refresh: boolean;
}) {
  const { t } = useTranslation();
  const [request, setRequest] = useState<ThumbnailRequest | null>(() => nextThumbnailRequest(null, source, Date.now(), refresh));
  const [loaded, setLoaded] = useState<{ request: string; uri: string } | null>(null);
  const [displayedUrl, setDisplayedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!source || !refresh) return;
    const interval = setInterval(() => {
      setRequest((current) => nextThumbnailRequest(current, source, Date.now(), refresh));
    }, THUMBNAIL_REFRESH_MS);
    return () => clearInterval(interval);
  }, [source, refresh]);

  const url = request?.uri;
  useEffect(() => {
    if (!url || !api) return;
    let active = true;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    void loadLocalImage(api, url, controller.signal).then((lease) => {
      dispose = lease.dispose;
      if (active && !api.signal.aborted) setLoaded({ request: url, uri: lease.uri });
      else lease.dispose();
    }, () => { if (active && !api.signal.aborted) setFailedUrl(url); });
    return () => {
      active = false;
      controller.abort();
      dispose?.();
    };
  }, [api, url]);
  const localUri = loaded && loaded.request === url ? loaded.uri : null;
  return url && failedUrl !== url ? <View
      testID={displayedUrl === url ? `browser-thumbnail-displayed-${taskId}` : undefined}
      style={{ height: "100%", width: "100%" }}>
      {localUri ? <Image key={localUri} source={{ uri: localUri }} cachePolicy="none"
        contentFit="cover" contentPosition="top" style={{ height: "100%", width: "100%" }}
        onDisplay={() => setDisplayedUrl(url)} onError={() => setFailedUrl(url)} /> : null}
    </View> :
      <View className="items-center gap-1.5"><Icon as={Monitor} className="size-6 text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">{t(url && failedUrl === url ? "画面暂不可用" : "等待浏览器画面")}</Text>
      </View>;
}
