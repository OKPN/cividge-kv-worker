import assert from "node:assert/strict";
import test from "node:test";
import { putR2Upload, verifyUploadAuth } from "../upload.js";

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

test("unknown-length raw R2 uploads are safely buffered with an exact stored size", async () => {
  const bytes = new TextEncoder().encode("cividge-r2-stream");
  let stored = null;
  const bucket = {
    async put(key, body, options) {
      stored = { key, bytes: new Uint8Array(await new Response(body).arrayBuffer()), options };
    },
  };
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 7));
      controller.enqueue(bytes.subarray(7));
      controller.close();
    },
  });

  const size = await putR2Upload(bucket, "stream.webp", source, null, 0, "image/webp");
  assert.equal(size, bytes.byteLength);
  assert.equal(stored.key, "stream.webp");
  assert.deepEqual(stored.bytes, bytes);
  assert.equal(stored.options.customMetadata.size, String(bytes.byteLength));
});
