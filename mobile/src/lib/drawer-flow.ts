// 对话列表抽屉的切换、防重与可见性状态：纯 JS，可在 Node 里测试。
// 打开时先关闭，真实关闭完成后导航；已关闭时直接导航，不等待不存在的动画。
// busy 从选定目标延续到导航/关闭完成；新建请求在关闭、重开、失效时作废其结果。

export type DrawerHost = {
  /** 当前正在看的对话。 */
  currentId: string;
  /** “新对话”的目标：复用空对话或新建。 */
  blankConversation(): Promise<string>;
  /** 目标导航时，目标是否仍在会话列表中。 */
  hasConversation(id: string): boolean;
  /** 切换到另一个仍存在的对话。 */
  navigate(id: string): void;
  setOpen(open: boolean): void;
  /** 新建失败，交给界面提示。 */
  failed(error: unknown): void;
};

export class DrawerFlow {
  private busy = false;
  private disposed = false;
  private open = false;
  private closing = false;
  private epoch = 0;
  private afterClose: (() => void) | null = null;
  private readonly host: DrawerHost;

  constructor(host: DrawerHost) {
    this.host = host;
  }

  /** 永久作废此界面拥有的后续动作；共享的创建请求仍由 session 持有，不取消。 */
  dispose(): void {
    this.closing = false;
    this.disposed = true;
    this.epoch++;
    this.afterClose = null;
  }

  show(): void {
    if (this.disposed) return;
    this.epoch++;
    this.busy = false;
    this.open = true;
    this.closing = false;
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
    if (this.disposed || !this.closing || this.open) return;
    this.closing = false;
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
    if (!this.open) {
      if (this.closing) {
        this.afterClose = action;
        return;
      }
      this.afterClose = null;
      this.busy = false;
      action?.();
      return;
    }
    this.open = false;
    this.closing = true;
    this.afterClose = action;
    this.host.setOpen(false);
  }
}

