import type { Connector, CreateConnectorInput, PatchConnectorInput } from "../gateway/api.ts";
import { t } from "./i18n.ts";

export type SecretRow = { key: string; value: string; existing: boolean; deleted: boolean };
export type ConnectorDraft = {
  name: string;
  description: string;
  auth_type: "none" | "oauth";
  mode: "local" | "remote";
  command: string;
  args: string[];
  url: string;
  env: SecretRow[];
  headers: SecretRow[];
};
export type ConnectorCreateCommand = { clientId: string; fields: CreateConnectorInput };


export function connectorStatus(connector: Connector): { label: string; failed: boolean } {
  if (connector.status === "failed") return { label: connector.error ? t("连接失败：{error}", { error: t(connector.error) }) : t("连接失败"), failed: true };
  if (connector.status === "connected") return { label: t("已连接"), failed: false };
  if (!connector.used_by.length) return { label: t("没有 Agent 使用，不会连接"), failed: false };
  return { label: t("未连接"), failed: false };
}

/** Authorization is separate from transport health and Agent selection. */
export function connectorAuthLabel(connector: Connector): string {
  if (connector.auth_type === "none") return t("无需授权");
  if (connector.auth.status === "authorized") return t("已授权");
  if (connector.auth.status === "reauthorization_required") return t("需重新授权");
  if (connector.auth.authorizing) return t("等待授权");
  return t("未授权");
}

export function connectorSummary(connectors: Connector[]): { text: string; failed: boolean } {
  const failures = connectors.filter((connector) => connector.status === "failed").length;
  return failures ? { text: t("{count} 个失败", { count: failures }), failed: true } : { text: `${connectors.length}`, failed: false };
}

export function blankConnectorDraft(): ConnectorDraft {
  return { name: "", description: "", mode: "local", auth_type: "none", command: "", args: [], url: "", env: [], headers: [] };
}

export function draftFromConnector(connector: Connector): ConnectorDraft {
  return {
    name: connector.name, description: connector.description,
    auth_type: connector.auth_type,
    mode: connector.url !== undefined ? "remote" : "local",
    command: connector.command ?? "", args: [...(connector.args ?? [])],
    url: connector.url ?? "",
    env: Object.keys(connector.env ?? {}).map((key) => ({ key, value: "", existing: true, deleted: false })),
    headers: Object.keys(connector.headers ?? {}).map((key) => ({ key, value: "", existing: true, deleted: false })),
  };
}

/** Patch only local edits; switching an SSE connector to OAuth also selects Streamable HTTP. latest guards overlapping external edits. */
export function connectorFields(draft: ConnectorDraft, original?: Connector, latest?: Connector): CreateConnectorInput | PatchConnectorInput {
  const remote = draft.mode === "remote";
  const switched = !!original && (original.url !== undefined) !== remote;
  const commandChanged = !remote && (!original || switched || draft.command !== original.command);
  const argsChanged = !remote && (!original || switched || !sameArgs(draft.args, original.args ?? []));
  const urlChanged = remote && (!original || switched || draft.url !== original.url);
  const secrets = secretChanges(remote ? draft.headers : draft.env);
  const hasSecretChanges = (remote && draft.auth_type === "oauth") ? false : Object.keys(secrets).length > 0;
  const connectionEdited = switched || commandChanged || argsChanged || urlChanged || hasSecretChanges;
  const authChanged = !original ? remote && draft.auth_type === "oauth" : draft.auth_type !== original.auth_type;

  if (original && latest) {
    const nameChanged = draft.name !== original.name;
    const descriptionChanged = draft.description !== original.description;
    if ((nameChanged && latest.name !== original.name && latest.name !== draft.name.trim()) ||
        (descriptionChanged && latest.description !== original.description && latest.description !== draft.description)) {
      throw new Error(t("其他设备已修改相同的连接器资料，请返回列表重新打开后再保存"));
    }
    if (authChanged && original.auth_type !== latest.auth_type && draft.auth_type !== latest.auth_type) {
      throw new Error(t("其他设备已修改授权方式，请返回列表重新打开后再保存"));
    }
    if (authChanged && (original.url !== latest.url || original.command !== latest.command ||
        (draft.auth_type === "oauth" && original.transport !== latest.transport && latest.transport === "sse"))) {
      throw new Error(t("其他设备已修改连接器的连接配置，请返回列表重新打开后再保存"));
    }
    if (connectionEdited) {
      const modeChanged = (original.url !== undefined) !== (latest.url !== undefined);
      const overlappingField = !switched && (remote
        ? (urlChanged && original.url !== latest.url && draft.url.trim() !== latest.url)
        : (commandChanged && original.command !== latest.command && draft.command.trim() !== latest.command) ||
          (argsChanged && !sameArgs(original.args ?? [], latest.args ?? []) && !sameArgs(draft.args, latest.args ?? [])));
      if (modeChanged || (switched && !sameConnection(original, latest)) || overlappingField ||
          (hasSecretChanges && !switched && !sameChangedSecrets(secrets, remote ? original.headers : original.env, remote ? latest.headers : latest.env))) {
        throw new Error(t("其他设备已修改连接器的连接配置，请返回列表重新打开后再保存"));
      }
    }
  }

  const fields: PatchConnectorInput = {};
  if (!original || draft.name !== original.name) fields.name = draft.name.trim();
  if (!original || draft.description !== original.description) fields.description = draft.description;
  if (remote) {
    if (urlChanged) fields.url = draft.url.trim();
    if (authChanged) fields.auth_type = draft.auth_type;
    if (authChanged && draft.auth_type === "oauth" && (latest ?? original)?.transport === "sse") fields.transport = "http";
    if (hasSecretChanges) fields.headers = secrets;
  } else {
    if (commandChanged) fields.command = draft.command.trim();
    if (argsChanged) fields.args = [...draft.args];
    if (authChanged) fields.auth_type = "none";
    if (hasSecretChanges) fields.env = secrets;
  }
  return fields as CreateConnectorInput | PatchConnectorInput;
}

