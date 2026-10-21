import { useEffect, useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { BrowserTask } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { useTranslation } from "@/lib/i18n.ts";

/** Confirm a whole-lease close from any page row; keep failures visible until retried or dismissed. */
export function BrowserTaskCloseDialog({ session, task, onDismiss, testIDPrefix }: {
  session: ChatSession; task: BrowserTask; onDismiss: () => void; testIDPrefix: string;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [closeError, setCloseError] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const close = async () => {
    if (operation.current || session.connection !== "open") return;
    operation.current = true;
    setBusy(true);
    setCloseError("");
    try {
      // The swipe identifies a page, but the API closes its entire lease.
      await session.api.closeBrowser(task.id);
      await session.refreshBrowserTasks();
      if (mounted.current) onDismiss();
    } catch (cause) {
      if (mounted.current) setCloseError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <AlertDialog open onOpenChange={(open) => { if (!open && !operation.current) onDismiss(); }}>
    <AlertDialogContent overlayClassName="justify-end p-0" className="w-full rounded-b-none rounded-t-[24px] border-border bg-card" style={{ paddingBottom: insets.bottom + 20 }}>
      <AlertDialogHeader><AlertDialogTitle>{t("关闭这个任务的浏览器？")}</AlertDialogTitle>
        <AlertDialogDescription>{t("此任务打开的全部页面都会关闭，Agent 将不能继续使用这些页面。")}</AlertDialogDescription>
      </AlertDialogHeader>
      {closeError ? <Text testID={`${testIDPrefix}-close-error`} className="text-sm text-destructive">{t("关闭失败：{error}", { error: t(closeError) })}</Text> : null}
      <AlertDialogFooter className="flex-col-reverse gap-2">
        <AlertDialogCancel disabled={busy}><Text>{t("取消")}</Text></AlertDialogCancel>
        <Button testID={`${testIDPrefix}-close-${task.id}`} variant="outline" disabled={busy || session.connection !== "open"}
          className="border-destructive bg-card" onPress={() => void close()}>
          <Text className="text-destructive">{t(busy ? "关闭中…" : "关闭浏览器")}</Text>
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
