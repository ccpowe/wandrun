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

for (const status of [413, 507, 404, 401, 403, undefined, 500]) {
  test(`tus status ${status} never exposes request details and only 401 marks credentials invalid`, () => {
    const error = detailed(status);
    assert.doesNotMatch(uploadErrorMessage(error), /private|u_secret|raw tus/);
    assert.equal(isUnauthorizedUpload(error), status === 401);
  });
}

test("unknown errors cannot infer a network failure from raw request-looking text", () => {
  const error = new Error("private network 413");
  assert.doesNotMatch(uploadErrorMessage(error), /private/);
  assert.notEqual(uploadErrorMessage(error), uploadErrorMessage(detailed()));
});

test("local copy and read failures remain local even when tus adds a PATCH request", () => {
  const error = new Error("private file path");
  const local = new LocalUploadError("file", error);
  const message = uploadErrorMessage(error, "file");
  assert.doesNotMatch(message, /private/);
  assert.notEqual(message, uploadErrorMessage(detailed()));
  assert.equal(uploadErrorMessage(local), message);
  assert.equal(uploadErrorMessage(detailed(undefined, local)), message);
});

test("draft persistence failures take precedence over the enclosing copy operation", () => {
  const error = new Error("private draft path");
  const draftRead = uploadErrorMessage(error, "draft-read");
  const local = new LocalUploadError("draft-write", error);
  assert.doesNotMatch(draftRead, /private/);
  assert.notEqual(draftRead, uploadErrorMessage(error, "file"));
  assert.equal(uploadErrorMessage(local, "file"), uploadErrorMessage(error, "draft-write"));
  assert.equal(uploadErrorMessage(detailed(undefined, local)), uploadErrorMessage(local));
});
