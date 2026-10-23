import { Redirect, router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight, UserRound } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import { GatewayError, type SkillDetail } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";
import { commitSkillDeletion, preflightSkillDeletion, SkillActionScope, skillMarkdown } from "@/lib/skills.ts";

export default function SkillDetailRoute() {
  const { name } = useLocalSearchParams<{ name?: string }>();
  const session = useSession();
  if (!session || !name) return <Redirect href="/settings-skills" />;
  return <SkillDetailScreen key={name} name={name} session={session} />;
}

function SkillDetailScreen({ name, session }: { name: string; session: ChatSession }) {
  const { t, locale } = useTranslation();
  const revision = useSyncExternalStore(session.subscribe, () => session.skillRevision);
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<"confirm" | "blocked" | null>(null);
  const [deleteUsers, setDeleteUsers] = useState<{ id: string; name: string }[]>([]);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const operation = useRef<(() => boolean) | null>(null);
  const scope = useRef(new SkillActionScope());
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  useFocusEffect(useCallback(() => {
    scope.current.focus();
    operation.current = null;
    setDeleting(false);
    setDialog(null);
    setDeleteError("");
    setRetry((value) => value + 1);
    return () => { scope.current.blur(); operation.current = null; };
  }, []));
  useEffect(() => {
    if (!focused) return;
    let active = true;
    const current = scope.current.current();
    void session.api.getSkill(name).then(
      (value) => {
        if (active && current() && !operation.current) { setDetail(value); setLoadError(""); setLoading(false); }
      },
      (reason: unknown) => {
        if (!active || !current() || operation.current) return;
        if (reason instanceof GatewayError && reason.status === 404) {
          scope.current.blur();
          router.dismissTo("/settings-skills");
          return;
        }
        setLoadError(`无法加载技能：${reason instanceof Error ? reason.message : String(reason)}`);
        setLoading(false);
      },
    );
    return () => { active = false; };
  }, [session, name, revision, retry, focused]);

  const requestDeletion = async () => {
    const current = scope.current.current();
    if (operation.current || !current()) return;
    operation.current = current;
    setDeleting(true);
    setDeleteError("");
    try {
      await preflightSkillDeletion(current,
        () => session.api.getSkill(name),
        (value) => {
          setDetail(value);
          setDeleteUsers(value.used_by);
          setDialog(value.used_by.length ? "blocked" : "confirm");
        },
        () => { scope.current.blur(); operation.current = null; router.dismissTo("/settings-skills"); },
        setDeleteError);
    } finally {
      if (operation.current === current) {
        operation.current = null;
        setDeleting(false);
      }
    }
  };
  const remove = async () => {
    const current = scope.current.current();
    if (operation.current || !current()) return;
    operation.current = current;
    setDeleting(true);
    setDeleteError("");
    try {
      await commitSkillDeletion(current,
        () => session.api.deleteSkill(name),
        (event) => session.skillChanged(event),
        () => { scope.current.blur(); operation.current = null; setDialog(null); router.dismissTo("/settings-skills"); },
        (users) => { setDeleteUsers(users); setDialog("blocked"); },
        setDeleteError);
    } finally {
      if (operation.current === current) {
        operation.current = null;
        setDeleting(false);
      }
    }
  };

  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false, gestureEnabled: !deleting }} />
    <ScreenBar title={detail?.name ?? name} left={<Button testID="skill-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回技能列表")} disabled={deleting} onPress={() => { scope.current.blur(); operation.current = null; router.back(); }}><Icon as={ChevronLeft} className="size-[22px]" /></Button>} />
    <ConnectionBanner session={session} />
    <ScrollView refreshControl={<RefreshControl refreshing={loading && !!detail} onRefresh={() => { setLoading(true); setRetry((value) => value + 1); }} />}
      contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 24 }}>
      {loading && !detail ? <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载技能…")}</Text> : null}
      {loadError ? <View className="mx-6 mt-5 items-center gap-2"><Text className="text-center text-sm text-destructive">{t(loadError)}</Text><Button variant="outline" onPress={() => { setLoading(true); setRetry((value) => value + 1); }}><Text>{t("重试")}</Text></Button></View> : null}
      {detail ? <>
        {detail.description ? <Text className="mx-[22px] mb-3 text-[15px] leading-[22px]">{detail.description}</Text> : null}
        {detail.status === "error" ? <Text testID="skill-detail-error" className="mx-4 mb-3 rounded-[14px] border border-destructive px-3 py-2.5 text-[13px] leading-[18px] text-destructive">{t("无法加载：{error}", { error: t(detail.error || "未知原因") })}</Text> : null}
        <ListGroup>
          <View className="min-h-[52px] flex-row items-center gap-3 px-4 py-3"><Text className="text-[15px]">{t("位置")}</Text><Text selectable className="min-w-0 flex-1 text-right font-mono text-[13px] text-muted-foreground">{detail.path}</Text></View>
          <View className="min-h-[52px] flex-row items-center justify-between gap-3 px-4 py-3"><Text className="text-[15px]">{t("最后修改时间")}</Text><Text className="text-[13px] text-muted-foreground">{detail.mtime === null ? t("不可用") : new Date(detail.mtime * 1000).toLocaleString(locale)}</Text></View>
        </ListGroup>
        <ListGroup label={t("使用它的 Agent")}>
          {detail.used_by.length ? detail.used_by.map((agent) => {
            const avatar = session.agents.agents.find((item) => item.id === agent.id)?.avatar;
            return <Pressable key={agent.id} testID={`skill-agent-${agent.id}`} accessibilityRole="button" accessibilityLabel={t("打开 {name} 资料", { name: agent.name })}
              onPress={() => { scope.current.blur(); operation.current = null; setDialog(null); router.push({ pathname: "/agents/[id]", params: { id: agent.id } }); }} className="min-h-[60px] flex-row items-center gap-3 px-4 py-2 active:bg-muted">
              {avatar === undefined
                ? <View className="size-7 items-center justify-center rounded-full bg-muted"><Icon as={UserRound} className="size-4" /></View>
                : <WandrunAvatar index={avatar} alt={agent.name} size={28} />}
              <Text className="min-w-0 flex-1 text-[15px]" numberOfLines={1}>{agent.name}</Text><Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />
            </Pressable>;
          }) : <Text className="px-4 py-4 text-sm text-muted-foreground">{t("没有 Agent 使用这个技能")}</Text>}
        </ListGroup>
        <Text className="mx-8 mt-3 text-xs leading-[18px] text-muted-foreground">{t("SSH Agent 需重启网关后才能选择新技能或使用已选技能的更新。")}</Text>
        <Text className="mx-8 mb-2 mt-5 text-[13px] text-muted-foreground">SKILL.md</Text>
        <View testID="skill-content" className="mx-[22px]">{detail.content !== null ? <AgentMemoryMarkdown content={skillMarkdown(detail)!} /> : <Text className="text-sm text-muted-foreground">{t("SKILL.md 不可读取；请检查上方错误原因。")}</Text>}</View>
        <View className="min-h-7 flex-1" />
        {deleteError && !dialog ? <Text testID="skill-delete-error" className="mx-6 text-center text-sm text-destructive">{t(deleteError)}</Text> : null}
        <Button testID="skill-delete" variant="ghost" className="self-center bg-transparent" disabled={deleting} onPress={() => void requestDeletion()}><Text className="font-normal text-destructive">{t("删除技能")}</Text></Button>
      </> : null}
    </ScrollView>
    <AlertDialog open={focused && dialog !== null} onOpenChange={(open) => { if (!open && !operation.current) setDialog(null); }}>
      <AlertDialogContent overlayClassName="justify-end p-0" className="w-full rounded-b-none rounded-t-[24px] border-border bg-card" style={{ paddingBottom: insets.bottom + 20 }}>
        <View className="h-1 w-9 self-center rounded-full bg-border" />
        {dialog === "blocked" ? <>
          <AlertDialogHeader><AlertDialogTitle>{t("现在不能删除")}</AlertDialogTitle><AlertDialogDescription>{t("技能仍被 {names} 使用。先在对应 Agent 编辑里取消勾选，再删除技能。", { names: deleteUsers.map((user) => user.name).join("、") || "Agent" })}</AlertDialogDescription></AlertDialogHeader>
          <Button testID="skill-delete-blocked" variant="outline" className="border-foreground bg-card" onPress={() => setDialog(null)}><Text>{t("知道了")}</Text></Button>
        </> : <>
          <AlertDialogHeader><AlertDialogTitle>{t("删除{name}？", { name: detail?.name ?? name })}</AlertDialogTitle><AlertDialogDescription>{t("技能目录及其中的文件会被删除，无法恢复。只有不再被 Agent 使用时才能删除。")}</AlertDialogDescription></AlertDialogHeader>
          {deleteError ? <Text testID="skill-delete-error" className="text-sm text-destructive">{t(deleteError)}</Text> : null}
          <AlertDialogFooter className="flex-col-reverse gap-2">
            <AlertDialogCancel testID="skill-delete-cancel" disabled={deleting} className="border-foreground bg-card"><Text>{t("取消")}</Text></AlertDialogCancel>
            <Button testID="skill-delete-confirm" variant="outline" disabled={deleting} className="border-destructive bg-card" onPress={() => void remove()}><Text className="text-destructive">{deleting ? t("删除中…") : t("删除")}</Text></Button>
          </AlertDialogFooter>
        </>}
      </AlertDialogContent>
    </AlertDialog>
  </View>;
}
