import { Redirect, router, Stack, useFocusEffect } from "expo-router";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListGroup } from "@/components/list-group.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { BuiltinSkill, Skill } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";
import { useBuiltinSkillCatalog, useSkillCatalog } from "@/lib/skill-catalog.ts";
import { importSkillDraft, openSkillImport, SkillActionScope } from "@/lib/skills.ts";
import { acquireUploadDraft } from "@/lib/upload-drafts.ts";

export default function SettingsSkillsRoute() {
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <SkillsList session={session} />;
}

function SkillsList({ session }: { session: ChatSession }) {
  const { t } = useTranslation();
  const catalog = useSkillCatalog(session);
  const builtins = useBuiltinSkillCatalog(session);
  const { refresh } = catalog;
  const { refresh: refreshBuiltins } = builtins;
  const insets = useSafeAreaInsets();
  const scope = useRef(new SkillActionScope());
  const opening = useRef<(() => boolean) | null>(null);
  const [busy, setBusy] = useState(false);
  useFocusEffect(useCallback(() => {
    scope.current.focus();
    setBusy(false);
    refresh();
    refreshBuiltins();
    return () => { scope.current.blur(); opening.current = null; };
  }, [refresh, refreshBuiltins]));

  const importSkill = async () => {
    const current = scope.current.current();
    if (!current() || opening.current || !catalog.loaded) return;
    const agentId = catalog.defaultAgentId;
    if (!agentId) {
      Alert.alert(t("无法导入技能"), t("当前没有默认入口 Agent。请先在电脑上配置默认入口。"));
      return;
    }
    opening.current = current;
    setBusy(true);
    try {
      await openSkillImport(current,
        () => session.blankConversation(agentId),
        (id) => {
          const { controller, release } = acquireUploadDraft(session.api, id, () => {});
          try {
            if (!controller.ready || controller.error) throw new Error(controller.error || "无法读取对话草稿");
            controller.setText(importSkillDraft(controller.draft.text));
            if (controller.error) throw new Error(controller.error);
          } finally {
            release();
          }
        },
        (id) => { scope.current.blur(); opening.current = null; router.push({ pathname: "/c/[id]", params: { id } }); },
        (message) => Alert.alert(t("无法导入技能"), t(message)));
    } finally {
      if (opening.current === current) {
        opening.current = null;
        setBusy(false);
      }
    }
  };

  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={t("技能")} left={<Button testID="skills-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回设置")} onPress={() => { scope.current.blur(); opening.current = null; router.back(); }}><Icon as={ChevronLeft} className="size-[22px]" /></Button>}
      right={<Button testID="skills-add" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("导入技能")} disabled={busy || !catalog.loaded} onPress={() => void importSkill()}><Icon as={Plus} className="size-[22px]" /></Button>} />
    <ConnectionBanner session={session} />
    <ScrollView refreshControl={<RefreshControl refreshing={catalog.refreshing || builtins.refreshing} onRefresh={() => { refresh(); refreshBuiltins(); }} />} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      {builtins.skills.length ? <ListGroup label={t("系统内置")}>{builtins.skills.map((skill) => <BuiltinSkillRow key={skill.name} skill={skill} onOpen={() => { scope.current.blur(); opening.current = null; router.push({ pathname: "/builtin-skill-detail", params: { name: skill.name } }); }} />)}</ListGroup> : null}
      {!builtins.loaded && !builtins.error ? <Text className="mx-8 mt-5 text-sm text-muted-foreground">{t("正在加载系统内置技能…")}</Text> : null}
      {builtins.error ? <View className="mx-6 mt-5 items-center gap-2"><Text className="text-center text-sm text-destructive">{t(builtins.error)}</Text><Button variant="outline" onPress={refreshBuiltins}><Text>{t("重试")}</Text></Button></View> : null}
      {catalog.skills.length ? <ListGroup label={t("我的技能")}>{catalog.skills.map((skill) => <SkillRow key={skill.name} skill={skill} onOpen={() => { scope.current.blur(); opening.current = null; router.push({ pathname: "/skill-detail", params: { name: skill.name } }); }} />)}</ListGroup> : null}
      {catalog.loaded && !catalog.skills.length ? <Text className="mx-8 mt-5 text-center text-sm text-muted-foreground">{t("暂无技能，点右上角 ＋ 添加。")}</Text> : null}
      {!catalog.loaded && !catalog.error ? <Text className="mx-8 mt-8 text-center text-sm text-muted-foreground">{t("正在加载我的技能…")}</Text> : null}
      {catalog.error ? <View className="mx-6 mt-5 items-center gap-2"><Text className="text-center text-sm text-destructive">{t(catalog.error)}</Text><Button variant="outline" onPress={refresh}><Text>{t("重试")}</Text></Button></View> : null}
      <Text className="mx-8 mt-4 text-xs leading-[18px] text-muted-foreground">{t("内置技能随系统能力自动加载；我的技能需在 Agent 编辑中选择。")}</Text>
    </ScrollView>
  </View>;
}

function SkillRow({ skill, onOpen }: { skill: Skill; onOpen: () => void }) {
  const { t } = useTranslation();
  const failed = skill.status === "error";
  return <Pressable testID={`skill-${skill.name}`} accessibilityRole="button" accessibilityLabel={`${skill.name}，${failed ? t("无法加载：{reason}", { reason: skill.error || t("未知原因") }) : skill.description}`}
    onPress={onOpen}
    className="min-h-[68px] flex-row items-center gap-3 px-4 py-2.5 active:bg-muted">
    <View className="min-w-0 flex-1 gap-0.5">
      <Text className="text-[17px] font-medium" numberOfLines={1}>{skill.name}</Text>
      {failed ? <Text testID={`skill-error-${skill.name}`} className="text-[13px] leading-[18px] text-destructive" numberOfLines={3}>{t("无法加载：{reason}", { reason: skill.error || t("未知原因") })}</Text>
        : <Text className="text-[13px] leading-[18px] text-muted-foreground" numberOfLines={2}>{skill.description}</Text>}
    </View>
    <Text testID={`skill-status-${skill.name}`} className={`text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}>{skill.used_by.length ? t("{count} 个 Agent 使用", { count: skill.used_by.length }) : t("未使用")}</Text>
    <Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />
  </Pressable>;
}

function BuiltinSkillRow({ skill, onOpen }: { skill: BuiltinSkill; onOpen: () => void }) {
  const { t } = useTranslation();
  return <Pressable testID={`builtin-skill-${skill.name}`} accessibilityRole="button" accessibilityLabel={t("内置技能 {name}，{description}", { name: skill.name, description: skill.description })}
    onPress={onOpen} className="min-h-[68px] flex-row items-center gap-3 px-4 py-2.5 active:bg-muted">
    <View className="min-w-0 flex-1 gap-0.5">
      <Text className="text-[17px] font-medium" numberOfLines={1}>{skill.name}</Text>
      <Text className="text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>{skill.description}</Text>
    </View>
    <Text className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t("内置")}</Text>
    <Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />
  </Pressable>;
}
