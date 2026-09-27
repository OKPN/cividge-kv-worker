import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
const oid = label => `sha256:${createHash("sha256").update(label).digest("hex")}`;
import { onRequestPost, putR2Upload, verifyUploadAuth, calculateUploadCid, classifyUpload, reserveUploadLink, claimUploadPlacement, executeR2Acquisition, executeFilebaseRpcAcquisition, MAX_UPLOAD_BYTES } from "../upload.js";
import { ObjectLifecycleV2 as ObjectLifecycle } from "../lifecycle.js";
import { LinkBindingV2 as LinkBinding } from "../link-binding.js";
import { callLifecycle } from "../lifecycle-api.js";
import { callLinkBinding } from "../link-binding-api.js";
import { objectIdFromBytes } from "../object-id.js";

function memoryNamespace(Class, env) {
  const objects = new Map();
  return { idFromName: value => value, get(id) {
    if (!objects.has(id)) {
      const records = new Map();
      const instance = new Class({ storage: {
        get: async key => records.get(key),
        put: async (key, value) => records.set(key, structuredClone(value)),
        delete: async key => records.delete(key),
        setAlarm: async () => {}, deleteAlarm: async () => {},
      } }, env);
      objects.set(id, instance);
    }
    return { fetch: (url, options) => objects.get(id).fetch(new Request(url, options)) };
  } };
}

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

test("external upload limit is decimal 80 MB before physical PUT", async () => {
  assert.equal(MAX_UPLOAD_BYTES, 80_000_000);
  let puts = 0;
  const response = await onRequestPost({
    request: new Request("https://worker.example/api/upload?storage=r2", {
      method: "POST", headers: { Authorization: "Bearer upload", "Content-Length": String(MAX_UPLOAD_BYTES + 1) },
      body: "small",
    }),
    env: { UPLOAD_TOKEN: "upload", CIVIDGE_KV: {}, OBJECT_LIFECYCLE: {},
      R2_BUCKET: { put: async () => { puts++; } } },
  });
  assert.equal(response.status, 413);
  assert.equal(puts, 0);
  assert.match((await response.json()).error, /80 MB/);
});

test("preflight content identity is deterministic for final bytes", async () => {
  const bytes = new TextEncoder().encode("cividge-preflight");
  const first = await calculateUploadCid(bytes);
  assert.match(first, /^Qm/);
  assert.equal(await calculateUploadCid(bytes), first);
  assert.notEqual(await calculateUploadCid(new TextEncoder().encode("other")), first);
});

test("preflight classifies conflict, no-op, peer, reacquire and new Object without PUT", () => {
  const ref = oid("ipfs:cid");
  const rpc = { state: "PRESENT" };
  const browser = { state: "PRESENT" };
  assert.equal(classifyUpload({ objectRef: oid("ipfs:other"), status: "BOUND" }, null, "filebase_rpc", true, ref), "conflict");
  assert.equal(classifyUpload({ objectRef: ref, status: "BOUND" },
    { placements: { filebase_rpc: rpc } }, "filebase_rpc", true, ref), "noop");
  assert.equal(classifyUpload(null, { placements: { filebase: browser } }, "filebase_rpc", false, ref), "create");
  assert.equal(classifyUpload(null, { placements: { filebase_rpc: rpc, r2: browser } }, "filebase_rpc", false, ref), "peer");
  assert.equal(classifyUpload({ objectRef: ref, status: "BOUND" },
    { placements: { filebase: browser } }, "filebase_rpc", true, ref), "reacquire");
  assert.equal(classifyUpload(null, null, "filebase_rpc", false, ref), "create");
});

test("preflight reserves a canonical Link with planned physical locator", async () => {
  const env = {};
  env.LINK_BINDING = memoryNamespace(LinkBinding, env);
  const args = { linkKey: "public.example:x.webp", objectRef: oid("r2:objects/cid"),
    placement: { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "objects/cid" } },
    classification: "create", attemptId: "attempt-1" };
  const { binding } = await reserveUploadLink(env, args);
  assert.equal(binding.attempt.placement.locator.key, "objects/cid");
  assert.equal(binding.status, "RESERVED");
  const inspected = (await callLinkBinding(env, { action: "inspect", linkKey: args.linkKey })).binding;
  assert.equal(inspected.objectRef, args.objectRef);
  await assert.rejects(reserveUploadLink(env, { ...args, attemptId: "attempt-2" }), /unfinished upload attempt/);
});

