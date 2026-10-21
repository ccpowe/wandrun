import assert from "node:assert/strict";
import { test } from "node:test";
import { DetailedError } from "tus-js-client";

import { isUnauthorizedUpload, LocalUploadError, uploadErrorMessage } from "../src/lib/upload-error.ts";

function detailed(status?: number, cause: Error | null = null) {
  return Object.assign(new DetailedError("raw tus error: http://private/uploads/u_secret"), {
    originalRequest: { getMethod: () => "HEAD" },
    originalResponse: status === undefined ? null : { getStatus: () => status },
    causingError: cause,
  });
}

for (const [status, message] of [
  [413, "文件超过大小上限"], [507, "电脑磁盘空间不足"],
  [404, "上传已过期或不存在，需重新上传"], [410, "上传已过期或不存在，需重新上传"],
  [401, "上传未获授权，请检查电脑连接"], [403, "上传未获授权，请检查电脑连接"],
  [0, "连不上电脑"], [undefined, "连不上电脑"],
  [400, "上传失败，请重试"], [409, "上传失败，请重试"],
  [500, "上传失败，请重试"], [200, "上传失败，请重试"],
] as const) {
  test(`tus status ${status} is classified without exposing request details`, () => {
    assert.equal(uploadErrorMessage(detailed(status)), message);
    assert.equal(isUnauthorizedUpload(detailed(status)), status === 401);
  });
}

test("unknown errors and errors without a request are not assumed to be network failures", () => {
  for (const error of [null, undefined, "private raw error", new Error("network 413"), new DetailedError("failed"), {}]) {
    assert.equal(uploadErrorMessage(error), "上传失败，请重试");
  }
});

test("local copy and read failures remain local even when tus adds a PATCH request", () => {
  const error = new Error("private file path");
  assert.equal(uploadErrorMessage(error, "file"), "无法读取所选文件");
  const local = new LocalUploadError("file", error);
  assert.equal(uploadErrorMessage(local), "无法读取所选文件");
  assert.equal(uploadErrorMessage(detailed(undefined, local)), "无法读取所选文件");
});

test("draft persistence failures take precedence over the enclosing copy operation", () => {
  const error = new Error("private draft path");
  assert.equal(uploadErrorMessage(error, "draft-read"), "无法读取附件草稿，请重试");
  assert.equal(uploadErrorMessage(new LocalUploadError("draft-write", error), "file"), "无法保存附件草稿，请重试");
  assert.equal(uploadErrorMessage(detailed(undefined, new LocalUploadError("draft-write", error))), "无法保存附件草稿，请重试");
});
