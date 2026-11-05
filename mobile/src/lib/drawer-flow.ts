// Drawer owns closing/navigation only. New-chat creation belongs to the user's first send/attachment.
export type DrawerHost = {
  hasConversation(id: string): boolean;
  dismissKeyboard(): Promise<void>;
  navigate(id: string): void;
};
export type DrawerCloseTicket = Readonly<{ complete(): void }>;
export type DrawerSnapshot = Readonly<{
  open: boolean; closing: boolean; closeTicket: DrawerCloseTicket | null; drawerVisit: object;
}>;

export class DrawerFlow {
  private busy = false;
  private active = true;
  private navigationEpoch = 0;
  private afterClose: (() => void) | null = null;
  private snapshot: DrawerSnapshot;
  private listeners = new Set<() => void>();
  private readonly host: DrawerHost;
  constructor(host: DrawerHost, initialOpen = false) {
    this.host = host;
    this.snapshot = { open: initialOpen, closing: false, closeTicket: null, drawerVisit: {} };
  }
  getSnapshot = (): DrawerSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(next: DrawerSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  activate(initialOpen = false): void { this.active = true; if (initialOpen) this.show(); }
  deactivate(): void { this.active = false; this.reset(); }
  /** A different target cancels its close ticket without ending this route's focus. */
  reset(): void {
    this.navigationEpoch++;
    this.busy = false;
    this.afterClose = null;
    this.publish({ ...this.snapshot, open: false, closing: false, closeTicket: null });
  }
  show(): void {
    if (!this.active) return;
    this.navigationEpoch++;
    this.busy = false;
    this.afterClose = null;
    this.publish({ ...this.snapshot, open: true, closing: false, closeTicket: null, drawerVisit: {} });
  }
  requestClose(): void {
    if (!this.active) return;
    this.afterClose = null;
    if (!this.snapshot.closing) this.closeThen(null);
  }
  private complete(ticket: DrawerCloseTicket): void {
    if (!this.active || this.snapshot.closeTicket !== ticket || !this.snapshot.closing) return;
    const action = this.afterClose;
    this.afterClose = null;
    this.busy = action !== null;
    this.publish({ ...this.snapshot, closing: false, closeTicket: null });
    this.navigateAfterKeyboard(action);
  }
  select(id: string, currentId: string | undefined): void {
    if (!this.active || this.busy) return;
    this.busy = true;
    this.closeThen(id === currentId ? null : () => {
      if (this.host.hasConversation(id)) this.host.navigate(id);
      else this.busy = false;
    });
  }
  newConversation(openNew: () => void): void {
    if (!this.active || this.busy) return;
    this.busy = true;
    this.closeThen(openNew);
  }
  private navigateAfterKeyboard(action: (() => void) | null): void {
    if (!action) return;
    const epoch = ++this.navigationEpoch;
    void this.host.dismissKeyboard().then(() => {
      if (this.active && this.navigationEpoch === epoch) action();
    });
  }
  private closeThen(action: (() => void) | null): void {
    if (!this.snapshot.open) {
      if (this.snapshot.closing) { this.afterClose = action; return; }
      this.afterClose = null;
      this.busy = action !== null;
      this.navigateAfterKeyboard(action);
      return;
    }
    const ticket: DrawerCloseTicket = Object.freeze({ complete: () => this.complete(ticket) });
    this.afterClose = action;
    this.publish({ ...this.snapshot, open: false, closing: true, closeTicket: ticket });
  }
}

/** The library reports only a direction. Capture the ticket at start, never read the latest owner at end. */
export class DrawerTransition {
  private ticket: DrawerCloseTicket | null = null;
  start(closing: boolean, ticket: DrawerCloseTicket | null): void { this.ticket = closing ? ticket : null; }
  end(closing: boolean): void {
    if (!closing) return;
    const ticket = this.ticket;
    this.ticket = null;
    ticket?.complete();
  }
  cancel(): void { this.ticket = null; }
}
