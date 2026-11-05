import { Brain, UserRound } from "lucide-react-native";
import { View } from "react-native";
import { GroupRow } from "./group-row.tsx";
import { ListGroup } from "./list-group.tsx";
import type { AgentMemory } from "../gateway/api.ts";
import { memoryModified } from "../lib/agent-memory.ts";
import { useTranslation } from "../lib/i18n.ts";

export type AgentMemoryRead = { memory: AgentMemory | null; error: string };
/** Both entries remain navigable; the parent projects the single page error banner. */
export function AgentMemoryTab({ name, work, profile, onWork, onProfile }: {
  name: string; work: AgentMemoryRead; profile: AgentMemoryRead; onWork(): void; onProfile(): void;
}) {
  const { t } = useTranslation();
  const summary = ({ memory, error }: AgentMemoryRead, shared: boolean) => {
    if (!memory) return error ? t("暂不可用") : t("加载中…");
    if (!memory.content) return t("还没有内容");
    return memoryModified(memory, shared ? undefined : name) ?? t("已有内容");
  };
  return <View className="flex-1 pb-8"><ListGroup className="mt-5">
    <GroupRow testID="profile-work-memory" icon={Brain} title={t("{name}的记忆", { name })} description={summary(work, false)} affordance="navigate" onPress={onWork} />
    <GroupRow testID="profile-about-you" icon={UserRound} title={t("关于你")} description={t("所有 Agent 共用 · {summary}", { summary: summary(profile, true) })} affordance="navigate" onPress={onProfile} />
  </ListGroup></View>;
}
