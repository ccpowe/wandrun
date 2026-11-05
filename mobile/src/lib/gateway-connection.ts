export type ConnectionActionState =
  | { status: "idle"; error: string }
  | { status: "rename"; targetId: string; draft: string; error: string }
  | { status: "disconnect"; targetId: string; error: string }
  | { status: "switching"; targetId: string; operationId: string }
  | { status: "saving-name"; targetId: string; draft: string; operationId: string }
  | { status: "disconnecting"; targetId: string; operationId: string };
export type ConnectionActionEvent =
  | { type: "rename-opened"; targetId: string; draft: string }
  | { type: "disconnect-opened"; targetId: string }
  | { type: "name-changed"; draft: string }
  | { type: "invalid-name" }
  | { type: "cancelled" }
  | { type: "switch-started"; targetId: string; operationId: string }
  | { type: "confirmed"; operationId: string }
  | { type: "succeeded" | "failed"; operationId: string };

export function validLocalName(name: string): boolean {
  return Array.from(name.trim()).length <= 64 && !/[\r\n]/.test(name);
}

/** Local persistence continues after leaving. Only the matching visit/operation accepts its result. */
export function connectionActionReducer(state: ConnectionActionState, event: ConnectionActionEvent): ConnectionActionState {
  switch (state.status) {
    case "idle":
      switch (event.type) {
        case "rename-opened": return { status: "rename", targetId: event.targetId, draft: event.draft, error: "" };
        case "disconnect-opened": return { status: "disconnect", targetId: event.targetId, error: "" };
        case "switch-started": return { status: "switching", targetId: event.targetId, operationId: event.operationId };
        default: return state;
      }
    case "rename":
      switch (event.type) {
        case "name-changed": return { ...state, draft: event.draft, error: "" };
        case "invalid-name": return { ...state, error: "备注名须为单行，最多 64 个字符" };
        case "cancelled": return { status: "idle", error: "" };
        case "confirmed": return validLocalName(state.draft)
          ? { status: "saving-name", targetId: state.targetId, draft: state.draft, operationId: event.operationId } : state;
        default: return state;
      }
    case "disconnect":
      switch (event.type) {
        case "cancelled": return { status: "idle", error: "" };
        case "confirmed": return { status: "disconnecting", targetId: state.targetId, operationId: event.operationId };
        default: return state;
      }
    case "switching":
      if (!("operationId" in event) || event.operationId !== state.operationId) return state;
      if (event.type === "succeeded") return { status: "idle", error: "" };
      // The switch-failure text is the page visit's one-time result (useVisitNotice), not reducer state.
      if (event.type === "failed") return { status: "idle", error: "" };
      return state;
    case "saving-name":
      if (!("operationId" in event) || event.operationId !== state.operationId) return state;
      if (event.type === "succeeded") return { status: "idle", error: "" };
      if (event.type === "failed") return { status: "rename", targetId: state.targetId, draft: state.draft, error: "无法保存备注名，请重试。" };
      return state;
    case "disconnecting":
      if (!("operationId" in event) || event.operationId !== state.operationId) return state;
      if (event.type === "succeeded") return { status: "idle", error: "" };
      if (event.type === "failed") return { status: "disconnect", targetId: state.targetId, error: "无法从手机移除服务器记录，请再次断开。" };
      return state;
  }
}

export type ConnectionActionSelection = {
  busy: boolean; dialog: "rename" | "disconnect" | null; targetId?: string; draft: string; error: string;
};

export function selectConnectionAction(state: ConnectionActionState): ConnectionActionSelection {
  const busy = state.status === "switching" || state.status === "saving-name" || state.status === "disconnecting";
  const dialog = state.status === "rename" || state.status === "saving-name" ? "rename"
    : state.status === "disconnect" || state.status === "disconnecting" ? "disconnect" : null;
  return { busy, dialog, targetId: "targetId" in state ? state.targetId : undefined,
    draft: "draft" in state ? state.draft : "", error: "error" in state ? state.error : "" };
}
