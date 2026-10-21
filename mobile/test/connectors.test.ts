import assert from "node:assert/strict";
import test from "node:test";

import type { Connector } from "../src/gateway/api.ts";
import { createResultUnknown, GatewayError } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { blankConnectorDraft, connectorAuthLabel, connectorDeletionUsers, connectorFields, connectorStatus, connectorSummary, draftFromConnector, prepareConnectorCreateCommand, validateConnectorDraft } from "../src/lib/connectors.ts";

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const remote: Connector = {
  id: "c_one", name: "资料库", description: "查找资料", url: "https://example.com/mcp", transport: "sse",
  headers: { Authorization: true, "X-Region": true }, status: "connected", error: null, tool_count: 8,
  used_by: [{ id: "agent", name: "研究者" }], pending_restart: false,
  auth_type: "none", app_id: null, auth: { status: "not_required", authorizing: false, scopes: [] },
};

test("连接器状态优先暴露失败，即使无人使用；其余状态区分已连接、未连接与不会连接", () => {
  assert.deepEqual(connectorStatus(remote), { label: "已连接", failed: false });
  assert.deepEqual(connectorStatus({ ...remote, status: "disconnected" }), { label: "未连接", failed: false });
  assert.deepEqual(connectorStatus({ ...remote, used_by: [], status: "disconnected" }), { label: "没有 Agent 使用，不会连接", failed: false });
  assert.deepEqual(connectorStatus({ ...remote, used_by: [], status: "failed", error: "401 认证无效" }), { label: "连接失败：401 认证无效", failed: true });
  assert.equal(connectorStatus({ ...remote, used_by: [] }).label, "已连接");
  assert.deepEqual(connectorSummary([remote]), { text: "1", failed: false });
  assert.deepEqual(connectorSummary([]), { text: "0", failed: false });
  assert.deepEqual(connectorSummary([remote, { ...remote, status: "failed" }]), { text: "1 个失败", failed: true });
});

test("OAuth 授权与连接健康分别呈现，Agent 未选择不等于已授权", () => {
  const oauth: Connector = { ...remote, auth_type: "oauth", auth: { status: "unauthorized", authorizing: false, scopes: [] }, used_by: [], status: "disconnected" };
  assert.equal(connectorAuthLabel(oauth), "未授权");
  assert.equal(connectorStatus(oauth).label, "没有 Agent 使用，不会连接");
  assert.equal(connectorAuthLabel({ ...oauth, auth: { ...oauth.auth, authorizing: true } }), "等待授权");
  assert.equal(connectorAuthLabel({ ...oauth, auth: { ...oauth.auth, status: "reauthorization_required" } }), "需重新授权");
  assert.equal(connectorAuthLabel({ ...oauth, auth: { status: "authorized", authorizing: false, scopes: ["read"] } }), "已授权");
});

test("既有密钥的键名逐字保留，新增键名去空白；只有显式删除才发送 null", () => {
  const original: Connector = { ...remote, headers: { " X-Region ": true, Authorization: true } };
  const draft = draftFromConnector(original);
  draft.name = "资料库新名";
  draft.headers[0].value = " rotated\r\n";
  draft.headers[1].deleted = true;
  draft.headers.push({ key: " X-New ", value: "new-secret", existing: false, deleted: false });
  assert.deepEqual(wire(connectorFields(draft, original)), {
    name: "资料库新名",
    headers: { " X-Region ": " rotated\r\n", Authorization: null, "X-New": "new-secret" },
  });
  draft.headers[0].deleted = true;
  draft.headers[1].deleted = false;
  assert.deepEqual(wire(connectorFields(draft, original)), {
    name: "资料库新名",
    headers: { " X-Region ": null, "X-New": "new-secret" },
  });
  assert.deepEqual(connectorFields(draftFromConnector(original), original), {});
  const metadataOnly = draftFromConnector(original);
  metadataOnly.description = "更新说明";
  assert.deepEqual(connectorFields(metadataOnly, original), { description: "更新说明" });
  assert.deepEqual(draftFromConnector(original).headers.map(({ key, value }) => [key, value]), [[" X-Region ", ""], ["Authorization", ""]]);
  metadataOnly.headers.push({ key: " X-Region ", value: "distinct", existing: false, deleted: false });
  assert.equal(validateConnectorDraft(metadataOnly), null);
  assert.deepEqual(wire(connectorFields(metadataOnly, original)), { description: "更新说明", headers: { "X-Region": "distinct" } });
  metadataOnly.headers.push({ key: "X-Region", value: "duplicate", existing: false, deleted: false });
  assert.match(validateConnectorDraft(metadataOnly)!, /不能重复/);
});

