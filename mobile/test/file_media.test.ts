import assert from "node:assert/strict";
import { test } from "node:test";

import { GatewayApi, GatewayError } from "../src/gateway/api.ts";
import { loadMarkdownPrefix, MARKDOWN_PREFIX_BYTES } from "../src/lib/attachment-grid.ts";

test("file preview requests are authenticated and cached by file id", async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const api = new GatewayApi({ baseUrl: "https://gateway.test", token: "secret" }, async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
    return Response.json({ kind: "video", width: 1920, height: 1080, duration_ms: 73_000, page_count: null });
  });
  try {
    const first = api.getFilePreview("file/1");
    const second = api.getFilePreview("file/1");
    assert.strictEqual(first, second);
    assert.deepEqual(await first, { kind: "video", width: 1920, height: 1080, duration_ms: 73_000, page_count: null });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://gateway.test/files/file%2F1/preview");
    assert.equal(requests[0].authorization, "Bearer secret");
    assert.equal(api.fileThumbnailPath("file/1", 480), "/files/file%2F1/thumbnail?w=480");
  } finally {
    api.close();
  }
});

test("preview failures are cached and do not retry a broken file in one session", async () => {
  let calls = 0;
  const api = new GatewayApi({ baseUrl: "https://gateway.test", token: "secret" }, async () => {
    calls++;
    return Response.json({ error: { code: "preview_unavailable", message: "unavailable" } }, { status: 422 });
  });
  try {
    await assert.rejects(api.getFilePreview("broken"), (error: unknown) => error instanceof GatewayError && error.status === 422 && error.code === "preview_unavailable");
    await assert.rejects(api.getFilePreview("broken"), (error: unknown) => error instanceof GatewayError && error.status === 422);
    assert.equal(calls, 1);
  } finally {
    api.close();
  }
});

test("markdown summary reads a ranged prefix from the gateway content path", async () => {
  const requests: { url: string; range: string | null }[] = [];
  const api = new GatewayApi({ baseUrl: "https://gateway.test", token: "secret" }, async (input, init) => {
    requests.push({ url: String(input), range: new Headers(init?.headers).get("Range") });
    return new Response("# 标题\n\n正文", { status: 206 });
  });
  try {
    assert.equal(await loadMarkdownPrefix(api, "file/1", 20), "# 标题\n\n正文");
    assert.deepEqual(requests, [{ url: "https://gateway.test/files/file%2F1/content", range: `bytes=0-${MARKDOWN_PREFIX_BYTES - 1}` }]);
  } finally {
    api.close();
  }
});
