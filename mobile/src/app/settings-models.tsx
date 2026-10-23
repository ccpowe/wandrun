import { Redirect, router, Stack } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, View } from "react-native";

import { ListGroup } from "@/components/list-group.tsx";
import { ModelPicker } from "@/components/model-picker.tsx";
import { ModelSubscription } from "@/components/model-subscription.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import type { AgentUsage, AgentUsageReport, ModelSettings } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { agentUsageView } from "@/lib/agent-usage-view.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { modelName, reasoningOptions, selectedModel } from "@/lib/model-selection.ts";
import { agentTokens, formatTokens, lastSubscriptionUsage, loadSubscriptionUsage } from "@/lib/model-usage.ts";
import { useSession } from "@/lib/session-context.tsx";
import { useMinuteClock } from "@/lib/use-minute-clock.ts";

export default function SettingsModels() {
  const session = useSession();
  if (!session) return <Redirect href="/settings" />;
  return <ModelsScreen key={JSON.stringify(session.api.config)} session={session} />;
}

function ModelsScreen({ session }: { session: ChatSession }) {
  const { t } = useTranslation();
  const api = session.api;
  const now = useMinuteClock();
  const { catalog } = useModelCatalog(api, false);
  const [subscription, setSubscription] = useState(() => lastSubscriptionUsage(api));
  const [agentUsage, setAgentUsage] = useState<AgentUsageReport | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [draft, setDraft] = useState<ModelSettings | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    // Authentication and quota have separate freshness; a stale quota cannot authenticate this session.
    void loadSubscriptionUsage(api, true).then((value) => { if (active) setSubscription(value); });
    void api.getAgentUsage(7).then(
      (value) => { if (active) { setAgentUsage(value); setUsageError(false); } },
      () => { if (active) setUsageError(true); },
    );
    void api.getSettings().then(
      (value) => { if (active) { setSettings(value); setSettingsError(""); } },
      () => { if (active) setSettingsError("暂时无法获取默认模型"); },
    );
    return () => { active = false; };
  }, [api, retry]);

  useEffect(() => {
    if (!selecting) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!saving) setSelecting(false);
      return true;
    });
    return () => subscription.remove();
  }, [selecting, saving]);

  const onSave = async () => {
    if (!draft?.default_model || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const updated = await api.updateSettings(draft);
      setSettings(updated);
      setSelecting(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const usageView = agentUsageView(session.agents.loaded, session.agents.agents, agentUsage, usageError);
  let maximum = 1;
  if (usageView.kind === "rows") {
    for (const { item } of usageView.rows) maximum = Math.max(maximum, agentTokens(item));
  }
  const recheckSubscription = () => {
    void loadSubscriptionUsage(api, true).then(setSubscription);
  };
  const defaultModel = selectedModel(catalog?.models ?? [], settings?.default_model ?? "");
  const defaultEffort = settings?.default_reasoning_effort ?? defaultModel?.default_reasoning_effort;
  const effortLabel = reasoningOptions(defaultModel).find(({ value }) => value === defaultEffort)?.label ?? defaultEffort;

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenBar
        title={selecting ? t("默认模型") : t("模型")}
        left={<Button testID={selecting ? "settings-model-back" : "settings-models-back"} variant="ghost" size="icon" className="bg-transparent" aria-label={t("返回")} onPress={() => selecting ? setSelecting(false) : router.back()}><Icon as={ChevronLeft} className="size-[22px]" /></Button>}
        right={selecting ? <Button testID="settings-model-save" size="sm" variant="outline" className="border-foreground" disabled={!draft?.default_model || saving} onPress={() => void onSave()}><Text>{t("完成")}</Text></Button> : undefined}
      />
      {selecting && draft ? (
        <>
          {saveError ? <Text className="mx-5 mb-2 text-sm text-destructive">{t(saveError)}</Text> : null}
          <ModelPicker
            api={api}
            model={draft.default_model ?? ""}
            reasoningEffort={draft.default_reasoning_effort}
            onChange={({ model, reasoning_effort }) => { setDraft({ default_model: model, default_reasoning_effort: reasoning_effort }); setSaveError(""); }}
            disabled={saving}
          />
        </>
      ) : (
        <ScrollView contentContainerClassName="pb-10">
          <ModelSubscription view={subscription} nowSeconds={now.getTime() / 1000} onRecheck={recheckSubscription} />
          <View className="h-3" />
          <ListGroup>
            <Pressable testID="settings-model-default" disabled={!settings} onPress={() => { setDraft(settings); setSaveError(""); setSelecting(true); }} className="min-h-[60px] flex-row items-center gap-2 px-4 active:bg-accent">
              <Text className="min-w-0 flex-1 text-[15px]">{t("新建 Agent 默认模型")}</Text>
              <Text className="max-w-[48%] text-[13px] text-muted-foreground" numberOfLines={1}>{settings ? `${settings.default_model ? modelName(catalog?.models ?? [], settings.default_model) : t("未设置")}${effortLabel ? ` · ${t(effortLabel)}` : ""}` : settingsError ? t(settingsError) : t("正在加载…")}</Text>
              <Icon as={ChevronRight} className="size-4 text-muted-foreground" />
            </Pressable>
          </ListGroup>
          {settingsError ? <Button variant="ghost" size="sm" className="self-center" onPress={() => setRetry((n) => n + 1)}><Text>{t("重试")}</Text></Button> : null}
          <View testID="settings-usage">
            <Text className="px-8 pb-2 pt-5 text-[13px] leading-[18px] text-muted-foreground">{t("最近 7 天用量（按 Agent）")}</Text>
            <View className="mx-4 overflow-hidden rounded-md border border-border bg-card">
              {usageView.kind === "rows" ? usageView.rows.map(({ item, agent }, index) =>
                <AgentUsageRow key={item.agent_id} item={item} name={agent.name} avatar={agent.avatar} percent={agentTokens(item) / maximum * 100} first={index === 0} />
              ) : <Text className="px-4 py-4 text-[13px] text-muted-foreground">{
                usageView.kind === "loading-agents" ? t("正在加载 Agent 列表…")
                  : usageView.kind === "no-agents" ? t("还没有 Agent")
                    : usageView.kind === "no-usage" ? t("最近 7 天暂无用量")
                      : usageView.kind === "usage-error" ? t("暂时无法获取最近 7 天用量")
                        : t("正在加载用量…")
              }</Text>}
            </View>
          </View>
          <Text className="mx-8 mt-2.5 text-xs leading-[18px] text-muted-foreground">{t("单个 Agent 的模型和推理强度请在其编辑页设置。")}</Text>
        </ScrollView>
      )}
    </View>
  );
}

function AgentUsageRow({ item, name, avatar, percent, first }: { item: AgentUsage; name: string; avatar: number; percent: number; first: boolean }) {
  return <View testID={`settings-usage-${item.agent_id}`} className={`px-4 py-3 ${first ? "" : "border-t border-border"}`}>
    <View className="flex-row items-center gap-2.5">
      <WandrunAvatar index={avatar} alt={name} size={28} className="border border-border" />
      <Text className="min-w-0 flex-1 text-[15px]" numberOfLines={1}>{name}</Text>
      <Text className="text-[13px] text-muted-foreground">{formatTokens(agentTokens(item))} tokens</Text>
    </View>
    <View className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><View className="h-full rounded-full bg-foreground" style={{ width: `${percent}%` }} /></View>
  </View>;
}
