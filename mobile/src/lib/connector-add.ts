import { GatewayError, type Connector, type ConnectorProbe, type CreateConnectorInput, type PatchConnectorInput } from '../gateway/api.ts';
import type { EditorOperation } from '../gateway/editor-operation.ts';
export type ConnectorAuthChoice = 'none' | 'key' | 'oauth';
export type ConnectorParameterDraft = {
  mode: 'remote' | 'local'; url: string; commandLine: string; auth: ConnectorAuthChoice; transport: string;
  headers: { key: string; value: string; existing: boolean; deleted: boolean }[];
  env: { key: string; value: string; existing: boolean; deleted: boolean }[];
};
export function blankConnectorParameters(mode: 'remote' | 'local'): ConnectorParameterDraft {
  return { mode, url: '', commandLine: '', auth: 'none', transport: 'auto',
    headers: [{ key: 'Authorization', value: 'Bearer ', existing: false, deleted: false }], env: [] };
}
export function parseConnectorCommand(text: string): string[] {
  const words: string[] = []; let word = ''; let quote = ''; let started = false; let escaped = false;
  for (const char of text) {
    if (escaped) { word += char; started = true; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = ''; else word += char; started = true; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } } else { word += char; started = true; }
  }
  if (quote || escaped) throw new Error('命令中的引号或转义未结束');
  if (started) words.push(word);
  return words;
}
function parameterTransport(row: Connector): string {
  return row.transport_source === 'auto' ? 'auto' : row.transport === 'http' ? 'streamable-http' : row.transport ?? 'auto';
}
export function parametersFromConnector(row: Connector): ConnectorParameterDraft {
  const base = blankConnectorParameters(row.url !== undefined ? 'remote' : 'local');
  const encode = (word: string) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
  return { ...base, url: row.url ?? '', commandLine: [row.command ?? '', ...(row.args ?? [])].map(encode).join(' '),
    auth: row.auth_type, transport: parameterTransport(row),
    headers: row.auth_type === 'key' && !Object.keys(row.headers ?? {}).length ? base.headers : Object.keys(row.headers ?? {}).map(key => ({ key, value: '', existing: true, deleted: false })),
    env: Object.keys(row.env ?? {}).map(key => ({ key, value: '', existing: true, deleted: false })) };
}
/** connector-auth.AU10: a catalog key connector edits only its single Key, named by the catalog. */
export function keyParametersFromConnector(row: Connector, name: string): ConnectorParameterDraft {
  return { ...parametersFromConnector(row), headers: [{ key: name, value: '', existing: Object.hasOwn(row.headers ?? {}, name), deleted: false }] };
}
export function connectorParameterFields(draft: ConnectorParameterDraft): CreateConnectorInput;
export function connectorParameterFields(draft: ConnectorParameterDraft, original: Connector, latest?: Connector): PatchConnectorInput;
export function connectorParameterFields(draft: ConnectorParameterDraft, original?: Connector, latest?: Connector): CreateConnectorInput | PatchConnectorInput {
  const fields: PatchConnectorInput = {};
  if (draft.mode === 'remote') {
    let parsed: URL;
    try { parsed = new URL(draft.url.trim()); } catch { throw new Error('请输入不含账号密码的 HTTP(S) 地址'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('请输入不含账号密码的 HTTP(S) 地址');
    if (!original || draft.url.trim() !== original.url) fields.url = draft.url.trim();
    if (!original || draft.auth !== original.auth_type) fields.auth_type = draft.auth;
    const transport = draft.transport === 'auto' ? parsed.pathname.endsWith('/sse') ? 'sse' : 'streamable-http' : draft.transport;
    if (draft.auth === 'oauth' && transport === 'sse') throw new Error('OAuth 只支持 Streamable HTTP');
    if (original ? draft.transport !== parameterTransport(original) : draft.transport !== 'auto') {
      fields.transport = draft.transport === 'auto' ? null : draft.transport;
    }
  } else {
    const [command, ...args] = parseConnectorCommand(draft.commandLine);
    if (!command) throw new Error('请输入电脑上运行的命令');
    if (!original || command !== original.command) fields.command = command;
    if (!original || JSON.stringify(args) !== JSON.stringify(original.args ?? [])) fields.args = args;
    if (original?.auth_type !== undefined && original.auth_type !== 'none') fields.auth_type = 'none';
  }
  const kind = draft.mode === 'local' ? 'env' : 'headers';
  if (draft.mode === 'local' || draft.auth === 'key') {
    const patch: Record<string, string | null> = {}; const keys = new Set<string>();
    for (const row of draft[kind]) {
      const key = row.existing ? row.key : row.key.trim();
      if (row.deleted) { if (row.existing) patch[key] = null; continue; }
      if (!key || keys.has(key)) throw new Error('请填写不重复的密钥键名');
      keys.add(key);
      if (!row.existing && !row.value.trim()) throw new Error('请填写密钥值');
      if (kind === 'headers' && key.toLocaleLowerCase() === 'authorization' && /^Bearer\s*$/i.test(row.value)) throw new Error('请在 Bearer 后填写密钥值');
      if (!row.existing || row.value) patch[key] = row.value;
    }
    if (Object.keys(patch).length) fields[kind] = patch;
  }
  if (original?.auth_type === 'key' && draft.mode === 'remote' && draft.auth === 'none') {
    const names = Object.keys(original.headers ?? {});
    if (names.length) fields.headers = Object.fromEntries(names.map(name => [name, null]));
  }
  if (original && latest) for (const key of Object.keys(fields) as (keyof PatchConnectorInput)[]) {
    const changed = key === 'transport'
      ? parameterTransport(original) !== parameterTransport(latest) && (fields.transport === null ? 'auto' : fields.transport) !== parameterTransport(latest)
      : key === 'headers' || key === 'env'
        ? Object.entries(fields[key] ?? {}).some(([name, value]) => Object.hasOwn(original[key] ?? {}, name) !== Object.hasOwn(latest[key] ?? {}, name) && !(value === null && !Object.hasOwn(latest[key] ?? {}, name)))
        : JSON.stringify(original[key as keyof Connector]) !== JSON.stringify(latest[key as keyof Connector]) && JSON.stringify(fields[key]) !== JSON.stringify(latest[key as keyof Connector]);
    if (changed) throw new Error('其他设备已修改相同的连接器资料，请返回列表重新打开后再保存');
  }
  return fields;
}
export type ConnectorAddState =
  | { status: 'editing'; draft: ConnectorParameterDraft; authTouched: boolean; error: string; reason?: string; suggestion?: ConnectorAuthChoice; probe?: { id: string; key: string }; probedKey?: string }
  | { status: 'connecting'; draft: ConnectorParameterDraft; operationId: string }
  | { status: 'created'; id: string; authorization?: { status: 'checking' } | { status: 'failed'; error: string } };
export type ConnectorAddEvent =
  | { type: 'change'; fields: Partial<ConnectorParameterDraft>; authTouched?: boolean }
  | { type: 'probe-started'; id: string; key: string }
  | { type: 'probe-finished'; id: string; key: string; result: ConnectorProbe }
  | { type: 'connect'; operationId: string }
  | { type: 'created'; operationId: string; id: string }
  | { type: 'authorization-check' | 'authorization-ready'; id: string }
  | { type: 'authorization-failed'; id: string; message: string }
  | { type: 'failed'; operationId?: string; message: string; reason?: string; suggestion?: ConnectorAuthChoice };
export function connectorAddReducer(state: ConnectorAddState, event: ConnectorAddEvent): ConnectorAddState {
  switch (state.status) {
    case 'editing':
      switch (event.type) {
        case 'change': return { ...state, draft: { ...state.draft, ...event.fields }, authTouched: state.authTouched || !!event.authTouched, error: '',
          ...('url' in event.fields || 'transport' in event.fields ? { probe: undefined, suggestion: undefined, probedKey: undefined } : {}) };
        case 'probe-started': return { ...state, probe: { id: event.id, key: event.key }, probedKey: event.key };
        case 'probe-finished': {
          if (state.probe?.id !== event.id || state.probe.key !== event.key) return state;
          const result = event.result;
          if (result.result === 'failed') return { ...state, probe: undefined, error: '无法探测连接方式，请检查地址或直接连接' };
          if (result.result === 'oauth' && !result.oauth?.dcr_supported) return { ...state, probe: undefined, error: '该服务需要预先注册的应用，暂不支持手动添加' };
          if (result.result === 'oauth' && !result.oauth?.pkce_supported) return { ...state, probe: undefined, error: '此服务不支持安全 OAuth，请修改地址或使用其他认证方式' };
          return { ...state, probe: undefined, suggestion: result.result, draft: state.authTouched ? state.draft : { ...state.draft, auth: result.result } };
        }
        case 'connect': return { status: 'connecting', draft: state.draft, operationId: event.operationId };
        case 'failed': return { ...state, error: event.message, reason: event.reason, suggestion: event.suggestion };
        default: return state;
      }
    case 'connecting':
      if (event.type === 'created' && event.operationId === state.operationId) return { status: 'created', id: event.id };
      if (event.type === 'failed' && event.operationId === state.operationId) return { status: 'editing', draft: state.draft, authTouched: true, error: event.message, reason: event.reason, suggestion: event.suggestion };
      return state;
    case 'created':
      switch (event.type) {
        case 'authorization-check': return event.id === state.id ? { ...state, authorization: { status: 'checking' } } : state;
        case 'authorization-ready': return event.id === state.id ? { ...state, authorization: undefined } : state;
        case 'authorization-failed': return event.id === state.id ? { ...state, authorization: { status: 'failed', error: event.message } } : state;
        default: return state;
      }
  }
}
export function connectorCreateFailure(error: unknown): { message: string; reason?: string; suggestion?: ConnectorAuthChoice } {
  if (error instanceof GatewayError) {
    const probe = (error.details as { probe?: ConnectorProbe } | undefined)?.probe;
    if (error.code === 'authentication_mismatch' && probe && probe.result !== 'failed') return { message: '认证方式与服务要求不符，请切换后重新连接', suggestion: probe.result };
    if (error.code === 'oauth_dcr_unsupported') return { message: '该服务需要预先注册的应用，暂不支持手动添加' };
    if (error.code === 'unsupported_oauth') return { message: '此服务不支持安全 OAuth，请修改地址或使用其他认证方式' };
    if (error.code === 'connection_failed') return probe?.error?.message
      ? { message: '连接失败：{reason}。修改后可重试', reason: probe.error.message }
      : { message: '连接失败，请检查地址、命令或密钥后重试' };
    if (error.code === 'invalid_request') return { message: '连接参数不符合要求，请检查网址、认证方式及高级传输设置' };
  }
  return { message: '连接未完成，请修改后重试' };
}
export function selectConnectorAdd(state: ConnectorAddState, outcome: EditorOperation | undefined, offline: boolean) {
  const matching = state.status === 'connecting' && outcome?.operationId === state.operationId ? outcome : undefined;
  const unknown = matching?.status === 'unknown';
  const pending = matching?.status === 'pending' || state.status === 'connecting' && !matching?.reconciled;
  const recovery = matching?.reconciled && matching.value === null
    ? { type: 'failed' as const, operationId: matching.operationId, message: matching.id ? '连接器已不存在，请修改后重新连接' : '已核对本次未创建连接器，请修改后重试' } : undefined;
  return { unknown, pending: !unknown && pending, canSubmit: state.status === 'editing' && !offline && !unknown && !pending,
    canEdit: state.status === 'editing' && !unknown && !pending, recovery,
    recoveredId: matching?.reconciled && matching.id && matching.value !== null ? matching.id : undefined };
}