test("本地参数数组无损保留内部换行、回车和空参数，创建重放不受草稿修改影响", () => {
  const args = ["-y", "line\nbreak", "literal\r", "", "end\r\n"];
  const draft = blankConnectorDraft();
  Object.assign(draft, { name: "本地", command: "npx", args });
  draft.env.push({ key: "TOKEN", value: "new", existing: false, deleted: false });
  assert.deepEqual(wire(connectorFields(draft)), { name: "本地", description: "", command: "npx", args, env: { TOKEN: "new" } });
  const original: Connector = { ...remote, command: "npx", args, url: undefined, transport: undefined, headers: undefined, env: { TOKEN: true } };
  const fromServer = draftFromConnector(original);
  assert.deepEqual(fromServer.args, args);
  assert.notEqual(fromServer.args, original.args);
  assert.deepEqual(connectorFields(fromServer, original), {});
  const spaced: Connector = { ...original, name: " 本地 ", command: " npx " };
  assert.deepEqual(connectorFields(draftFromConnector(spaced), spaced), {});
  fromServer.args[3] = "\n";
  assert.deepEqual(connectorFields(fromServer, original), { args: ["-y", "line\nbreak", "literal\r", "\n", "end\r\n"] });
  const first = prepareConnectorCreateCommand(draft, "client-one", null);
  const expectedArgs = [...args];
  draft.args.push("later");
  assert.deepEqual(first.fields.args, expectedArgs);
  assert.equal(prepareConnectorCreateCommand(draft, "client-two", first), first);
});

test("新建远程连接器不指定传输，切换连接方式只发送新方式字段", () => {
  const draft = blankConnectorDraft();
  Object.assign(draft, { name: "本地", command: "npx", args: ["-y", ""] });
  draft.env.push({ key: "TOKEN", value: "local", existing: false, deleted: false });
  draft.mode = "remote";
  draft.url = "https://example.com/new";
  draft.headers.push({ key: "Authorization", value: "Bearer new", existing: false, deleted: false });
  assert.deepEqual(wire(connectorFields(draft)), { name: "本地", description: "", url: "https://example.com/new", headers: { Authorization: "Bearer new" } });
  const local: Connector = { ...remote, name: "本地", description: "", command: "npx", args: [], env: { TOKEN: true }, url: undefined, transport: undefined, headers: undefined };
  assert.deepEqual(wire(connectorFields(draft, local)), { url: "https://example.com/new", headers: { Authorization: "Bearer new" } });
});

test("编辑带 transport 的连接器不发送该字段，外部传输修改不造成冲突", () => {
  const original: Connector = { ...remote, transport: "streamable-http" };
  const draft = draftFromConnector(original);
  draft.url = "https://example.com/edited";
  const patch = connectorFields(draft, original);
  assert.deepEqual(patch, { url: "https://example.com/edited" });
  assert.equal(Object.hasOwn(patch, "transport"), false);
  const latest: Connector = { ...original, transport: "http" };
  assert.deepEqual(connectorFields(draft, original, latest), patch);
  draft.mode = "local";
  draft.command = "npx";
  assert.deepEqual(connectorFields(draft, original, latest), { command: "npx", args: [] });
});

test("自定义 OAuth 仅在远程连接器上提交授权方式，切回本机时显式清除授权方式", () => {
  const draft = blankConnectorDraft();
  Object.assign(draft, { name: "知识库", mode: "remote", url: "https://example.com/mcp", auth_type: "oauth" });
  assert.deepEqual(connectorFields(draft), { name: "知识库", description: "", url: "https://example.com/mcp", auth_type: "oauth" });
  const initial: Connector = { ...remote, auth_type: "none", headers: { Authorization: true } };
  assert.deepEqual(connectorFields(draft, initial), { name: "知识库", description: "", auth_type: "oauth", transport: "http" });
  assert.throws(() => connectorFields(draft, initial, { ...initial, auth_type: "oauth", url: "https://other.example/mcp" }), /重新打开/);
  assert.deepEqual(connectorFields(draft, initial, { ...initial, transport: "http" }),
    { name: "知识库", description: "", auth_type: "oauth" });
  const authorized: Connector = { ...initial, auth_type: "oauth", auth: { status: "authorized", authorizing: false, scopes: ["read"] }, headers: {} };
  const local = draftFromConnector(authorized);
  local.mode = "local";
  local.auth_type = "none";
  local.command = "npx";
  assert.deepEqual(connectorFields(local, authorized), { command: "npx", args: [], auth_type: "none" });
  local.auth_type = "oauth";
  assert.match(validateConnectorDraft(local)!, /OAuth/);
});

