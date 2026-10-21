import assert from "node:assert/strict";
import { test } from "node:test";
import { selectConnector, validateConnectorSelection } from "../src/lib/agent-connectors.ts";
import { blankAgentDraft, changedAgentFields, prepareCreateCommand } from "../src/lib/agent-editor.ts";

const catalog = [{ id: "docs", name: "资料", description: "查询文档" }, { id: "empty", name: "无说明", description: " " }];

test("Connector selection moves exclusively between direct/search and can remove a reference", () => {
  const initial = { mcp_servers: ["docs", "empty"], searchable_mcp_servers: [] };
  const searched = selectConnector(initial, "docs", "search");
  assert.deepEqual(searched, { mcp_servers: ["empty"], searchable_mcp_servers: ["docs"] });
  assert.equal(validateConnectorSelection(searched, catalog), null);
  assert.deepEqual(selectConnector(searched, "docs", "direct"), { mcp_servers: ["empty", "docs"], searchable_mcp_servers: [] });
  assert.deepEqual(selectConnector(searched, "docs", null), { mcp_servers: ["empty"], searchable_mcp_servers: [] });
  assert.deepEqual(initial, { mcp_servers: ["docs", "empty"], searchable_mcp_servers: [] });
});

test("Search rejects missing descriptions, deleted references and overlap without rejecting direct use", () => {
  assert.equal(validateConnectorSelection({ mcp_servers: ["empty"], searchable_mcp_servers: [] }, catalog), null);
  assert.match(validateConnectorSelection({ mcp_servers: [], searchable_mcp_servers: ["empty"] }, catalog)!, /缺少说明/);
  assert.match(validateConnectorSelection({ mcp_servers: ["gone"], searchable_mcp_servers: [] }, catalog)!, /不可用/);
  assert.match(validateConnectorSelection({ mcp_servers: ["docs"], searchable_mcp_servers: ["docs"] }, catalog)!, /不能同时/);
});

test("Reference mode change PATCH removes prior mode and unknown creation retries keep their references", () => {
  const before = { ...blankAgentDraft({ default_model: null, default_reasoning_effort: null }, []), mcp_servers: ["docs"] };
  const after = { ...before, ...selectConnector(before, "docs", "search") };
  assert.deepEqual(changedAgentFields(before, after), { mcp_servers: [], searchable_mcp_servers: ["docs"] });
  assert.deepEqual(changedAgentFields(before, { ...before, name: "新名字" }), { name: "新名字" });
  const command = prepareCreateCommand(after, "once", null);
  after.searchable_mcp_servers.push("empty");
  const replay = prepareCreateCommand(after, "again", command);
  assert.equal(replay.clientId, "once");
  assert.deepEqual(replay.fields.searchable_mcp_servers, ["docs"]);
});