test("preflight claims acquisition before any R2 PUT", async () => {
  const env = { R2_BUCKET_NAME: "cividge" };
  env.OBJECT_LIFECYCLE = memoryNamespace(ObjectLifecycle, env);
  const placement = { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "objects/cid" } };
  const claim = await claimUploadPlacement(env, oid("r2:objects/cid"), placement);
  assert.equal(claim.operation, "acquire");
  assert.equal(claim.locator.key, "objects/cid");
  const state = (await callLifecycle(env, { action: "inspect", objectRef: oid("r2:objects/cid") })).lifecycle;
  assert.equal(state.placements.r2.state, "PINNING");
  assert.deepEqual(state.links, []);
});

test("post-PUT report failure keeps a durable retry and adopts the same R2 Object", async () => {
  const env = { R2_BUCKET_NAME: "cividge" };
  env.OBJECT_LIFECYCLE = memoryNamespace(ObjectLifecycle, env);
  const rawBinding = memoryNamespace(LinkBinding, env);
  let loseReport = true;
  env.LINK_BINDING = { idFromName: rawBinding.idFromName, get(id) {
    const stub = rawBinding.get(id);
    return { fetch: (url, options) => {
      if (JSON.parse(options.body).action === "markPhysical" && loseReport) {
        loseReport = false;
        return Response.json({ error: "response lost" }, { status: 503 });
      }
      return stub.fetch(url, options);
    } };
  } };
  const bytes = new TextEncoder().encode("recoverable-r2");
  const contentCid = await calculateUploadCid(bytes);
  const key = `objects/${contentCid}`;
  const objectRef = await objectIdFromBytes(bytes);
  const linkKey = "public.example:recover.webp";
  const placement = { kind: "r2", executor: "worker", locator: { bucket: "cividge", key } };
  const reservation = await reserveUploadLink(env, { linkKey, objectRef, placement,
    classification: "create", attemptId: "retry-1" });
  const objects = new Map();
  let puts = 0;
  env.R2_BUCKET = {
    head: async key => objects.get(key) || null,
    put: async (key, body, options) => {
      puts++;
      objects.set(key, { customMetadata: options.customMetadata,
        bytes: await new Response(body).arrayBuffer() });
    },
  };
  const args = { objectRef, linkKey, attemptId: "retry-1",
    attemptGeneration: reservation.binding.attempt.generation, contentCid, key, bytes, contentType: "image/webp" };
  await assert.rejects(executeR2Acquisition(env, { ...args,
    claim: await claimUploadPlacement(env, objectRef, placement) }), /response lost/);
  assert.equal(puts, 1);
  assert.equal((await callLifecycle(env, { action: "inspect", objectRef })).lifecycle.placements.r2.state, "PIN_REQUESTED");
  assert.equal((await callLinkBinding(env, { action: "inspect", linkKey })).binding.status, "RESERVED");
  await executeR2Acquisition(env, { ...args, claim: await claimUploadPlacement(env, objectRef, placement) });
  assert.equal(puts, 1);
  assert.equal((await callLifecycle(env, { action: "inspect", objectRef })).lifecycle.placements.r2.state, "PRESENT");
});

test("different content at an occupied Link conflicts before R2 PUT", async () => {
  let puts = 0;
  const env = { UPLOAD_TOKEN: "upload", R2_BUCKET_NAME: "cividge", CIVIDGE_KV: {}, OBJECT_LIFECYCLE: {},
    R2_BUCKET: { put: async () => { puts++; } },
    LINK_BINDING: { idFromName: value => value, get: () => ({ fetch: async () =>
      Response.json({ binding: { objectRef: oid("r2:objects/other"), status: "BOUND" } }) }) },
  };
  const response = await onRequestPost({ env, request: new Request(
    "https://worker.example/api/upload?storage=r2&domain=public.example&naming=original", {
      method: "POST", headers: { Authorization: "Bearer upload", "X-Upload-Filename": "same.webp",
        "Content-Type": "image/webp" }, body: "new bytes",
    }), waitUntil() {} });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "LINK_OBJECT_CONFLICT");
  assert.equal(puts, 0);
});