test("外部切换连接方式时仅元数据修改安全合并，草稿的连接修改必须重新打开", () => {
  const remoteToLocal: Connector = { ...remote, url: undefined, transport: undefined, headers: undefined, command: "npx", args: ["other"] };
  const meta = draftFromConnector(remote);
  meta.name = "新的显示名";
  assert.deepEqual(connectorFields(meta, remote, remoteToLocal), { name: "新的显示名" });
  const changed = draftFromConnector(remote);
  changed.url = "https://example.com/new";
  assert.throws(() => connectorFields(changed, remote, remoteToLocal), /重新打开/);
  const local = { ...remoteToLocal, args: ["first"] };
  const latestRemote = { ...remote, url: "https://example.com/latest" };
  const localMeta = draftFromConnector(local);
  localMeta.description = "说明";
  assert.deepEqual(connectorFields(localMeta, local, latestRemote), { description: "说明" });
  const localEdit = draftFromConnector(local);
  localEdit.args.push("");
  assert.throws(() => connectorFields(localEdit, local, latestRemote), /重新打开/);
});

test("本机主动切换方式不覆盖外部修改过的旧方式连接参数", () => {
  const local: Connector = { ...remote, url: undefined, transport: undefined, headers: undefined, command: "npx", args: ["old"], env: { TOKEN: true } };
  const draft = draftFromConnector(local);
  draft.mode = "remote";
  draft.url = "https://example.com/new";
  assert.deepEqual(connectorFields(draft, local, { ...local, name: "外部新名" }), { url: "https://example.com/new" });
  const externallyChanged: Connector[] = [{ ...local, command: "other" }, { ...local, args: ["updated"] }, { ...local, env: { TOKEN: true, NEW: true } }];
  for (const latest of externallyChanged) {
    assert.throws(() => connectorFields(draft, local, latest), /重新打开/);
  }
  const reverse = draftFromConnector(remote);
  reverse.mode = "local";
  reverse.command = "npx";
  assert.throws(() => connectorFields(reverse, remote, { ...remote, headers: { ...remote.headers, NEW: true } }), /重新打开/);
});

test("同方式仅发送本机改动字段，冲突字段拒绝覆盖，独立字段安全合并", () => {
  const original = { ...remote, transport: undefined };
  const draft = draftFromConnector(original);
  draft.url = "https://example.com/edited";
  assert.deepEqual(connectorFields(draft, original, { ...original, description: "外部说明", headers: { ...original.headers, NEW: true } }), { url: "https://example.com/edited" });
  assert.throws(() => connectorFields(draft, original, { ...original, url: "https://example.com/external" }), /重新打开/);
  const secretDraft = draftFromConnector(original);
  secretDraft.headers.push({ key: "LOCAL", value: "secret", existing: false, deleted: false });
  assert.deepEqual(wire(connectorFields(secretDraft, original, { ...original, headers: { ...original.headers, REMOTE: true } })), { headers: { LOCAL: "secret" } });
  assert.throws(() => connectorFields(secretDraft, original, { ...original, headers: { ...original.headers, LOCAL: true } }), /重新打开/);
  const rotation = draftFromConnector(original);
  rotation.headers[0].value = "replacement";
  assert.throws(() => connectorFields(rotation, original, { ...original, headers: { "X-Region": true } }), /重新打开/);
  rotation.headers[0].value = "";
  rotation.headers[0].deleted = true;
  assert.deepEqual(wire(connectorFields(rotation, original, { ...original, headers: { "X-Region": true } })), { headers: { Authorization: null } });
  const local: Connector = { ...remote, url: undefined, transport: undefined, headers: undefined, command: "old", args: ["arg"] };
  const localDraft = draftFromConnector(local);
  localDraft.args = ["edited"];
  assert.deepEqual(connectorFields(localDraft, local, { ...local, command: "external" }), { args: ["edited"] });
  assert.throws(() => connectorFields(localDraft, local, { ...local, args: ["external"] }), /重新打开/);
  const meta = draftFromConnector(original);
  meta.description = "本地说明";
  assert.throws(() => connectorFields(meta, original, { ...original, description: "外部说明" }), /重新打开/);
});

