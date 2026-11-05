import type { AgentCapability } from "../gateway/api.ts";

export type CapabilityState = { status: "closed" } | { status: "details"; id: string };
export type CapabilityEvent =
  | { type: "open"; id: string }
  | { type: "close" }
  | { type: "revoke"; id: string };
export type CapabilitySelection = {
  enabled: AgentCapability[]; unavailable: AgentCapability[]; selected: AgentCapability | null;
  loading: boolean; empty: boolean; stale: boolean;
  revoke: Extract<CapabilityEvent, { type: "revoke" }> | null;
};

/** Only selection belongs to the page; reads and connection remain external facts. */
export function capabilityReducer(state: CapabilityState, event: CapabilityEvent): CapabilityState {
  switch (state.status) {
    case "closed":
      return event.type === "open" ? { status: "details", id: event.id } : state;
    case "details":
      if (event.type === "close" || event.type === "revoke" && event.id === state.id) return { status: "closed" };
      return state;
  }
}
export function selectCapabilities(state: CapabilityState, capabilities: AgentCapability[] | null, error: string, fetchStatus: string): CapabilitySelection {
  const enabled = capabilities?.filter(item => item.status === "enabled") ?? [];
  const unavailable = capabilities?.filter(item => item.status !== "enabled") ?? [];
  const selected = state.status === "details" ? enabled.find(item => item.id === state.id) ?? null : null;
  return { enabled, unavailable, selected,
    loading: capabilities === null && !error,
    empty: capabilities?.length === 0 && fetchStatus !== "paused" && !error,
    stale: capabilities !== null,
    revoke: state.status === "details" && capabilities !== null && !selected ? { type: "revoke" as const, id: state.id } : null,
  };
}

// Only known gateway descriptions have shorter display copy; preserve other descriptions.
export const capabilityDescriptions: Record<string, string> = {
  "跨对话保留记忆，可在 Agent 资料中编辑。": "跨对话记忆，可在 Agent 资料编辑。",
  "连接器设为“按需搜索”时，Agent 先搜索再加载需要的工具。": "按需连接器先搜索，再加载所需工具。",
  "读写这个 Agent 所在电脑上的文件，相对路径落在当前对话的目录里。": "读写 Agent 电脑的文件；相对路径使用当前对话目录。",
  "在这台电脑上运行命令和脚本，耗时的会转到后台，完成后通知 Agent。": "在电脑上运行命令和脚本；耗时任务后台运行，完成后通知 Agent。",
  "用电脑上的浏览器操作网页，遇到登录等情况请你接管。": "用电脑浏览器操作网页；登录等情况由你接管。",
  "写一段 Python 脚本批量调用工具、处理中间数据。": "用 Python 批量调用工具、处理中间数据。",
  "在消息中显示表单、图表等交互界面。": "消息内的交互表单、图表。",
  "由 Agent 创建定时任务，在 Agent 资料 › 定时中管理。": "Agent 创建定时，在 Agent 资料 › 定时中管理。",
  "生成图片并保存到当前对话的目录。": "生成图片，保存到当前对话目录。",
};
