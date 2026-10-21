import { t } from "./i18n.ts";
import { router } from "expo-router";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import type { AgentSummary } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";

/**
 * 进入某个 Agent 的聊天。用哪个对话由 ChatSession.conversationFor 决定（最近对话，没有才新建；
 * 新建时同一 Agent 的重复点击共用一次请求，刚建好的对话立即参与后续决策）。失败时提示。
 * 进行中的重复点击在这里忽略，否则同一个聊天页会被压入两次。
 */
export function useOpenAgentChat(session: ChatSession): (agent: AgentSummary) => Promise<void> {
  const opening = useRef(false);
  return useCallback(
    async (agent) => {
      if (opening.current) return;
      opening.current = true;
      try {
        const id = await session.conversationFor(agent);
        router.push({ pathname: "/c/[id]", params: { id } });
      } catch (error) {
        Alert.alert(t("无法开始对话"), error instanceof Error ? t(error.message) : String(error));
      } finally {
        opening.current = false;
      }
    },
    [session],
  );
}