test("R2 upload publishes its canonical Link through the in-process registry", async () => {
  const records = new Map();
  const objects = new Map();
  const env = {
    TEST_UPLOAD_TOKEN: "test-upload-token",
    ADMIN_API_TOKEN: "admin-token",
    R2_BUCKET_NAME: "cividge",
    R2_BUCKET: {
      async put(key, body, options) { objects.set(key, { bytes: await new Response(body).arrayBuffer(), options }); },
      async head(key) { const found = objects.get(key); return found ? { customMetadata: found.options.customMetadata } : null; },
    },
    CIVIDGE_KV: {
      async getWithMetadata(key) { return records.get(key) || { value: null, metadata: null }; },
      async put(key, value, options) { records.set(key, { value, metadata: options.metadata }); },
    },
  };
  env.OBJECT_LIFECYCLE = memoryNamespace(ObjectLifecycle, env);
  env.LINK_BINDING = memoryNamespace(LinkBinding, env);
  const bytes = new TextEncoder().encode("fresh-r2-object");
  const request = new Request(
    "https://worker.example/api/upload?storage=r2&domain=test-up.pages.dev&naming=original",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer test-upload-token",
        "Content-Type": "image/webp",
        "X-Upload-Filename": "fresh.webp",
      },
      body: bytes,
    },
  );

  const response = await onRequestPost({ request, env, waitUntil() {} });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.url, "https://test-up.pages.dev/fresh.webp");
  assert.equal(records.has("test-up.pages.dev:fresh.webp"), true);
  const cid = await calculateUploadCid(bytes);
  const objectRef = await objectIdFromBytes(bytes);
  const lifecycle = (await callLifecycle(env, { action: "inspect", objectRef })).lifecycle;
  assert.deepEqual(lifecycle.links, ["test-up.pages.dev:fresh.webp"]);
  assert.equal(lifecycle.placements.r2.state, "PRESENT");
  assert.equal(objects.has(`objects/${cid}`), true);
});

test("Filebase CID mismatch records observation but never publishes or unpins", async () => {
  const env = { FILEBASE_DEDICATED_BUCKET: "true", FILEBASE_IPFS_API_KEY: "bucket-token" };
  env.OBJECT_LIFECYCLE = memoryNamespace(ObjectLifecycle, env);
  env.LINK_BINDING = memoryNamespace(LinkBinding, env);
  const bytes = new TextEncoder().encode("expected-content");
  const contentCid = await calculateUploadCid(bytes);
  const otherCid = await calculateUploadCid(new TextEncoder().encode("other-content"));
  const objectRef = await objectIdFromBytes(bytes);
  const linkKey = "public.example:mismatch.webp";
  const placement = { kind: "filebase_rpc", executor: "worker",
    provenance: "cividge_worker_rpc", locator: { cid: contentCid } };
  const reservation = await reserveUploadLink(env, { linkKey, objectRef, placement,
    classification: "create", attemptId: "mismatch-1" });
  const claim = await claimUploadPlacement(env, objectRef, placement);
  const oldFetch = globalThis.fetch;
  let unpins = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/pin/ls")) return Response.json({ Keys: {} });
    if (String(url).includes("/add?")) return Response.json({ Hash: otherCid });
    if (String(url).includes("/pin/rm")) unpins++;
    throw new Error("unexpected RPC operation");
  };
  try {
    await assert.rejects(executeFilebaseRpcAcquisition(env, { objectRef, linkKey,
      attemptId: "mismatch-1", attemptGeneration: reservation.binding.attempt.generation,
      claim, contentCid, bytes, filename: "mismatch.webp", contentType: "image/webp" }),
    /manual bucket inspection required/);
  } finally { globalThis.fetch = oldFetch; }
  assert.equal(unpins, 0);
  assert.equal((await callLinkBinding(env, { action: "inspect", linkKey })).binding.attempt.unexpectedCid, otherCid);
  const state = (await callLifecycle(env, { action: "inspect", objectRef })).lifecycle;
  assert.deepEqual(state.links, []);
  assert.notEqual(state.placements.filebase_rpc.state, "PRESENT");
});

