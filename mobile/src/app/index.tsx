import { router, Stack, useFocusEffect, useIsFocused } from "expo-router";
import { AlertCircle } from "lucide-react-native";
import { useCallback } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "@/components/empty-state.tsx";
import { LoadingState } from "@/components/loading-state.tsx";
import { ChatHeaderView } from "@/components/chat/chat-header-view.tsx";
import { ChatFade } from "@/components/chat/chat-fade.tsx";
import { CHAT_LAYOUT } from "@/components/chat/chat-surface.ts";
import { ConversationDrawer } from "@/components/chat/conversation-drawer.tsx";
import { StatusBanner } from "@/components/status-banner.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { chatEntryTarget } from "@/lib/conversation-navigation.ts";
import { chatLocation } from "@/lib/chat-route.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useGateway, useSession } from "@/lib/session-context.tsx";
import { useNewConversationStore } from "@/lib/new-conversation-context.tsx";
import { useConversationDrawer } from "@/lib/use-conversation-drawer.ts";
import { useDelayedNotice } from "@/lib/use-delayed-notice.ts";
import { CleanupResultNotice } from "@/components/cleanup-result-notice.tsx";
import { useCleanupResult } from "@/lib/use-cleanup-result.ts";

export default function ChatEntry() {
  const session = useSession();
  const { config, newChatConnectionId } = useGateway();
  return session ? <ChatEntryScreen session={session} lastConversationId={config?.lastConversationId} startNew={config?.connectionId === newChatConnectionId} /> : null;
}

/** Entry chooses a destination, never creates a server resource. */
export function ChatEntryScreen({ session, lastConversationId, startNew = false }: { session: ChatSession; lastConversationId?: string; startNew?: boolean }) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const draft = useNewConversationStore();
  const target = chatEntryTarget(session, lastConversationId, startNew);
  const id = target.type === "conversation" ? target.id : undefined;
  const agentId = target.type === "new" ? target.agentId : undefined;
  const agent = session.agents.agents.find(item => item.id === agentId);
  const drawer = useConversationDrawer(session, undefined, agentId, focused);
  useFocusEffect(useCallback(() => {
    if (id) router.replace(chatLocation(id));
    else if (agentId) {
      draft.restore();
      const state = draft.getSnapshot();
      const selection = state.status === "loading" ? null : state.saved.selection;
      const chosen = selection && selection.computerId === session.api.config.computerId && session.agents.agents.some(item => item.id === selection.agentId) ? selection.agentId : agentId;
      draft.select(session.api.config.computerId!, chosen);
      router.replace(chatLocation());
    }
  }, [id, agentId, draft, session]));
  const unavailable = target.type === "unavailable";
  const showReadError = useDelayedNotice(unavailable ? session.connection === "error" ? "conversations" : "agents" : null);
  const cleanupMessage = useCleanupResult(session, session.connection !== "open" || unavailable, target.type === "empty");
  return <ConversationDrawer {...drawer.drawerProps} onOpen={drawer.show}>
    <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1">
        {target.type === "empty" ? <EmptyState title={t("还没有 Agent")} description={t("新建一个 Agent，就可以和它聊天")}>
          <Button testID="chat-entry-create-agent" intent="soft" onPress={() => { session.editorOperations.beginCreationVisit("agent"); router.push("/agent-editor"); }}><Text>{t("新建 Agent")}</Text></Button>
        </EmptyState> : !unavailable && !agent ? <LoadingState delayMs={500} /> : null}
      </View>
      <ChatFade edge="top" statusBar={insets.top} headerBottom={insets.top + CHAT_LAYOUT.headerHeight} />
      <View pointerEvents="box-none" className="absolute inset-0">
        <ChatHeaderView agent={agent} subtitle={t("新对话")} working={false}
          onOpenConversations={drawer.show} onNewConversation={drawer.newConversation}
          newConversationDisabled={!agent}
          onAgentPress={() => { if (agent) router.push({ pathname: "/agents/[id]", params: { id: agent.id } }); }} />
        {unavailable && showReadError && <View className="absolute inset-x-0" style={{ top: insets.top + CHAT_LAYOUT.bannerTop }}>
          <StatusBanner icon={AlertCircle} accessibilityRole="alert" title={t(session.connection === "error" ? "无法加载对话列表，正在重试…" : "无法加载 Agent，正在重试…")} />
        </View>}
        {cleanupMessage && <View className="absolute inset-x-0" style={{ top: insets.top + CHAT_LAYOUT.bannerTop }}>
          <CleanupResultNotice message={cleanupMessage} />
        </View>}
      </View>
    </View>
  </ConversationDrawer>;
}
