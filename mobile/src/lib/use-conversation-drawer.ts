import { t } from "./i18n.ts";
import { router } from "expo-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import type { DrawerConversation } from "@/components/chat/conversation-drawer.tsx";
import type { ChatSession, TaskView } from "@/gateway/session.ts";
import { DrawerFlow } from "@/lib/drawer-flow.ts";
import { switchConversation } from "@/lib/conversation-navigation.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";

/**
 * 聊天页对话列表抽屉：把 DrawerFlow（切换与防重）接到会话、路由和 React state。
 * 聊天页以 id 为 key；切换会同时清除旧消息定位，整页重建，抽屉状态随之重置。
 * 卸载、失焦或会话来源变化时销毁旧 Flow；交互读取当前 owner，动画结算保留发起关闭的 owner。
 */
export function useConversationDrawer(session: ChatSession | null, currentId: string, agentId: string | undefined, focused: boolean) {
  const owner = useMemo(() => ({ session, currentId, agentId, focused }), [session, currentId, agentId, focused]);
  const flowRef = useRef<{ owner: typeof owner; flow: DrawerFlow } | null>(null);
  const [view, setView] = useState<{ owner: typeof owner; open: boolean; onClosed(): void } | null>(null);
  useEffect(() => {
    if (session?.connection === "open" && agentId && focused) void session.refreshCollaborations(agentId);
  }, [session, agentId, focused, session?.connection]);
  // 提交时先替换 owner，避免界面可交互时仍绑定旧 Flow；Strict Mode 重放也创建全新实例。
  useLayoutEffect(() => {
    if (!focused) return;
    const { session, currentId, agentId } = owner;
    const next = new DrawerFlow({
      currentId,
      blankConversation: () =>
        session && agentId !== undefined ? session.blankConversation(agentId) : Promise.reject(new Error(t("对话还没加载"))),
      hasConversation: (id) => !!session?.chat(id),
      navigate: (id) => switchConversation(id, (params) => router.setParams(params)),
      setOpen: (open) => setView({ owner, open, onClosed: () => next.onClosed() }),
      failed: (error) => Alert.alert(t("无法新建对话"), error instanceof Error ? t(error.message) : String(error)),
    });
    flowRef.current = { owner, flow: next };
    return () => {
      next.dispose();
      flowRef.current = null;
    };
  }, [owner, focused]);

  const currentFlow = () => {
    const current = flowRef.current;
    return focused && current?.owner === owner ? current.flow : null;
  };

  const agents = new Map(session?.agents.agents.map((a) => [a.id, a]));
  const requested = new Set<string>();
  for (const lease of session?.browserTasks.values() ?? []) {
    if (lease.state === "requested") { requested.add(lease.task_id); requested.add(lease.root_id); }
  }
  const taskRow = (task: TaskView, outgoing: boolean): DrawerConversation => {
    const counterpart = outgoing ? task.recipient : task.initiator;
    return {
      id: task.id, title: task.title, kind: "task", updatedAt: task.updated_at,
      running: task.status === "running" || task.status === "waiting",
      unread: task.id !== currentId && (task.unread || task.status === "failed" || task.status === "unavailable" || requested.has(task.id)),
      counterpart: { name: agentDisplayName(session?.agents, counterpart), avatar: agents.get(counterpart)?.avatar ?? 0 },
    };
  };
  const conversations: DrawerConversation[] = session && agentId ? [
    ...session.conversationsOf(agentId).map((c) => ({
      id: c.id, title: c.title, source: c.source, kind: "conversation" as const, updatedAt: c.updated_at,
      running: session.isWorking(c.id),
      unread: c.id !== currentId && (c.unread || c.status === "failed" || requested.has(c.id)),
    })),
    ...[...session.tasks.values()].filter((task) => task.agent_id === agentId).map((task) => taskRow(task, false)),
  ].sort((a, b) => b.updatedAt - a.updatedAt) : [];
  const collaborations = [...session?.tasks.values() ?? []].filter((task) => task.creator_agent_id === agentId)
    .sort((a, b) => b.updated_at - a.updated_at).map((task) => taskRow(task, true));
  const agentName = agentDisplayName(session?.agents, agentId);

  return {
    show: () => {
      if (session && agentId) void session.refreshCollaborations(agentId);
      currentFlow()?.show();
    },
    drawerProps: {
      open: view?.owner === owner && view.open,
      agentName,
      agentId: agentId ?? "",
      conversations,
      collaborations,
      loadError: agentId ? session?.collaborationErrors.get(agentId) : undefined,
      onReload: () => { if (session && agentId) void session.refreshCollaborations(agentId); },
      onRename: (id: string, title: string) => session?.renameConversation(id, title) ?? Promise.resolve(false),
      onDelete: (id: string) => session?.deleteConversation(id) ?? Promise.resolve(false),
      failureMessage: () => session?.notice ?? null,
      currentId,
      onSelect: (id: string) => currentFlow()?.select(id),
      onNewConversation: () => void currentFlow()?.newConversation(),
      onRequestClose: () => currentFlow()?.requestClose(),
      // 动画结算必须回到发起关闭的实例，不能查 ref 转投替换后的 Flow。
      onClosed: () => view?.onClosed(),
    },
  };
}