test("Filebase RPC acquisition confirms Placement before Link publication", async () => {
  const env = { FILEBASE_DEDICATED_BUCKET: "true", FILEBASE_IPFS_API_KEY: "bucket-token" };
  env.OBJECT_LIFECYCLE = memoryNamespace(ObjectLifecycle, env);
  env.LINK_BINDING = memoryNamespace(LinkBinding, env);
  const bytes = new TextEncoder().encode("new-filebase-rpc-content");
  const contentCid = await calculateUploadCid(bytes);
  const objectRef = await objectIdFromBytes(bytes);
  const linkKey = "public.example:rpc.webp";
  const placement = { kind: "filebase_rpc", executor: "worker",
    provenance: "cividge_worker_rpc", locator: { cid: contentCid } };
  const reservation = await reserveUploadLink(env, { linkKey, objectRef, placement,
    classification: "create", attemptId: "rpc-1" });
  const claim = await claimUploadPlacement(env, objectRef, placement);
  const oldFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/pin/ls")) return Response.json({ Keys: {} });
    if (String(url).includes("/add?")) { adds++; return Response.json({ Hash: contentCid }); }
    throw new Error("unexpected RPC operation");
  };
  try {
    await executeFilebaseRpcAcquisition(env, { objectRef, linkKey,
      attemptId: "rpc-1", attemptGeneration: reservation.binding.attempt.generation,
      claim, contentCid, bytes, filename: "rpc.webp", contentType: "image/webp" });
  } finally { globalThis.fetch = oldFetch; }
  assert.equal(adds, 1);
  const state = (await callLifecycle(env, { action: "inspect", objectRef })).lifecycle;
  assert.equal(state.placements.filebase_rpc.state, "PRESENT");
  assert.deepEqual(state.links, []);
});

test("Filebase upload publishes only after confirmed managed RPC Placement", async () => {
  const records = new Map();
  const env = {
    UPLOAD_TOKEN: "upload-token", ADMIN_API_TOKEN: "admin-token",
    FILEBASE_DEDICATED_BUCKET: "true", FILEBASE_IPFS_API_KEY: "bucket-token",
    CIVIDGE_KV: {
      getWithMetadata: async key => records.get(key) || { value: null, metadata: null },
      put: async (key, value, options) => records.set(key, { value, metadata: options.metadata }),
    },
  };
  env.OBJECT_LIFECYCLE = memoryNamespace(ObjectLifecycle, env);
  env.LINK_BINDING = memoryNamespace(LinkBinding, env);
  const bytes = new TextEncoder().encode("worker-filebase-upload");
  const cid = await calculateUploadCid(bytes);
  const oldFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/pin/ls")) return Response.json({ Keys: {} });
    if (String(url).includes("/add?")) { adds++; return Response.json({ Hash: cid }); }
    throw new Error("unexpected RPC operation");
  };
  let response;
  try {
    response = await onRequestPost({ env, request: new Request(
      "https://worker.example/api/upload?storage=filebase&domain=public.example&naming=original", {
        method: "POST", headers: { Authorization: "Bearer upload-token",
          "X-Upload-Filename": "rpc.webp", "Content-Type": "image/webp" }, body: bytes,
      }), waitUntil() {} });
  } finally { globalThis.fetch = oldFetch; }
  assert.equal(response.status, 200, await response.text());
  assert.equal(adds, 1);
  assert.equal(records.has("public.example:rpc.webp"), true);
  const state = (await callLifecycle(env, { action: "inspect", objectRef: await objectIdFromBytes(bytes) })).lifecycle;
  assert.equal(state.placements.filebase_rpc.state, "PRESENT");
  assert.deepEqual(state.links, ["public.example:rpc.webp"]);
  const oldFetchAgain = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("no-op must not call Filebase"); };
  try {
    const repeat = await onRequestPost({ env, request: new Request(
      "https://worker.example/api/upload?storage=filebase&domain=public.example&naming=original", {
        method: "POST", headers: { Authorization: "Bearer upload-token",
          "X-Upload-Filename": "rpc.webp", "Content-Type": "image/webp" }, body: bytes,
      }), waitUntil() {} });
    assert.equal(repeat.status, 200);
    assert.equal((await repeat.json()).noOp, true);
  } finally { globalThis.fetch = oldFetchAgain; }
  assert.equal(adds, 1);
});

