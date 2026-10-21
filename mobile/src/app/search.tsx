import { router, Stack, useLocalSearchParams } from "expo-router";
import { Bot, FileText, MessageSquare, MessagesSquare, Search as SearchIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Keyboard, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FileTypeIcon } from "@/components/file-type-icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { SearchResult } from "@/gateway/api.ts";
import { liveSearchDestination } from "@/lib/conversation-navigation.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";
import { messagePreview } from "@/lib/message-preview.ts";

const PAGE = 30;
const GROUPS = [
  { kind: "agent", title: "Agent", icon: Bot },
  { kind: "conversation", title: "对话", icon: MessagesSquare },
  { kind: "message", title: "消息", icon: MessageSquare },
  { kind: "file", title: "文件", icon: FileText },
] as const;

export default function SearchScreen() {
  const { t } = useTranslation();
  const { agent_id } = useLocalSearchParams<{ agent_id?: string }>();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<{
    scopeKey: string; requestKey: string; results: SearchResult[]; total: number; error: string | null;
  } | null>(null);
  const [page, setPage] = useState(0);
  const [revision, retry] = useState(0);
  const scopeName = session?.agents.agents.find((agent) => agent.id === agent_id)?.name;
  const search = query.trim();
  const scopeKey = `${agent_id ?? ""}\u0000${search}`;
  const requestKey = `${scopeKey}\u0000${page}\u0000${revision}`;
  const current = searchState?.scopeKey === scopeKey ? searchState : null;
  const results = current?.results ?? [];
  const visibleResults = results.filter((result) => liveSearchDestination(result, session) !== null);
  const total = current?.total ?? 0;
  const error = current?.requestKey === requestKey ? current.error : null;
  const loading = Boolean(search && session && current?.requestKey !== requestKey);

  useEffect(() => {
    if (!search || !session) return;
    let active = true;
    const timer = setTimeout(() => {
      void session.api.search(search, agent_id, PAGE, page * PAGE).then((response) => {
        if (!active) return;
        setSearchState((previous) => ({
          scopeKey, requestKey,
          results: page === 0 ? response.results : [...(previous?.scopeKey === scopeKey ? previous.results : []), ...response.results],
          total: response.total, error: null,
        }));
      }).catch((cause: unknown) => {
        if (!active) return;
        setSearchState((previous) => ({
          scopeKey, requestKey,
          results: previous?.scopeKey === scopeKey ? previous.results : [],
          total: previous?.scopeKey === scopeKey ? previous.total : 0,
          error: cause instanceof Error ? cause.message : "搜索失败",
        }));
      });
    }, page === 0 ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [search, agent_id, session, page, scopeKey, requestKey]);

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center gap-2 px-4 pb-3" style={{ paddingTop: insets.top + 12 }}>
        <View className="min-w-0 flex-1">
          <Input testID="search-input" autoFocus placeholder={agent_id ? t("搜索 {name}", { name: scopeName ?? t("此 Agent") }) : t("搜索 Agent、对话、消息、文件")}
            value={query} onChangeText={(value) => { setQuery(value); setPage(0); }} returnKeyType="search" onSubmitEditing={() => Keyboard.dismiss()} />
        </View>
        <Button testID="search-cancel" variant="ghost" onPress={() => router.back()}><Text>{t("取消")}</Text></Button>
      </View>
      {agent_id && <Text className="px-5 pb-2 text-xs text-muted-foreground">{t("仅搜索 {name} 的内容", { name: scopeName ?? t("当前 Agent") })}</Text>}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="px-4 pb-10">
        {!query.trim() ? <View className="items-center gap-2 pt-20"><Icon as={SearchIcon} className="size-9 text-muted-foreground" /><Text className="text-muted-foreground">{t("输入关键词搜索")}</Text></View> : null}
        {GROUPS.map(({ kind, title, icon }) => {
          const group = visibleResults.filter((result) => result.kind === kind);
          if (!group.length) return null;
          return <View key={kind} className="pt-5">
            <Text className="px-1 pb-2 text-sm font-semibold text-muted-foreground">{t(title)} · {group.length}</Text>
            <View className="overflow-hidden rounded-2xl border border-border bg-card">
              {group.map((result, index) => <Pressable key={`${kind}-${result.id}`} testID={`search-result-${kind}-${result.id}`}
                accessibilityRole="button" onPress={() => {
                  const destination = liveSearchDestination(result, session);
                  if (destination) router.push(destination);
                }}
                className={`flex-row items-center gap-3 px-4 py-3 active:bg-muted ${index ? "border-t border-border" : ""}`}>
                {result.kind === "file"
                  ? <FileTypeIcon mediaType={result.file.media_type} className="size-5 text-muted-foreground" />
                  : <Icon as={icon} className="size-5 text-muted-foreground" />}
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="font-medium">{result.title}</Text>
                  {result.kind === "file" && <Text className="text-xs text-muted-foreground">{Math.ceil(result.file.size / 1024)} KB · {result.file.source === "user_upload" ? t("我上传的文件") : result.file.agent_id ? session?.agents.agents.find((agent) => agent.id === result.file.agent_id)?.name ?? t("Agent 暂不可用") : t("Agent 暂不可用")} · {result.file.conversation_id ? session?.conversations.get(result.file.conversation_id)?.title ?? t("来源对话") : t("无来源对话")}</Text>}
                  {result.kind === "message" || result.kind === "agent" ? <Text numberOfLines={2} className="text-sm text-muted-foreground">{result.kind === "message" ? messagePreview(result.text) : result.text}</Text> : null}
                  {result.kind === "conversation" && <Text numberOfLines={1} className="text-xs text-muted-foreground">{t("{name} 的对话", { name: session?.agents.agents.find((agent) => agent.id === result.agent_id)?.name ?? "Agent" })}</Text>}
                  {result.kind === "message" && <Text numberOfLines={1} className="text-xs text-muted-foreground">{session?.agents.agents.find((agent) => agent.id === result.agent_id)?.name ?? "Agent"} · {session?.conversations.get(result.conversation_id)?.title ?? t("来源对话")}</Text>}
                </View>
              </Pressable>)}
            </View>
          </View>;
        })}
        {loading && <ActivityIndicator className="py-6" />}
        {error && <View className="items-center gap-2 py-8"><Text className="text-destructive">{t(error)}</Text><Button variant="outline" onPress={() => retry((value) => value + 1)}><Text>{t("重试")}</Text></Button></View>}
        {!loading && !error && query.trim() && visibleResults.length === 0 && results.length >= total && <Text className="py-16 text-center text-muted-foreground">{t("没有找到相关内容")}</Text>}
        {!loading && !error && results.length < total && <Button testID="search-more" variant="outline" className="mt-5" onPress={() => setPage((value) => value + 1)}><Text>{t("加载更多")}</Text></Button>}
      </ScrollView>
    </View>
  );
}
