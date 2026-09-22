import assert from "node:assert/strict";
import test from "node:test";
import { verifyUploadAuth } from "../upload.js";

function requestWithToken(token) {
  return new Request("https://example.test/api/upload", {
    headers: token ? { Authorization: "Bearer " + token } : {},
  });
}

test("upload authentication accepts either configured upload-only token", () => {
  const env = {
    UPLOAD_TOKEN: "production-upload-token",
    TEST_UPLOAD_TOKEN: "test-upload-token",
    ADMIN_API_TOKEN: "admin-token",
  };

  assert.equal(verifyUploadAuth(requestWithToken("production-upload-token"), env), true);
  assert.equal(verifyUploadAuth(requestWithToken("test-upload-token"), env), true);
});

test("upload authentication never treats the admin token as an upload token", () => {
  const env = {
    UPLOAD_TOKEN: "production-upload-token",
    TEST_UPLOAD_TOKEN: "test-upload-token",
    ADMIN_API_TOKEN: "admin-token",
  };

  assert.equal(verifyUploadAuth(requestWithToken("admin-token"), env), false);
  assert.equal(verifyUploadAuth(requestWithToken(), env), false);
});
