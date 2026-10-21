import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ATTACHMENT_GRID,
  attachmentDisplayWidth,
  decodeUtf8Prefix,
  formatDuration,
  groupAttachments,
  imageGridCells,
  imageGridHeight,
  isImageAttachment,
  isVideoAttachment,
  moreImagesCount,
  singleImageSize,
  thumbnailWidthForPixels,
  viewerIndex,
  visibleFileCount,
} from "../src/lib/attachment-grid.ts";

function file(id: string, media_type: string, remote_environment?: string) {
  return { id, name: id, size: 1024, media_type, remote_environment };
}

test("attachment grid geometry follows the one-to-nine layouts and clips after nine", () => {
  assert.equal(imageGridCells(1, 300).length, 1);
  assert.equal(imageGridCells(2, 300).length, 2);
  assert.deepEqual(imageGridCells(3, 300).map(({ width, height }) => [width, height]), [[198, 200], [99, 98.5], [99, 98.5]]);
  assert.equal(imageGridHeight(4, 300), 299);
  assert.equal(imageGridHeight(5, 300), 199);
  assert.equal(imageGridCells(9, 300).length, 9);
  assert.equal(imageGridCells(12, 300).length, ATTACHMENT_GRID.maxVisibleImages);
  assert.equal(moreImagesCount(12), 3);
  assert.equal(imageGridHeight(12, 240), 240);
});

test("attachment widths and single-image proportions stay within design bounds", () => {
  assert.equal(attachmentDisplayWidth(1024, false), 300);
  assert.equal(attachmentDisplayWidth(320, false), 288);
  assert.equal(attachmentDisplayWidth(1024, true), 240);
  assert.deepEqual(singleImageSize(300, { width: 600, height: 300 }), { width: 300, height: 150 });
  assert.deepEqual(singleImageSize(300, { width: 100, height: 1000 }), { width: 24, height: 240 });
  assert.equal(imageGridCells(2, 240)[0].height, 118.4);
});

test("attachment grouping keeps remote images in the file behavior and separates mixed files", () => {
  const groups = groupAttachments([
    file("one", "image/png"),
    file("two", "image/jpeg"),
    file("remote-image", "image/png", "ssh-a"),
    file("archive", "application/zip"),
  ]);
  assert.deepEqual(groups.images.map((entry) => entry.id), ["one", "two"]);
  assert.deepEqual(groups.files.map((entry) => entry.id), ["remote-image", "archive"]);
});

test("compact file groups expose four rows and a localized overflow count", () => {
  assert.deepEqual(visibleFileCount(4), { visible: 4, hidden: 0 });
  assert.deepEqual(visibleFileCount(7), { visible: 4, hidden: 3 });
});

test("markdown prefix decoding drops only an incomplete trailing UTF-8 code point", () => {
  const bytes = new TextEncoder().encode("标题\n正文");
  assert.equal(decodeUtf8Prefix(bytes, bytes.byteLength - 1), "标题\n正");
  assert.equal(decodeUtf8Prefix(bytes, bytes.byteLength), "标题\n正文");
});

test("attachment viewer preserves message order and starts at the tapped ninth image", () => {
  const ids = Array.from({ length: 12 }, (_, index) => `image-${index + 1}`);
  assert.equal(viewerIndex(ids, "image-9"), 8);
  assert.equal(viewerIndex(ids, "image-12"), 11);
  assert.equal(viewerIndex(ids, undefined, 20), 11);
});

test("videos share grid ordering while image viewer filtering remains image-only", () => {
  const files = [file("image-1", "image/png"), file("video-1", "video/mp4"), file("image-2", "image/jpeg")];
  const groups = groupAttachments(files);
  assert.deepEqual(groups.images.map((entry) => entry.id), ["image-1", "video-1", "image-2"]);
  assert.equal(isImageAttachment(groups.images[1]), false);
  assert.equal(isVideoAttachment(groups.images[1]), true);
  const imageIds = groups.images.filter(isImageAttachment).map((entry) => entry.id);
  assert.deepEqual(imageIds, ["image-1", "image-2"]);
  assert.equal(viewerIndex(imageIds, "image-2"), 1);
});

test("thumbnail buckets use physical pixels and duration labels stay stable", () => {
  assert.equal(thumbnailWidthForPixels(120, 1), 240);
  assert.equal(thumbnailWidthForPixels(240, 2), 480);
  assert.equal(thumbnailWidthForPixels(241, 2), 960);
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(73_000), "1:13");
  assert.equal(formatDuration(3_661_000), "1:01:01");
});
