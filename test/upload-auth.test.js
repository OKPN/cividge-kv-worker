import assert from "node:assert/strict";
import test from "node:test";
import { onRequestPost, putR2Upload, verifyUploadAuth } from "../upload.js";

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

test("R2 upload publishes its canonical Link through the in-process registry", async () => {
  const records = new Map();
  const lifecycleCalls = [];
  const env = {
    TEST_UPLOAD_TOKEN: "test-upload-token",
    ADMIN_API_TOKEN: "admin-token",
    R2_BUCKET: {
      async put(_key, body) { await new Response(body).arrayBuffer(); },
    },
    CIVIDGE_KV: {
      async getWithMetadata(key) { return records.get(key) || { value: null, metadata: null }; },
      async put(key, value, options) { records.set(key, { value, metadata: options.metadata }); },
    },
    OBJECT_LIFECYCLE: {
      idFromName(value) { return value; },
      get() {
        return {
          async fetch(_url, options) {
            const body = JSON.parse(options.body);
            lifecycleCalls.push(body);
            return Response.json({
              lifecycle: {
                objectRef: body.objectRef,
                links: [body.linkKey],
                placements: { r2: { state: "PRESENT" } },
              },
            });
          },
        };
      },
    },
  };
  const request = new Request(
    "https://worker.example/api/upload?storage=r2&domain=test-up.pages.dev&naming=original",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer test-upload-token",
        "Content-Type": "image/webp",
        "X-Upload-Filename": "fresh.webp",
      },
      body: new TextEncoder().encode("fresh-r2-object"),
    },
  );

  const response = await onRequestPost({ request, env, waitUntil() {} });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.url, "https://test-up.pages.dev/fresh.webp");
  assert.equal(records.has("test-up.pages.dev:fresh.webp"), true);
  assert.equal(lifecycleCalls[0].action, "createLink");
  assert.equal(lifecycleCalls[0].objectRef, "r2:fresh.webp");
});