test("same final bytes uploaded to R2 and Filebase converge on one ObjectLifecycle", async () => {
  const records = new Map();
  const physicalR2 = new Map();
  const env = {
    UPLOAD_TOKEN: "upload", ADMIN_API_TOKEN: "admin", R2_BUCKET_NAME: "cividge",
    FILEBASE_DEDICATED_BUCKET: "true", FILEBASE_IPFS_API_KEY: "bucket-token",
    R2_BUCKET: {
      async put(key, body, options) { physicalR2.set(key, { bytes: await new Response(body).arrayBuffer(), customMetadata: options.customMetadata }); },
      async head(key) { return physicalR2.get(key) || null; },
    },
    CIVIDGE_KV: {
      async getWithMetadata(key) { return records.get(key) || { value: null, metadata: null }; },
      async put(key, value, options) { records.set(key, { value, metadata: options.metadata }); },
    },
  };
  env.OBJECT_LIFECYCLE = memoryNamespace(ObjectLifecycle, env);
  env.LINK_BINDING = memoryNamespace(LinkBinding, env);
  const content = new TextEncoder().encode("one object, two storage providers");
  const objectId = await objectIdFromBytes(content);
  const cid = await calculateUploadCid(content);
  const request = (storage, filename) => new Request(
    `https://worker.example/api/upload?storage=${storage}&domain=public.example&naming=original`, {
      method: "POST", headers: { Authorization: "Bearer upload", "X-Upload-Filename": filename,
        "Content-Type": "image/webp" }, body: content,
    });
  const r2 = await onRequestPost({ env, request: request("r2", "r2.webp"), waitUntil() {} });
  assert.equal(r2.status, 200, await r2.text());
  const priorFetch = globalThis.fetch;
  let rpcAdds = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/pin/ls")) return Response.json({ Keys: {} });
    if (String(url).includes("/add?")) { rpcAdds++; return Response.json({ Hash: cid }); }
    throw new Error("Unexpected Filebase RPC request");
  };
  try {
    const sameLink = await onRequestPost({ env, request: request("filebase", "r2.webp"), waitUntil() {} });
    assert.equal(sameLink.status, 200, await sameLink.text());
    assert.equal(records.get("public.example:r2.webp").metadata.b, "r2");
    const filebase = await onRequestPost({ env, request: request("filebase", "filebase.webp"), waitUntil() {} });
    assert.equal(filebase.status, 200, await filebase.text());
  } finally { globalThis.fetch = priorFetch; }
  const lifecycle = (await callLifecycle(env, { action: "inspect", objectRef: objectId })).lifecycle;
  assert.deepEqual(lifecycle.links, ["public.example:filebase.webp", "public.example:r2.webp"]);
  assert.equal(lifecycle.placements.r2.state, "PRESENT");
  assert.equal(lifecycle.placements.filebase_rpc.state, "PRESENT");
  assert.equal(lifecycle.placements.filebase_rpc.locator.cid, cid);
  assert.equal(rpcAdds, 1);
  assert.equal(physicalR2.size, 1);
  assert.equal(records.get("public.example:r2.webp").metadata.oid, objectId);
  assert.equal(records.get("public.example:filebase.webp").metadata.oid, objectId);
});
