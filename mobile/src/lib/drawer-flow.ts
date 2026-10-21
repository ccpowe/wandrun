// 对话列表抽屉的切换、防重与可见性状态：纯 JS，可在 Node 里测试；原生动画仍由组件执行。
//
// 切换 = 先关抽屉，关闭动画结束（onClosed）后再导航到目标对话，所以切换不会打断动画。
// 防重：busy 从“选定目标”（点行 / 点新对话）一直持续到关闭动画结束，期间的再次点击一律忽略
// （同步字段，React state 挡不住连点）。
// 新对话要等创建完成才知道目标；关闭、重开或 dispose 都使旧请求的成功与失败处理失效。
// 共享请求本身不取消，对话已建好时下次“新对话”仍可复用；dispose 后此 Flow 不再调用 host。

export type DrawerHost = {
  /** 当前正在看的对话。 */
  currentId: string;
  /** “新对话”的目标：复用空对话或新建。 */
  blankConversation(): Promise<string>;
  /** 关闭动画结束时，目标是否仍在会话列表中。 */
  hasConversation(id: string): boolean;
  /** 切换到另一个仍存在的对话（只在关闭动画结束后调用）。 */
  navigate(id: string): void;
  setOpen(open: boolean): void;
  /** 新建失败，交给界面提示。 */
  failed(error: unknown): void;
};

export class DrawerFlow {
  private busy = false;
  private disposed = false;
  private epoch = 0;
  private afterClose: (() => void) | null = null;
  private readonly host: DrawerHost;

  constructor(host: DrawerHost) {
    this.host = host;
  }

  /** 永久作废此界面拥有的后续动作；共享的创建请求仍由 session 持有，不取消。 */
  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.afterClose = null;
  }

  show(): void {
    if (this.disposed) return;
    this.epoch++;
    this.busy = false;
    this.afterClose = null;
    this.host.setOpen(true);
  }

  /** 点遮罩 / 系统返回键。 */
  requestClose(): void {
    if (this.disposed) return;
    this.epoch++;
    this.closeThen(null);
  }

  /** 关闭动画结束（由抽屉组件通知）。 */
  onClosed(): void {
    if (this.disposed) return;
    const action = this.afterClose;
    this.afterClose = null;
    this.busy = false;
    action?.();
  }

  select(id: string): void {
    if (this.disposed || this.busy) return;
    this.busy = true;
    this.switchTo(id);
  }

  async newConversation(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    const mine = this.epoch;
    try {
      const target = await this.host.blankConversation();
      if (this.epoch === mine) this.switchTo(target);
    } catch (error) {
      if (this.epoch !== mine) return;
      this.busy = false;
      this.host.failed(error);
    }
  }

  private switchTo(id: string): void {
    this.closeThen(id === this.host.currentId ? null : () => {
      if (this.host.hasConversation(id)) this.host.navigate(id);
    });
  }

  private closeThen(action: (() => void) | null): void {
    this.afterClose = action;
    this.host.setOpen(false);
  }
}

/** 目标关闭不代表覆盖层消失；只有当前代的退出动画完成后才释放底层触摸。 */
export type DrawerTransition = { open: boolean; visible: boolean; generation: number };
export type DrawerTransitionEvent = { type: "target"; open: boolean } | { type: "closed"; generation: number };

export function drawerTransition(state: DrawerTransition, event: DrawerTransitionEvent): DrawerTransition {
  if (event.type === "target") {
    if (state.open === event.open) return state;
    return { open: event.open, visible: true, generation: state.generation + 1 };
  }
  if (state.open || state.generation !== event.generation || !state.visible) return state;
  return { ...state, visible: false };
}
