import assert from "node:assert/strict";
import { test } from "node:test";

import { nextThumbnailRequest, THUMBNAIL_REFRESH_MS } from "../src/lib/browser-thumbnail.ts";

const source = "http://gateway/browser-tasks/lease/thumbnail?page=one";

test("没有可见页面不请求，页面出现或切换立即取新图", () => {
  assert.equal(nextThumbnailRequest(null, null, 0, true), null);
  const first = nextThumbnailRequest(null, source, 100, true)!;
  assert.equal(first.uri, source + "&at=100");
  const switched = nextThumbnailRequest(first, source.replace("one", "two"), 101, true)!;
  assert.equal(switched.uri, source.replace("one", "two") + "&at=101");
});

test("成功和失败的聊天请求均按 15 秒边界刷新，不因重新渲染加速重试", () => {
  const first = nextThumbnailRequest(null, source, 100, true)!;
  // A failed image retains its request identity until the same refresh deadline as a successful one.
  assert.equal(nextThumbnailRequest(first, source, 100 + THUMBNAIL_REFRESH_MS - 1, true), first);
  const retry = nextThumbnailRequest(first, source, 100 + THUMBNAIL_REFRESH_MS, true)!;
  assert.notEqual(retry.uri, first.uri);
  assert.equal(retry.requestedAt, 15_100);
  assert.equal(nextThumbnailRequest(retry, source, 15_101, true), retry);
});

test("失焦、后台或离屏结束当前访问，恢复可见时立即取图而不复用失败 URL", () => {
  const first = nextThumbnailRequest(null, source, 100, true)!;
  const hidden = nextThumbnailRequest(first, null, 101, true);
  assert.equal(hidden, null);
  assert.equal(nextThumbnailRequest(hidden, null, 60_000, true), null);
  const resumed = nextThumbnailRequest(hidden, source, 60_001, true)!;
  assert.notEqual(resumed.uri, first.uri);
  assert.equal(resumed.requestedAt, 60_001);
});

test("资料卡片同一次可见访问不轮询，重新进入与切页仍取新图", () => {
  const first = nextThumbnailRequest(null, source, 100, false)!;
  assert.equal(nextThumbnailRequest(first, source, 60_000, false), first);
  const hidden = nextThumbnailRequest(first, null, 60_001, false);
  const resumed = nextThumbnailRequest(hidden, source, 60_002, false)!;
  assert.notEqual(resumed.uri, first.uri);
  const switched = nextThumbnailRequest(resumed, "http://gateway/thumbnail", 60_003, false)!;
  assert.equal(switched.uri, "http://gateway/thumbnail?at=60003");
});
