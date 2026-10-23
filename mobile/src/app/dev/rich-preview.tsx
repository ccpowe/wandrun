import { Redirect, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Uniwind, useUniwind } from "uniwind";

import { AgentMessageContent } from "@/components/chat/agent-message-content.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { richScenarios } from "@/dev/rich-scenarios.ts";
import { GatewayApi, GatewayError } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";

type Submission = { values: Record<string, unknown>; createdAt: string };
type Outcome = "success" | "pending" | "400" | "404" | "409";
// A development-only persisted-coordinate owner exercises the actual authenticated-media
// error path in the link-list scenario without contacting a gateway or the source URL.
const failedLinkMedia = new GatewayApi(
  { baseUrl: "https://preview.invalid", token: "preview", computerId: "preview" },
  async () => Response.json({ error: { code: "media_not_found", message: "Image unavailable" } }, { status: 404 }),
);
const failedLinkOwner = {
  session: { api: failedLinkMedia, subscribe: () => () => {}, uiDraftFor: () => undefined, saveUiDraft: () => {} } as unknown as ChatSession,
  conversationId: "rich-link-preview", messageSeq: 1,
};

export default function RichPreviewRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <RichPreview />;
}

function RichPreview() {
  const insets = useSafeAreaInsets();
  // `?scenario=<id>&bare=1` opens one scenario without the controls, for full-page web screenshots.
  const params = useLocalSearchParams<{ scenario?: string; bare?: string }>();
  const bare = params.bare === "1";
  const [selected, setSelected] = useState(richScenarios.some((item) => item.id === params.scenario) ? params.scenario! : "travel");
  const [generation, setGeneration] = useState(0);
  const [submitted, setSubmitted] = useState<Record<string, Submission>>({});
  const [outcome, setOutcome] = useState<Outcome>("success");
  const { theme, hasAdaptiveThemes } = useUniwind();
  const previousTheme = useRef<"light" | "dark" | "system">(hasAdaptiveThemes ? "system" : theme);
  useEffect(() => {
    const restore = previousTheme.current;
    return () => Uniwind.setTheme(restore);
  }, []);
  const scenario = richScenarios.find((item) => item.id === selected)!;
  const submission = submitted[selected] ?? (scenario.submitted
    ? { values: scenario.state, createdAt: "2026-10-12T10:42:00+08:00" } : undefined);

  return <View className="flex-1 bg-background" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
    {bare ? null : <View className="gap-2 border-b border-border px-4 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-lg font-semibold">富交互消息 · P0/P1/P2</Text>
        <Button size="sm" variant="outline" accessibilityLabel="切换预览主题"
          onPress={() => Uniwind.setTheme(theme === "dark" ? "light" : "dark")}>
          <Text>{theme === "dark" ? "浅色" : "深色"}</Text>
        </Button>
      </View>
      <Text className="text-xs text-muted-foreground">仅开发预览 · 不连接提交 API，不会触发 Agent</Text>
      <View className="flex-row flex-wrap gap-2">
        {richScenarios.map((item) => <Button key={item.id} size="sm" variant="outline"
          className={selected === item.id ? "border-foreground bg-muted" : "border-border"}
          accessibilityLabel={`预览${item.title}`} onPress={() => setSelected(item.id)}>
          <Text>{item.title}</Text>
        </Button>)}
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-xs text-muted-foreground">提交结果：</Text>
        {(["success", "pending", "400", "404", "409"] as const).map((value) => <Button key={value}
          size="sm" variant="outline" className={outcome === value ? "border-foreground" : "border-border"}
          accessibilityLabel={`预览提交${value}`} onPress={() => setOutcome(value)}>
          <Text>{value === "success" ? "成功" : value === "pending" ? "慢提交（5秒）" : value}</Text>
        </Button>)}
        <Button size="sm" variant="ghost" accessibilityLabel="重置预览"
          onPress={() => { setSubmitted({}); setGeneration((value) => value + 1); }}><Text>重置</Text></Button>
      </View>
    </View>}
    <ScrollView key={selected} className="flex-1" keyboardShouldPersistTaps="handled"
      contentContainerClassName="px-4 py-4 pb-20">
      <View className="w-full max-w-[640px] self-center gap-4">
        <Text className="text-xs text-muted-foreground">planner · {scenario.title}</Text>
        <AgentMessageContent key={`${selected}:${generation}`} text={scenario.text}
          ui={scenario.invalid ? [{ block: 0, valid: false }] : scenario.files
            ? scenario.text.split("```wandrun-ui\n").slice(1).map((_, block) => ({ block, valid: true, files: scenario.files }))
            : undefined}
          draftOwner={selected === "link-list-v3" ? failedLinkOwner : undefined}
          attachments={scenario.attachments}
          submissions={submission ? new Map([[0, submission]]) : undefined}
          onSubmit={async (_block, values) => {
            if (outcome === "pending") {
              const { promise, resolve } = Promise.withResolvers<void>();
              setTimeout(resolve, 5000);
              await promise;
            }
            if (outcome !== "success" && outcome !== "pending") {
              const codes = { "400": "ui_invalid_values", "404": "ui_block_not_found", "409": "ui_already_submitted" };
              throw new GatewayError(Number(outcome), codes[outcome], "开发预览错误", { note: "请检查输入内容" });
            }
            setSubmitted((current) => ({ ...current, [selected]: { values, createdAt: new Date().toISOString() } }));
          }} />
        {submission ? <View className="max-w-[90%] self-end rounded-[20px] rounded-br-[6px] bg-primary px-3.5 py-2.5">
          <Text className="text-base text-primary-foreground">{selected === "submitted"
            ? "选择了「莫干山民宿」，补充：想住带院子的，周六下午出发"
            : selected === "weekly-done" ? "周报设置：标准篇幅，来源官方博客和论文，配原帖截图，语气 0.7"
            : "预览提交已记录（仅本页）"}</Text>
        </View> : null}
      </View>
    </ScrollView>
  </View>;
}
