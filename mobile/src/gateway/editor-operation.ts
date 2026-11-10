import { GatewayError, createResultUnknown, type GatewayApi, type GatewayEvent } from './api.ts';
import { retryDelay } from '../lib/load-state.ts';

export type EditorIntent = {
  operationId: string;
  resource: 'agent' | 'schedule' | 'settings' | 'connector' | 'browser'; id?: string;
  action: 'save' | 'delete' | 'authorize' | 'callback' | 'cancel-authorization' | 'disconnect' | 'test'; clientId?: string;
  fields?: Record<string, unknown>;
  /** Last confirmed fields, used only to describe read-back differences; never restored as a draft. */
  baseline?: Record<string, unknown>;
};
export type EditorOperation = EditorIntent & {
  status: 'pending' | 'unknown' | 'confirmed' | 'synced' | 'failed';
  error: string; value?: unknown; reconciled: boolean;
};

/** Session-owned write outcomes survive route removal. Recovery reads only; creations require an exact receipt.
 * Page reducers initiate one run from an event handler and share its stable operationId with this owner.
 * This owner keeps tracking after the page leaves; focus/navigation are exclusively the page's responsibility.
 * No editor draft is retained. Fields/baseline support read-back comparison only, never form recovery.
 */
export class EditorOperations {
  private operations = new Map<string, EditorOperation>();
  /** Unknown connector creations outlive their visit's :new alias, without blocking the next blank form. */
  private connectorCreations = new Set<EditorOperation>();
  private connectorReads = new AbortController();
  private reads = new Set<EditorOperation>();
  private deadlines = new Set<ReturnType<typeof setTimeout>>();
  private timers = new Map<EditorOperation, ReturnType<typeof setTimeout>>();
  private closed = false;
  private readonly api: GatewayApi;
  private readonly online: () => boolean;
  /** A terminal receipt may additionally invalidate its resource; notification timing is unchanged. */
  private readonly changed: (receipt?: Readonly<EditorOperation>) => void;
  constructor(api: GatewayApi, online: () => boolean, changed: (receipt?: Readonly<EditorOperation>) => void) {
    this.api = api; this.online = online; this.changed = changed;
  }
  get(key: string): EditorOperation | undefined { return this.operations.get(key); }
  /** New connector visits detach unknown work; other editors keep their existing unresolved-slot behavior. */
  beginCreationVisit(resource: EditorIntent['resource']): void {
    const key = `${resource}:new`;
    const operation = this.get(key);
    if (!operation || operation.status === 'pending' || operation.status === 'unknown' && resource !== 'connector') return;
    this.operations.delete(key);
    this.changed();
  }
  /** The destination route acknowledges exactly the creation it received; newer work must not be consumed. */
  handoffCreation(resource: EditorIntent['resource'], expectedOperationId: string, expectedResourceId: string): void {
    const key = `${resource}:new`;
    const operation = this.get(key);
    if (!operation?.reconciled || operation.operationId !== expectedOperationId || operation.id !== expectedResourceId
      || this.get(`${resource}:${expectedResourceId}`) !== operation) return;
    this.operations.delete(key);
    this.changed();
  }
  async run<T>(key: string, intent: EditorIntent, write: () => Promise<T>): Promise<T | null> {
    const previous = this.get(key);
    if (this.closed || !this.online() || previous?.status === 'pending' || previous?.status === 'unknown') return null;
    const operation: EditorOperation = { ...intent, status: 'pending', error: '', reconciled: false };
    this.operations.set(key, operation);
    const connectorCreation = intent.resource === 'connector' && intent.action === 'save' && !intent.id && !!intent.clientId;
    if (connectorCreation) this.connectorCreations.add(operation);
    this.changed();
    const deadline = Promise.withResolvers<never>();
    // Connector open+cleanup readiness (50s), optional challenge probe (15s), final cleanup (20s), plus margin.
    // The catalog lock has no total deadline; expiry still means unknown and is recovered by exact client_id.
    // Testing an existing owner can additionally retire it (20s), reopen (50s), then list tools (30s).
    // Management cleanup owns up to 25s; leave response/commit margin before declaring an unknown write.
    const management = intent.resource === 'agent' && (intent.action === 'delete' || intent.fields?.environment !== undefined);
    const timeout = management ? 35_000 : connectorCreation ? 90_000 : intent.resource === 'connector' && intent.action === 'test' ? 120_000 : 15_000;
    const timer = setTimeout(() => deadline.reject(new GatewayError(0, 'timeout', '操作结果未确认')), timeout);
    this.deadlines.add(timer);
    try {
      const value = await Promise.race([write(), deadline.promise]);
      if (this.closed || this.get(key) !== operation) return null;
      operation.status = 'confirmed';
      // A start response contains a visit-local URL/code, not a recoverable resource snapshot.
      operation.value = intent.action === 'authorize' ? undefined : value;
      this.connectorCreations.delete(operation);
      this.changed(operation);
      return value;
    } catch (reason) {
      if (this.closed || this.get(key) !== operation) return null;
      // An exact receipt identifies a creation; reading the created resource still belongs to recovery.
      // Agent and default-setting model validation both refuse before persistence.
      const rejectedBeforeWrite = (operation.resource === 'agent' || operation.resource === 'settings') && operation.action === 'save'
        && reason instanceof GatewayError && reason.status === 503 && reason.code === 'model_catalog_unavailable'
        || operation.resource === 'connector' && operation.action === 'save' && !operation.id && !!operation.clientId
          && reason instanceof GatewayError && reason.status === 502 && reason.code === 'connection_failed';
      const unknown = !rejectedBeforeWrite && (createResultUnknown(reason) || (reason instanceof GatewayError && reason.status === 408));
      operation.status = unknown ? 'unknown' : 'failed';
      operation.error = reason instanceof Error ? reason.message : String(reason);
      if (!unknown) this.connectorCreations.delete(operation);
      this.changed();
      if (unknown) void this.reconcile(key, operation);
      throw reason;
    } finally { clearTimeout(timer); this.deadlines.delete(timer); }
  }
  private bindConnectorCreation(operation: EditorOperation, id: string): void {
    operation.id = id;
    const alias = `connector:${id}`;
    if (!this.operations.has(alias)) this.operations.set(alias, operation);
    this.changed();
  }
  observe(event: GatewayEvent): void {
    if (this.closed || event.type !== 'resource.changed') return;
    for (const [key, operation] of this.operations) {
      if (this.connectorCreations.has(operation)) continue;
      if (operation.resource !== event.data.kind || !['pending', 'unknown'].includes(operation.status)) continue;
      if (operation.clientId && key !== `${operation.resource}:new`) continue;
      if (operation.clientId && event.client_id === operation.clientId && event.data.op === 'created') {
        operation.id = String(event.data.id);
        const alias = `${operation.resource}:${operation.id}`;
        if (!this.operations.has(alias)) this.operations.set(alias, operation);
        this.changed();
        if (operation.status === 'unknown') void this.reconcile(key, operation);
      } else if (operation.id === event.data.id && operation.status === 'unknown') void this.reconcile(key, operation);
    }
    if (event.data.kind === 'connector') for (const operation of this.connectorCreations) {
      if (!['pending', 'unknown'].includes(operation.status)) continue;
      if (event.client_id === operation.clientId && ['created', 'bound'].includes(String(event.data.op))) {
        this.bindConnectorCreation(operation, String(event.data.id));
        if (operation.status === 'unknown') void this.reconcile('connector:new', operation);
      } else if (operation.id === event.data.id && operation.status === 'unknown') void this.reconcile('connector:new', operation);
    }
  }
  recover(): void {
    for (const [key, operation] of this.operations) if (operation.status === 'unknown' && !this.connectorCreations.has(operation)) void this.reconcile(key, operation);
    for (const operation of this.connectorCreations) if (operation.status === 'unknown') void this.reconcile('connector:new', operation);
  }
  private async reconcile(key: string, operation: EditorOperation, failures = 0): Promise<void> {
    if (this.closed || !this.online() || (!operation.id && operation.resource !== 'settings' && !this.connectorCreations.has(operation)) || operation.status !== 'unknown' || this.reads.has(operation)) return;
    clearTimeout(this.timers.get(operation));
    this.timers.delete(operation);
    this.reads.add(operation);
    let readingResource = !!operation.id || operation.resource === 'settings';
    try {
      if (this.connectorCreations.has(operation) && !operation.id) {
        const result = await this.api.getConnectorCreationResult(operation.clientId!, this.connectorReads.signal);
        if (this.closed || !this.connectorCreations.has(operation) || operation.status !== 'unknown') return;
        // A concurrent exact SSE receipt is stronger than an earlier pending/absent lookup.
        if (!operation.id) {
          if (result.status === 'created') {
            if (result.event.client_id !== operation.clientId || result.event.data.kind !== 'connector'
              || !['created', 'bound'].includes(String(result.event.data.op)) || result.event.data.id !== result.connector.id) {
              throw new GatewayError(0, 'invalid_response', '创建回执未确认');
            }
            this.bindConnectorCreation(operation, result.connector.id);
          } else if (result.status === 'not_created') {
            operation.status = 'failed';
            operation.value = null;
            operation.error = '连接器未创建，请检查后重新连接';
            operation.reconciled = true;
            this.connectorCreations.delete(operation);
            this.changed(operation);
            return;
          } else {
            this.timers.set(operation, setTimeout(() => void this.reconcile(key, operation, failures + 1), retryDelay(failures)));
            return;
          }
        }
        readingResource = true;
      }
      const current = operation.resource === 'settings' ? await this.api.getSettings()
        : operation.resource === 'agent' ? await this.api.getAgent(operation.id!)
        : operation.resource === 'connector' ? await this.api.getConnector(operation.id!, this.connectorCreations.has(operation) ? this.connectorReads.signal : undefined)
        : operation.resource === 'browser' ? await this.api.browserTask(operation.id!) : await this.api.getSchedule(operation.id!);
      if (this.closed || this.get(key) !== operation && !this.connectorCreations.has(operation) || operation.status !== 'unknown') return;
      operation.value = current;
      // This is current-state reconciliation, never proof that a mismatching write did not run.
      // Global settings have no operation receipt/version; secret presence cannot prove a replacement committed.
      const matches = operation.resource === 'browser'
        ? operation.action === 'delete' ? 'state' in current && (current.state === 'released' || current.state === 'stopping')
          : Object.entries(operation.fields ?? {}).every(([field, value]) => field === 'closedPage'
            ? 'pages' in current && Array.isArray(current.pages) && !current.pages.some(page => page.id === value)
            : JSON.stringify(current[field as keyof typeof current]) === JSON.stringify(value))
        : operation.resource !== 'settings' && operation.action === 'save' && Object.entries(operation.fields ?? {}).every(([field, value]) =>
          !(operation.resource === 'connector' && (field === 'headers' || field === 'env')) &&
          JSON.stringify(current[field as keyof typeof current]) === JSON.stringify(value));
      operation.status = matches ? 'confirmed' : 'synced';
      operation.reconciled = true;
      if (key === `${operation.resource}:new` && !this.operations.has(`${operation.resource}:${operation.id}`)) this.operations.set(`${operation.resource}:${operation.id}`, operation);
      this.connectorCreations.delete(operation);
      this.changed(operation);
    } catch (reason) {
      if (this.closed || this.get(key) !== operation && !this.connectorCreations.has(operation) || operation.status !== 'unknown') return;
      if (reason instanceof GatewayError && reason.status === 404 && readingResource) {
        operation.status = operation.action === 'delete' ? 'confirmed' : 'synced';
        operation.value = null;
        operation.reconciled = true;
        this.connectorCreations.delete(operation);
        this.changed(operation);
      } else this.timers.set(operation, setTimeout(() => void this.reconcile(key, operation, failures + 1), retryDelay(failures)));
    } finally { this.reads.delete(operation); }
  }
  close(): void {
    this.closed = true;
    this.connectorReads.abort();
    this.connectorCreations.clear();
    this.reads.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.deadlines) clearTimeout(timer);
    this.deadlines.clear();
    this.timers.clear();
    this.operations.clear();
  }
}