function sameArgs(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((arg, index) => arg === right[index]);
}

function sameKeys(left?: Record<string, true>, right?: Record<string, true>): boolean {
  const a = Object.keys(left ?? {});
  const b = Object.keys(right ?? {});
  return a.length === b.length && a.every((key) => Object.hasOwn(right ?? {}, key));
}

function sameConnection(original: Connector, latest: Connector): boolean {
  return original.url !== undefined
    ? original.url === latest.url && sameKeys(original.headers, latest.headers)
    : original.command === latest.command && sameArgs(original.args ?? [], latest.args ?? []) &&
      sameKeys(original.env, latest.env);
}

function sameChangedSecrets(changes: Record<string, string | null>, original?: Record<string, true>, latest?: Record<string, true>): boolean {
  return Object.keys(changes).every((key) => {
    const previouslySet = Object.hasOwn(original ?? {}, key);
    const nowSet = Object.hasOwn(latest ?? {}, key);
    return previouslySet === nowSet || (changes[key] === null && !nowSet);
  });
}

function secretChanges(rows: SecretRow[]): Record<string, string | null> {
  const result: Record<string, string | null> = Object.create(null);
  for (const row of rows) {
    const key = row.existing ? row.key : row.key.trim();
    if (!key) continue;
    if (row.deleted && row.existing) result[key] = null;
    else if (!row.deleted && row.value) result[key] = row.value;
  }
  return result;
}

/** Return a form error before contacting the gateway; it performs the definitive schema validation. */
export function validateConnectorDraft(draft: ConnectorDraft): string | null {
  if (!draft.name.trim()) return t("请输入连接器名称");
  if (draft.mode === "local" && draft.auth_type === "oauth") return t("OAuth 只适用于远程地址");
  if (draft.mode === "local" && !draft.command.trim()) return t("请输入电脑上运行的命令");
  if (draft.mode === "remote" && !/^https?:\/\/[^\s/@]+(?:\:[0-9]+)?(?:[/?#]|$)/i.test(draft.url.trim())) return t("请输入不含账号密码的 HTTP(S) 地址");
  const label = draft.mode === "local" ? t("环境变量") : t("请求头");
  const keys = new Set<string>();
  for (const row of draft.mode === "local" ? draft.env : draft.auth_type === "oauth" ? [] : draft.headers) {
    if (row.deleted) continue;
    const key = row.existing ? row.key : row.key.trim();
    if (!key) return t("请填写{kind}的键名", { kind: label });
    if (keys.has(key)) return t("{kind}的键名不能重复：{key}", { kind: label, key });
    keys.add(key);
    if (!row.existing && !row.value) return t("请填写{kind} {key} 的值", { kind: label, key });
  }
  return null;
}

/** A retry of an unknown create must use exactly the original body and idempotency key. */
export function prepareConnectorCreateCommand(draft: ConnectorDraft, clientId: string, prior: ConnectorCreateCommand | null): ConnectorCreateCommand {
  return prior ?? { clientId, fields: connectorFields(draft) as CreateConnectorInput };
}

export function connectorDeletionUsers(details: unknown): { id: string; name: string }[] {
  if (!details || typeof details !== "object" || !("used_by" in details) || !Array.isArray(details.used_by)) return [];
  return details.used_by.filter((user): user is { id: string; name: string } =>
    !!user && typeof user.id === "string" && typeof user.name === "string");
}