test("表单拒绝空字段和重复密钥，但既有密钥留空仍可保存；冲突揭示使用者", () => {
  const draft = blankConnectorDraft();
  assert.equal(validateConnectorDraft(draft), "请输入连接器名称");
  draft.name = "本地";
  assert.equal(validateConnectorDraft(draft), "请输入电脑上运行的命令");
  draft.command = "npx";
  draft.env = [{ key: "TOKEN", value: "", existing: false, deleted: false }];
  assert.match(validateConnectorDraft(draft)!, /TOKEN 的值/);
  draft.env[0].value = "new";
  draft.env.push({ key: "TOKEN", value: "other", existing: false, deleted: false });
  assert.match(validateConnectorDraft(draft)!, /不能重复/);
  draft.env[1].deleted = true;
  assert.equal(validateConnectorDraft(draft), null);
  draft.env[0].value = "";
  draft.mode = "remote";
  draft.url = "https://example.com/mcp";
  assert.equal(validateConnectorDraft(draft), null); // Inactive connection's unfinished secret is not submitted.
  assert.deepEqual(connectorDeletionUsers({ used_by: [{ id: "agent", name: "研究者" }, { bad: true }] }), [{ id: "agent", name: "研究者" }]);
});

test("未知创建结果只能以同一 client_id 和原请求重放，明确拒绝可重新编辑", () => {
  assert.equal(createResultUnknown(new GatewayError(0, "offline", "断线")), true);
  const uncertain = createResultUnknown(new GatewayError(503, "unavailable", "不可用"));
  assert.equal(uncertain, true);
  assert.equal(createResultUnknown(new Error("响应体无法读取")), true);
  assert.equal(createResultUnknown(new GatewayError(400, "invalid_request", "非法字段")), false);
  const afterRetryRefusal = createResultUnknown(new GatewayError(400, "invalid_request", "非法字段"), uncertain);
  assert.equal(afterRetryRefusal, true);
  assert.equal(createResultUnknown(new GatewayError(409, "conflict", "冲突"), afterRetryRefusal), true);
  const draft = blankConnectorDraft();
  draft.name = "第一次";
  draft.command = "fixture-mcp";
  const first = prepareConnectorCreateCommand(draft, "client-one", null);
  draft.name = "后来改的名字";
  draft.env.push({ key: "TOKEN", value: "later", existing: false, deleted: false });
  const retried = prepareConnectorCreateCommand(draft, "client-two", afterRetryRefusal ? first : null);
  assert.equal(retried, first);
  assert.deepEqual(wire(retried), { clientId: "client-one", fields: { name: "第一次", description: "", command: "fixture-mcp", args: [] } });
});

test("资源事件使连接器快照失效；Agent 引用更新与外部删除可被编辑页观察", async () => {
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" });
  try {
    const event = (seq: number, kind: string, op: string) => ({ seq, type: "resource.changed", at: seq, data: { kind, id: "c_one", op } });
    session.connectorChanged(event(1, "connector", "created"));
    assert.equal(session.connectorRevision, 1);
    assert.equal(session.connectorDefinitionSeq.get("c_one"), 1);
    session.connectorChanged(event(2, "connector", "status"));
    assert.equal(session.connectorRevision, 2);
    assert.equal(session.connectorDefinitionSeq.get("c_one"), 1);
    session.connectorChanged(event(3, "agent", "updated"));
    assert.equal(session.connectorRevision, 3);
    session.connectorChanged(event(4, "connector", "updated"));
    assert.equal(session.connectorDefinitionSeq.get("c_one"), 4);
    session.connectorChanged(event(5, "connector", "deleted"));
    assert.equal(session.deletedConnectorIds.has("c_one"), true);
    assert.equal(session.connectorRevision, 5);
  } finally { await session.close(); }
});
