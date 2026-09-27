import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
const oid = label => `sha256:${createHash("sha256").update(label).digest("hex")}`;

import { onRequest as deliver } from "../delivery.js";
import { onRequestDelete, onRequestPost, onRequestGet } from "../cividge-kv.js";
import { onRequestPost as onLifecyclePost, syncLifecycleProjection, isManagedRpcReleaseEnabled } from "../lifecycle-api.js";
import { ObjectLifecycleV2 as ObjectLifecycle } from "../lifecycle.js";
import { LinkBindingV2 as LinkBinding } from "../link-binding.js";
import { callLinkBinding } from "../link-binding-api.js";
import {
  addLink,
  beginRemoveLink,
  claimPlacement,
  completeRemoveLink,
  newLifecycle,
  reportPlacement,
  requestPlacementAcquire,
  requestPlacementRelease,
  requestRelease,
  recoverExpiredPlacementClaims,
  reconcilePlacementForAcquire,
  PLACEMENT_CLAIM_LEASE_MS,
  removeLink,
} from "../lifecycle-model.js";

function memoryKv(records = new Map()) {
  const calls = { get: [], put: [], delete: [] };
  return {
    calls,
    async getWithMetadata(key) {
      calls.get.push(key);
      return records.get(key) || { value: null, metadata: null };
    },
    async get(key) { return records.get(key)?.value ?? null; },
    async put(key, value, options = {}) {
      calls.put.push({ key, value, options });
      records.set(key, { value, metadata: options.metadata || {} });
    },
    async delete(key) {
      calls.delete.push(key);
      records.delete(key);
    },
  };
}

function memoryBindingNamespace() {
  const objects = new Map();
  return { idFromName: value => value, get(id) {
    if (!objects.has(id)) {
      const values = new Map();
      const object = new LinkBinding({ storage: {
        get: async key => values.get(key),
        put: async (key, value) => values.set(key, structuredClone(value)),
        delete: async key => values.delete(key),
      } });
      objects.set(id, object);
    }
    return { fetch: (url, options) => objects.get(id).fetch(new Request(url, options)) };
  } };
}

async function bindExisting(env, linkKey, objectRef) {
  const { binding } = await callLinkBinding(env, { action: "reserve", linkKey, objectRef, attemptId: "seed" });
  await callLinkBinding(env, { action: "commit", linkKey, attemptId: "seed", generation: binding.attempt.generation });
}

function context(url, env) {
  return {
    request: new Request(url),
    env,
    waitUntil() {},
    next: () => new Response("not found", { status: 404 }),
  };
}

test("an expired R2 Link cannot delete its Object or a peer Link during GET", async () => {
  const filename = "shared.webp";
  const first = `a.example:${filename}`;
  const second = `b.example:${filename}`;
  const kv = memoryKv(new Map([
    [first, { value: "", metadata: { b: "r2", k_s3: "shared.webp", e: 1 } }],
    [second, { value: "", metadata: { b: "r2", k_s3: "shared.webp" } }],
  ]));
  const r2Deletes = [];
  const response = await deliver(context(`https://a.example/${filename}`, {
    CIVIDGE_KV: kv,
    R2_BUCKET: { delete: async (key) => r2Deletes.push(key) },
  }));

  assert.equal(response.status, 404);
  assert.deepEqual(kv.calls.delete, []);
  assert.deepEqual(r2Deletes, []);
  assert.equal(kv.calls.get.filter((key) => key === first).length, 1);
  assert.ok(await kv.getWithMetadata(second));
});

test("unknown media uses exactly one canonical host-qualified KV lookup", async () => {
  const kv = memoryKv();
  const response = await deliver(context("https://public.example/missing.webp", { CIVIDGE_KV: kv }));

  assert.equal(response.status, 404);
  assert.deepEqual(kv.calls.get, ["public.example:missing.webp"]);
});

test("KV read failure is unavailable, never a cached not-found", async () => {
  const kv = memoryKv();
  kv.getWithMetadata = async key => { kv.calls.get.push(key); throw new Error("KV unavailable"); };
  const response = await deliver(context("https://public.example/media.webp", { CIVIDGE_KV: kv }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(kv.calls.get, ["public.example:media.webp"]);
});

test("known R2 Link with missing origin is unavailable, not 404", async () => {
  const kv = memoryKv(new Map([["public.example:media.webp", {
    value: "", metadata: { b: "r2", k_s3: "media.webp" },
  }]]));
  const response = await deliver(context("https://public.example/media.webp", {
    CIVIDGE_KV: kv, R2_BUCKET: { get: async () => null },
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(kv.calls.get, ["public.example:media.webp"]);
});

test("a clean authority ignores responses cached under the previous delivery epoch", async () => {
  const prior = globalThis.caches;
  const seen = [];
  const kv = memoryKv();
  globalThis.caches = { default: {
    match: async request => {
      seen.push(new URL(request.url).searchParams.get("__cividge_cache_epoch"));
      return new URL(request.url).searchParams.has("__cividge_cache_epoch") ? undefined :
        new Response("old object", { status: 200 });
    },
    put: async () => {},
  } };
  try {
    const response = await deliver(context("https://public.example/old.webp", { CIVIDGE_KV: kv }));
    assert.equal(response.status, 404);
    assert.deepEqual(seen, ["5"]);
    assert.deepEqual(kv.calls.get, ["public.example:old.webp"]);
  } finally { globalThis.caches = prior; }
});

test("human HTML 404 embeds its character without a second request", async () => {
  const kv = memoryKv();
  const response = await deliver({ ...context("https://public.example/missing.webp", { CIVIDGE_KV: kv }),
    request: new Request("https://public.example/missing.webp", {
      headers: { "Sec-Fetch-Mode": "navigate", Accept: "image/webp" },
    }) });
  const html = await response.text();
  assert.equal(response.status, 404);
  assert.match(html, /src="data:image\/webp;base64,[A-Za-z0-9+/=]+"/);
  assert.doesNotMatch(html, /src="\/404-character\.webp"|onerror=/);
});

test("a cached SVG 404 cannot replace a human navigation", async () => {
  const prior = globalThis.caches;
  const kv = memoryKv();
  globalThis.caches = { default: {
    match: async () => new Response("<svg/>", { status: 404, headers: { "Content-Type": "image/svg+xml" } }),
    put: async () => {},
  } };
  try {
    const response = await deliver({ ...context("https://public.example/missing.webp", { CIVIDGE_KV: kv }),
      request: new Request("https://public.example/missing.webp", {
        headers: { "Sec-Fetch-Mode": "navigate", Accept: "image/webp" },
      }) });
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await response.text(), /src="data:image\/webp;base64,/);
    assert.deepEqual(kv.calls.get, []);
  } finally { globalThis.caches = prior; }
});

test("an older cached HTML 404 with a dependent image is replaced", async () => {
  const prior = globalThis.caches;
  globalThis.caches = { default: {
    match: async () => new Response('<img src="/404-character.webp">', {
      status: 404, headers: { "Content-Type": "text/html" },
    }),
    put: async () => {},
  } };
  try {
    const response = await deliver({ ...context("https://public.example/missing.webp", { CIVIDGE_KV: memoryKv() }),
      request: new Request("https://public.example/missing.webp", { headers: { Accept: "text/html" } }) });
    assert.match(await response.text(), /src="data:image\/webp;base64,/);
  } finally { globalThis.caches = prior; }
});

test("relay probe identifies only the uniquely allowed canonical public host", async () => {
  const env = { STATIC_RELAY_PUBLIC_HOSTS: "content-relay.pages.dev,content-cache.pages.dev" };
  const correct = await deliver(context("https://relay.example/r/content-cache/404-character.webp", env));
  assert.equal(correct.status, 200);
  assert.equal(correct.headers.get("x-cividge-relay-host"), "content-cache.pages.dev");
  const wrong = await deliver(context("https://relay.example/r/unknown/404-character.webp", env));
  assert.equal(wrong.status, 404);
  const ambiguous = await deliver(context("https://relay.example/r/content-cache/404-character.webp", {
    STATIC_RELAY_PUBLIC_HOSTS: "content-cache.pages.dev,content-cache.example",
  }));
  assert.equal(ambiguous.status, 404);
});

test("relay identity probe bypasses a stale cached character 404", async () => {
  const prior = globalThis.caches;
  globalThis.caches = { default: {
    match: async () => new Response("<svg/>", { status: 404, headers: { "Content-Type": "image/svg+xml" } }),
    put: async () => {},
  } };
  try {
    const response = await deliver(context("https://relay.example/r/content-cache/404-character.webp", {
      STATIC_RELAY_PUBLIC_HOSTS: "content-cache.pages.dev",
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-cividge-relay-host"), "content-cache.pages.dev");
  } finally { globalThis.caches = prior; }
});

test("retired Link generation hides stale KV and explicit rebind creates a newer generation", async () => {
  const key = "public.example:again.webp";
  const env = { ADMIN_API_TOKEN: "secret", LINK_BINDING: memoryBindingNamespace() };
  await bindExisting(env, key, oid("r2:old"));
  const old = (await callLinkBinding(env, { action: "inspect", linkKey: key })).binding;
  const records = new Map([[key, { value: "", metadata: { b: "r2", k_s3: "old", g: old.generation } }]]);
  env.CIVIDGE_KV = {
    getWithMetadata: async name => records.get(name) || { value: null, metadata: null },
    list: async () => ({ keys: [...records].map(([name, entry]) => ({ name, metadata: entry.metadata })), list_complete: true }),
  };
  const list = () => onRequestGet({ request: new Request("https://worker.example/api/cividge-kv", {
    headers: { Authorization: "Bearer secret" },
  }), env });
  assert.equal((await list()).status, 200);
  assert.equal((await (await list()).json()).files.length, 1);
  await callLinkBinding(env, { action: "beginRemove", linkKey: key });
  await callLinkBinding(env, { action: "completeRemove", linkKey: key });
  const retired = (await callLinkBinding(env, { action: "inspect", linkKey: key })).binding;
  assert.equal(retired.status, "RETIRED");
  assert.deepEqual((await (await list()).json()).files, []);
  const reserved = (await callLinkBinding(env, { action: "reserve", linkKey: key,
    objectRef: oid("r2:new"), attemptId: "new-upload" })).binding;
  await callLinkBinding(env, { action: "commit", linkKey: key,
    attemptId: "new-upload", generation: reserved.attempt.generation });
  assert.ok(reserved.generation > old.generation);
  const staleDelete = await onRequestDelete({ request: new Request(
    `https://worker.example/api/cividge-kv?key=${encodeURIComponent(key)}&generation=${old.generation}`, {
      method: "DELETE", headers: { Authorization: "Bearer secret" },
    }), env, waitUntil() {} });
  assert.equal(staleDelete.status, 409);
  assert.deepEqual((await (await list()).json()).files, []); // old KV projection is still stale
  records.set(key, { value: "", metadata: { b: "r2", k_s3: "new", g: reserved.generation } });
  assert.equal((await (await list()).json()).files.length, 1);
});

test("admin list and lookup never regress behind acknowledged Link expiry policy", async () => {
  const key = "public.example:ttl.webp";
  const env = { ADMIN_API_TOKEN: "secret", LINK_BINDING: memoryBindingNamespace() };
  await bindExisting(env, key, oid("r2:objects/ttl"));
  const binding = (await callLinkBinding(env, { action: "inspect", linkKey: key })).binding;
  const oldExpiry = Date.now() + 3 * 86400000;
  const newExpiry = Date.now() + 7 * 86400000;
  const records = new Map([[key, { value: "", metadata: { b: "r2", k_s3: "objects/ttl",
    g: binding.generation, e: Math.floor(oldExpiry / 1000) } }]]);
  env.CIVIDGE_KV = {
    getWithMetadata: async name => records.get(name) || { value: null, metadata: null },
    list: async () => ({ keys: [...records].map(([name, entry]) => ({ name, metadata: entry.metadata })), list_complete: true }),
  };
  await callLinkBinding(env, { action: "acknowledgePolicy", linkKey: key,
    generation: binding.generation, expiresAt: newExpiry });
  const headers = { Authorization: "Bearer secret" };
  const list = await onRequestGet({ request: new Request("https://worker.example/api/cividge-kv", { headers }), env });
  const listed = (await list.json()).files[0].metadata;
  assert.equal(listed.expiresAt, Math.floor(newExpiry / 1000) * 1000);
  assert.equal(listed.policyRevision, 1);
  const lookup = await onRequestGet({ request: new Request(`https://worker.example/api/cividge-kv?key=${encodeURIComponent(key)}`, { headers }), env });
  assert.equal((await lookup.json()).metadata.policyRevision, 1);
  await callLinkBinding(env, { action: "acknowledgePolicy", linkKey: key,
    generation: binding.generation, expiresAt: null });
  const cleared = await onRequestGet({ request: new Request("https://worker.example/api/cividge-kv", { headers }), env });
  assert.equal((await cleared.json()).files[0].metadata.expiresAt, null);
});

test("Placement reacquisition does not change a live Link generation", async () => {
  const env = { LINK_BINDING: memoryBindingNamespace() };
  const linkKey = "public.example:same.webp";
  await bindExisting(env, linkKey, oid("ipfs:cid"));
  const before = (await callLinkBinding(env, { action: "inspect", linkKey })).binding;
  const reserved = (await callLinkBinding(env, { action: "reserve", linkKey,
    objectRef: oid("ipfs:cid"), attemptId: "reacquire", acquirePlacement: true,
    placement: { kind: "filebase_rpc", locator: { cid: "cid" } } })).binding;
  assert.equal(reserved.generation, before.generation);
  assert.ok(reserved.attempt.generation > before.attemptGeneration);
});

test("LinkBinding uses the clean ObjectId routing epoch without changing public Link identity", async () => {
  const names = [];
  const namespace = memoryBindingNamespace();
  const env = { LINK_BINDING: { ...namespace, idFromName(name) { names.push(name); return name; } } };
  const linkKey = "public.example:clean.webp";
  await callLinkBinding(env, { action: "inspect", linkKey });
  assert.deepEqual(names, ["objectid-v1:" + linkKey]);
});

test("registry rejects bare Link keys and canonicalizes the host in accepted keys", async () => {
  const kv = memoryKv();
  const lifecycleCalls = [];
  const env = {
    CIVIDGE_KV: kv,
    ADMIN_API_TOKEN: "secret",
    R2_BUCKET_NAME: "cividge",
    LINK_BINDING: memoryBindingNamespace(),
    OBJECT_LIFECYCLE: {
      idFromName: (name) => name,
      get: () => ({ fetch: async (_url, options) => {
        lifecycleCalls.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ lifecycle: {
          placements: { r2: { state: "PRESENT", kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "ok.webp" } } },
        } }), { status: 200 });
      } }),
    },
  };
  const headers = { Authorization: "Bearer secret", "Content-Type": "application/json" };

  const bare = await onRequestPost({ request: new Request("https://worker.example/api/cividge-kv", {
    method: "POST", headers, body: JSON.stringify({ key: "bare.webp", cid: "", objectId: oid("bare"), backend: "r2", s3Key: "bare.webp" }),
  }), env, waitUntil() {} });
  assert.equal(bare.status, 400);

  const canonical = await onRequestPost({ request: new Request("https://worker.example/api/cividge-kv", {
    method: "POST", headers, body: JSON.stringify({ key: "PUBLIC.EXAMPLE:ok.webp", cid: "", objectId: oid("r2:ok.webp"), backend: "r2", bucket: "cividge", s3Key: "ok.webp", thumbnailKey: "ok.webp.thumb.webp", allowedHost: "other.example" }),
  }), env, waitUntil() {} });
  assert.equal(canonical.status, 200);
  assert.equal(kv.calls.put[0].key, "public.example:ok.webp");
  assert.equal(kv.calls.put[0].options.metadata.d, "public.example");
  assert.equal(kv.calls.put[0].options.metadata.g, 1);
  assert.equal(kv.calls.put[0].options.metadata.th, undefined, "client thumbnail names cannot create derived artifacts");
  assert.equal(lifecycleCalls[0].objectRef, oid("r2:ok.webp"));
});

test("failed LinkBinding commit never publishes a KV projection", async () => {
  const kv = memoryKv();
  const bindings = memoryBindingNamespace();
  const originalGet = bindings.get;
  bindings.get = id => {
    const stub = originalGet(id);
    return { fetch: async (url, options) => {
      if (JSON.parse(options.body).action === "commit") {
        return Response.json({ error: "commit failed" }, { status: 503 });
      }
      return stub.fetch(url, options);
    } };
  };
  const env = {
    CIVIDGE_KV: kv, ADMIN_API_TOKEN: "secret", R2_BUCKET_NAME: "cividge", LINK_BINDING: bindings,
    OBJECT_LIFECYCLE: {
      idFromName: value => value,
      get: () => ({ fetch: async () => Response.json({ lifecycle: {
        links: ["public.example:ok.webp"],
        placements: { r2: { state: "PRESENT", kind: "r2", locator: { bucket: "cividge", key: "ok.webp" } } },
      } }) }),
    },
  };
  const response = await onRequestPost({ request: new Request("https://worker.example/api/cividge-kv", {
    method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    body: JSON.stringify({ key: "public.example:ok.webp", cid: "", objectId: oid("ok"), backend: "r2", bucket: "cividge", s3Key: "ok.webp" }),
  }), env, waitUntil() {} });
  assert.notEqual(response.status, 200);
  assert.deepEqual(kv.calls.put, []);
});

test("creating an alias projection leaves the source Link and projection intact", async () => {
  const source = "test-up.pages.dev:shared.webp";
  const alias = "testunko.pages.dev:shared.webp";
  const records = new Map([
    [source, { value: "", metadata: { b: "r2", bk: "cividge", d: "test-up.pages.dev", k_s3: "shared.webp", oid: oid("r2:shared.webp"), s: 10 } }],
  ]);
  const kv = memoryKv(records);
  const state = newLifecycle(oid("r2:shared.webp"), [
    { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "shared.webp" } },
  ]);
  addLink(state, source);
  const env = {
    CIVIDGE_KV: kv,
    ADMIN_API_TOKEN: "secret",
    R2_BUCKET_NAME: "cividge",
    LINK_BINDING: memoryBindingNamespace(),
    OBJECT_LIFECYCLE: {
      idFromName: value => value,
      get: () => ({ fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.action === "createLink") addLink(state, body.linkKey, body.placements);
        return Response.json({ lifecycle: state });
      } }),
    },
  };
  const response = await onRequestPost({
    request: new Request("https://worker.example/api/cividge-kv", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        key: alias,
        cid: "",
        objectId: state.objectRef,
        backend: "r2",
        bucket: "cividge",
        s3Key: "shared.webp",
        createOnly: true,
      }),
    }),
    env,
    waitUntil() {},
  });
  assert.equal(response.status, 200);
  assert.equal(records.has(source), true);
  assert.equal(records.has(alias), true);
  assert.deepEqual(state.links, [source, alias]);
});

test("a peer Link prevents release; the final Link alone makes release a candidate", () => {
  const state = newLifecycle(oid("r2:media/example.webp"), [
    { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "media/example.webp" } },
  ]);
  addLink(state, "public.example:a.webp");
  addLink(state, "mirror.example:b.webp");
  removeLink(state, "public.example:a.webp");
  assert.equal(state.links.length, 1);
  assert.throws(() => requestRelease(state), /active Links/);
  removeLink(state, "mirror.example:b.webp");
  requestRelease(state);
  assert.equal(state.state, "RELEASE_PENDING");
  assert.equal(state.placements.r2.state, "RELEASE_PENDING");
});

test("release is persisted before external execution and can retry safely", () => {
  const state = newLifecycle(oid("ipfs:bafytest"), [
    { kind: "filebase", executor: "browser", locator: { bucket: "cividge", key: "x.webp", cid: "bafytest" } },
  ]);
  addLink(state, "public.example:x.webp");
  removeLink(state, "public.example:x.webp");
  requestRelease(state);
  const first = claimPlacement(state, "filebase", "release", "claim-1").task;
  assert.equal(state.state, "RELEASING");
  reportPlacement(state, "filebase", { ...first, outcome: "retryable", error: "network unavailable" });
  assert.equal(state.state, "RELEASE_PENDING");
  assert.equal(state.placements.filebase.state, "RETRYABLE");
  const second = claimPlacement(state, "filebase", "release", "claim-2").task;
  reportPlacement(state, "filebase", { ...second, outcome: "released" });
  assert.equal(state.state, "RELEASED");
});

test("a retryable release converges after exact read-only placement observation", () => {
  const placement = { kind: "filebase", executor: "browser", locator: { bucket: "cividge", key: "objects/cid", cid: "cid" } };
  const state = newLifecycle(oid("ipfs:cid"), [placement]);
  addLink(state, "public.example:old.webp");
  removeLink(state, "public.example:old.webp");
  requestRelease(state);
  const claim = claimPlacement(state, "filebase", "release", "release-1").task;
  reportPlacement(state, "filebase", { ...claim, outcome: "retryable" });
  assert.throws(() => requestPlacementAcquire(state, placement), /must settle/);
  reconcilePlacementForAcquire(state, placement, "absent");
  assert.equal(state.state, "RELEASED");
  requestPlacementAcquire(state, placement);
  const acquire = claimPlacement(state, "filebase", "acquire", "acquire-1").task;
  reportPlacement(state, "filebase", { ...acquire, outcome: "present" });
  addLink(state, "public.example:new.webp");
  assert.equal(state.placements.filebase.state, "PRESENT");
  assert.deepEqual(state.links, ["public.example:new.webp"]);
});

test("fresh authority classes use the same Link and Object transitions", () => {
  assert.equal(ObjectLifecycle.name, "ObjectLifecycleV2");
  assert.equal(LinkBinding.name, "LinkBindingV2");
  assert.deepEqual(newLifecycle(oid("ipfs:bafy-fresh")).pendingLinkRemovals, []);
});

test("present inspection can adopt a retryable release but never an active claim", () => {
  const placement = { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "objects/cid" } };
  const state = newLifecycle(oid("r2:objects/cid"), [placement]);
  requestRelease(state);
  const claim = claimPlacement(state, "r2", "release", "release-1").task;
  assert.throws(() => reconcilePlacementForAcquire(state, placement, "present"), /cannot be reconciled/);
  reportPlacement(state, "r2", { ...claim, outcome: "retryable" });
  assert.throws(() => reconcilePlacementForAcquire(state,
    { ...placement, locator: { bucket: "cividge", key: "other" } }, "present"), /locator mismatch/);
  reconcilePlacementForAcquire(state, placement, "present");
  addLink(state, "public.example:again.webp");
  assert.equal(state.state, "ACTIVE");
});

test("a Link can cancel pending release but never resurrect releasing content", () => {
  const pending = newLifecycle(oid("r2:x.webp"), [{ kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "x.webp" } }]);
  requestRelease(pending);
  addLink(pending, "public.example:x.webp");
  assert.equal(pending.state, "ACTIVE");

  const releasing = newLifecycle(oid("r2:y.webp"), [{ kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "y.webp" } }]);
  requestRelease(releasing);
  claimPlacement(releasing, "r2", "release", "claim-r2");
  assert.throws(() => addLink(releasing, "public.example:y.webp"), /not linkable/);
});

test("uncertain RPC unpin cannot be converted back into a PRESENT Placement", () => {
  const cid = "Qm" + "a".repeat(44);
  const rpc = { kind: "filebase_rpc", executor: "worker", provenance: "cividge_worker_rpc", locator: { cid } };
  const state = newLifecycle(oid(cid), [rpc]);
  addLink(state, "public.example:rpc.webp");
  removeLink(state, "public.example:rpc.webp");
  requestRelease(state);
  const task = claimPlacement(state, "filebase_rpc", "release", "rpc-release").task;
  reportPlacement(state, "filebase_rpc", { ...task, outcome: "retryable", error: "response lost" });
  assert.throws(() => addLink(state, "public.example:rpc.webp"), /release has already started/);
  assert.equal(state.placements.filebase_rpc.state, "RETRYABLE");
  assert.deepEqual(claimPlacement(state, "filebase_rpc", "release", "rpc-retry").task.locator, { cid });
});

test("RPC actuator requires dedicated bucket and durable Worker provenance", () => {
  const cid = "Qm" + "a".repeat(44);
  const rpc = { kind: "filebase_rpc", executor: "worker", provenance: "cividge_worker_rpc", locator: { cid } };
  assert.throws(() => newLifecycle(oid(cid), [{ ...rpc, provenance: "browser_s3" }]), /provenance/);
  assert.equal(isManagedRpcReleaseEnabled({ FILEBASE_DEDICATED_BUCKET: "false", FILEBASE_IPFS_API_KEY: "key" }, rpc), false);
  assert.equal(isManagedRpcReleaseEnabled({ FILEBASE_DEDICATED_BUCKET: "true", FILEBASE_IPFS_API_KEY: "key" },
    { kind: "filebase", executor: "browser", locator: { bucket: "cividge", key: "x", cid } }), false);
  assert.equal(isManagedRpcReleaseEnabled({ FILEBASE_DEDICATED_BUCKET: "true", FILEBASE_IPFS_API_KEY: "key" }, rpc), true);
});

test("duplicate actuator reports are idempotent and contradictory reports fail", () => {
  const state = newLifecycle(oid("r2:duplicate.webp"), [{ kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "duplicate.webp" } }]);
  requestRelease(state);
  const task = claimPlacement(state, "r2", "release", "claim-duplicate").task;
  reportPlacement(state, "r2", { ...task, outcome: "released" });
  reportPlacement(state, "r2", { ...task, outcome: "released" });
  assert.equal(state.state, "RELEASED");
  assert.throws(() => reportPlacement(state, "r2", { ...task, outcome: "retryable" }), /Contradictory/);
});

test("a linked source cannot be released while preservation is only pinning", () => {
  const state = newLifecycle(oid("ipfs:bafy-preserve"), [
    { kind: "filebase", executor: "browser", locator: { bucket: "cividge", key: "source.webp", cid: "bafy-preserve" } },
  ]);
  addLink(state, "public.example:source.webp");
  requestPlacementAcquire(state, { kind: "kubo", executor: "browser", locator: { cid: "bafy-preserve" } });
  claimPlacement(state, "kubo", "acquire", "pin-claim");
  assert.throws(() => requestPlacementRelease(state, "filebase"), /another PRESENT placement/);
});

test("confirmed Kubo placement alone permits source release", () => {
  const state = newLifecycle(oid("ipfs:bafy-confirmed"), [
    { kind: "filebase", executor: "browser", locator: { bucket: "cividge", key: "source.webp", cid: "bafy-confirmed" } },
  ]);
  addLink(state, "public.example:source.webp");
  requestPlacementAcquire(state, { kind: "kubo", executor: "browser", locator: { cid: "bafy-confirmed" } });
  const task = claimPlacement(state, "kubo", "acquire", "pin-confirm").task;
  reportPlacement(state, "kubo", { ...task, outcome: "present" });
  requestPlacementRelease(state, "filebase");
  assert.equal(state.placements.filebase.state, "RELEASE_PENDING");
});

test("createLink adds peer Links without changing an existing peer", () => {
  const state = newLifecycle(oid("r2:shared.webp"), [
    { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "shared.webp" } },
  ]);
  addLink(state, "test-up.pages.dev:shared.webp");
  const beforePlacement = structuredClone(state.placements.r2);
  addLink(state, "testunko.pages.dev:shared.webp");
  assert.deepEqual(state.links, ["test-up.pages.dev:shared.webp", "testunko.pages.dev:shared.webp"]);
  assert.deepEqual(state.placements.r2, beforePlacement);
  addLink(state, "testunko.pages.dev:shared.webp");
  assert.deepEqual(state.links, ["test-up.pages.dev:shared.webp", "testunko.pages.dev:shared.webp"]);
});

test("a confirmed Filebase re-upload can re-acquire a released ObjectRef and recreate the same Link", () => {
  const placement = { kind: "filebase", executor: "browser", locator: { bucket: "cividge", key: "same.webp", cid: "bafy-same" } };
  const state = newLifecycle(oid("ipfs:bafy-same"), [placement]);
  addLink(state, "public.example:same.webp");
  removeLink(state, "public.example:same.webp");
  requestRelease(state);
  const release = claimPlacement(state, "filebase", "release", "release-old").task;
  reportPlacement(state, "filebase", { ...release, outcome: "released" });
  assert.equal(state.state, "RELEASED");

  requestPlacementAcquire(state, placement);
  const acquire = claimPlacement(state, "filebase", "acquire", "acquire-new").task;
  reportPlacement(state, "filebase", { ...acquire, outcome: "present" });
  addLink(state, "public.example:same.webp");

  assert.equal(state.state, "ACTIVE");
  assert.equal(state.placements.filebase.state, "PRESENT");
  assert.deepEqual(state.links, ["public.example:same.webp"]);
  assert.ok(acquire.generation > release.generation);
  assert.throws(() => reportPlacement(state, "filebase", { ...release, outcome: "released" }), /Stale|Contradictory/);
});

test("createLink atomically re-acquires a confirmed released Placement", async () => {
  const placement = { kind: "filebase", executor: "browser", locator: { bucket: "cividge", key: "same.webp", cid: "bafy-do-same" } };
  const released = newLifecycle(oid("ipfs:bafy-do-same"), [placement]);
  addLink(released, "public.example:same.webp");
  removeLink(released, "public.example:same.webp");
  requestRelease(released);
  const release = claimPlacement(released, "filebase", "release", "release-do").task;
  reportPlacement(released, "filebase", { ...release, outcome: "released" });

  // Simulate a lifecycle record persisted before Placement generations were
  // introduced. A current upload must canonicalize it instead of issuing a
  // NaN/null claim that rejects its own completion report as stale.
  delete released.placements.filebase.generation;

  const values = new Map([["lifecycle", released]]);
  const lifecycle = new ObjectLifecycle({
    storage: {
      get: async key => structuredClone(values.get(key)),
      put: async (key, value) => values.set(key, structuredClone(value)),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
  }, {});
  const response = await lifecycle.fetch(new Request("https://object-lifecycle.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "createLink",
      objectRef: oid("ipfs:bafy-do-same"),
      linkKey: "public.example:same.webp",
      placements: [placement],
      confirmedPlacements: [placement],
    }),
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.lifecycle.state, "ACTIVE");
  assert.equal(body.lifecycle.placements.filebase.state, "PRESENT");
  assert.deepEqual(body.lifecycle.links, ["public.example:same.webp"]);
  assert.equal(body.lifecycle.placements.filebase.generation, 1);
});

test("same-host alternate name is a peer Link and preserves the source Link", () => {
  const state = newLifecycle(oid("r2:source.webp"), [
    { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "source.webp" } },
  ]);
  addLink(state, "test-up.pages.dev:source.webp");
  addLink(state, "test-up.pages.dev:alternate.webp");
  assert.equal(state.links.includes("test-up.pages.dev:source.webp"), true);
  assert.equal(state.links.includes("test-up.pages.dev:alternate.webp"), true);
});

test("an abandoned Kubo acquisition claim becomes retryable without inferring PRESENT", () => {
  const state = newLifecycle(oid("ipfs:bafy-lease"), [
    { kind: "filebase", executor: "browser", locator: { bucket: "cividge", key: "lease.webp", cid: "bafy-lease" } },
  ]);
  addLink(state, "public.example:lease.webp");
  requestPlacementAcquire(state, { kind: "kubo", executor: "browser", locator: { cid: "bafy-lease" } });
  const first = claimPlacement(state, "kubo", "acquire", "first", 1_000).task;
  assert.equal(state.placements.kubo.state, "PINNING");
  assert.equal(recoverExpiredPlacementClaims(state, 1_000 + PLACEMENT_CLAIM_LEASE_MS - 1), false);
  assert.equal(recoverExpiredPlacementClaims(state, 1_000 + PLACEMENT_CLAIM_LEASE_MS), true);
  assert.equal(state.placements.kubo.state, "PIN_REQUESTED");
  assert.equal(state.placements.kubo.claim, null);
  const second = claimPlacement(state, "kubo", "acquire", "second", 1_000 + PLACEMENT_CLAIM_LEASE_MS).task;
  assert.ok(second.generation > first.generation);
  assert.throws(() => reportPlacement(state, "kubo", { ...first, outcome: "present" }), /Stale/);
  reportPlacement(state, "kubo", { ...second, outcome: "present" });
  assert.equal(state.placements.kubo.state, "PRESENT");
});

test("pending Link removal remains a reference until projection deletion completes", () => {
  const state = newLifecycle(oid("r2:retry.webp"), [
    { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "retry.webp" } },
  ]);
  addLink(state, "public.example:retry.webp");
  beginRemoveLink(state, "public.example:retry.webp");
  assert.equal(state.links.length, 1);
  assert.throws(() => requestRelease(state), /active Links/);
  beginRemoveLink(state, "public.example:retry.webp");
  completeRemoveLink(state, "public.example:retry.webp");
  requestRelease(state);
  assert.equal(state.state, "RELEASE_PENDING");
});

test("removeLink retries safely after projection deletion failure", async () => {
  const linkKey = "public.example:retry-delete.webp";
  const state = newLifecycle(oid("r2:retry-delete.webp"), [
    { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "retry-delete.webp" } },
  ]);
  addLink(state, linkKey);
  const records = new Map([[linkKey, { value: "", metadata: { b: "r2", k_s3: "retry-delete.webp" } }]]);
  const kv = memoryKv(records);
  let failDelete = true;
  kv.delete = async key => {
    kv.calls.delete.push(key);
    if (failDelete) {
      failDelete = false;
      throw new Error("temporary KV failure");
    }
    records.delete(key);
  };
  const env = {
    CIVIDGE_KV: kv,
    ADMIN_API_TOKEN: "secret",
    LINK_BINDING: memoryBindingNamespace(),
    OBJECT_LIFECYCLE: {
      idFromName: value => value,
      get: () => ({ fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.action === "beginRemoveLink") beginRemoveLink(state, body.linkKey);
        if (body.action === "completeRemoveLink") completeRemoveLink(state, body.linkKey);
        return Response.json({ lifecycle: state });
      } }),
    },
  };
  await bindExisting(env, linkKey, oid("r2:retry-delete.webp"));
  const makeContext = () => ({
    request: new Request("https://worker.example/api/cividge-kv?key=" + encodeURIComponent(linkKey), {
      method: "DELETE",
      headers: { Authorization: "Bearer secret" },
    }),
    env,
    waitUntil() {},
  });
  const failed = await onRequestDelete(makeContext());
  assert.equal(failed.status, 503);
  assert.equal(state.links.includes(linkKey), true);
  assert.equal(state.pendingLinkRemovals.includes(linkKey), true);
  const retried = await onRequestDelete(makeContext());
  assert.equal(retried.status, 200);
  assert.equal(state.links.includes(linkKey), false);
  assert.equal(records.has(linkKey), false);
});

test("removeLink retries safely when authority completion fails after projection deletion", async () => {
  const linkKey = "public.example:retry-authority.webp";
  const objectRef = oid("r2:retry-authority.webp");
  const state = newLifecycle(objectRef, [
    { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "retry-authority.webp" } },
  ]);
  addLink(state, linkKey);
  const records = new Map([[linkKey, { value: "", metadata: { b: "r2", k_s3: "retry-authority.webp" } }]]);
  const kv = memoryKv(records);
  let failCompletion = true;
  const env = {
    CIVIDGE_KV: kv,
    ADMIN_API_TOKEN: "secret",
    LINK_BINDING: memoryBindingNamespace(),
    OBJECT_LIFECYCLE: {
      idFromName: value => value,
      get: () => ({ fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.action === "beginRemoveLink") beginRemoveLink(state, body.linkKey);
        if (body.action === "completeRemoveLink") {
          if (failCompletion) {
            failCompletion = false;
            throw new Error("temporary authority failure");
          }
          completeRemoveLink(state, body.linkKey);
        }
        return Response.json({ lifecycle: state });
      } }),
    },
  };
  await bindExisting(env, linkKey, objectRef);
  const makeContext = (includeObjectRef = false) => ({
    request: new Request(
      "https://worker.example/api/cividge-kv?key=" + encodeURIComponent(linkKey)
      + (includeObjectRef ? "&objectRef=" + encodeURIComponent(objectRef) : ""),
      { method: "DELETE", headers: { Authorization: "Bearer secret" } },
    ),
    env,
    waitUntil() {},
  });

  const failed = await onRequestDelete(makeContext());
  const failedBody = await failed.json();
  assert.equal(failed.status, 503);
  assert.equal(failedBody.projectionDeleted, true);
  assert.equal(failedBody.objectRef, objectRef);
  assert.equal(records.has(linkKey), false);
  assert.equal(state.links.includes(linkKey), true);

  const retried = await onRequestDelete(makeContext(true));
  assert.equal(retried.status, 200);
  assert.equal(state.links.includes(linkKey), false);
});

test("stale claim reports cannot mutate a newer placement generation", () => {
  const state = newLifecycle(oid("r2:stale.webp"), [
    { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "stale.webp" } },
  ]);
  requestRelease(state);
  const first = claimPlacement(state, "r2", "release", "old").task;
  reportPlacement(state, "r2", { ...first, outcome: "retryable" });
  const second = claimPlacement(state, "r2", "release", "new").task;
  assert.throws(() => reportPlacement(state, "r2", { ...first, outcome: "released" }), /Stale|Contradictory/);
  reportPlacement(state, "r2", { ...second, outcome: "released" });
  assert.equal(state.placements.r2.state, "RELEASED");
});

test("lifecycle mutation requires the admin token", async () => {
  const calls = [];
  const env = {
    ADMIN_API_TOKEN: "admin",
    OBJECT_LIFECYCLE: {
      idFromName: value => value,
      get: () => ({ fetch: async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return Response.json({ lifecycle: { links: [], placements: {} } });
      } }),
    },
  };
  const body = JSON.stringify({ action: "inspect", objectRef: oid("r2:test.webp") });
  const denied = await onLifecyclePost({ request: new Request("https://worker/api/lifecycle", { method: "POST", body }), env });
  assert.equal(denied.status, 401);
  const allowed = await onLifecyclePost({
    request: new Request("https://worker/api/lifecycle", {
      method: "POST",
      headers: { Authorization: "Bearer admin" },
      body,
    }),
    env,
  });
  assert.equal(allowed.status, 200);
  assert.equal(calls.length, 1);
});

test("DO placement state is projected to every peer Link", async () => {
  const records = new Map([
    ["a.example:x.webp", { value: "", metadata: { b: "r2", k_s3: "x.webp", f: 0 } }],
    ["b.example:x.webp", { value: "", metadata: { b: "r2", k_s3: "x.webp", f: 0 } }],
  ]);
  const kv = memoryKv(records);
  await syncLifecycleProjection({ CIVIDGE_KV: kv }, {
    links: [...records.keys()],
    placements: {
      r2: { state: "PRESENT" },
      kubo: { state: "PRESENT", locator: { cid: "bafy-projected" } },
    },
  });
  for (const link of records.keys()) {
    const projected = records.get(link);
    assert.equal(projected.metadata.kuboStatus, "pinned");
    assert.equal(projected.metadata.c_cid, "bafy-projected");
  }
});

test("delivery projection marks Filebase absence even without a RELEASED row", async () => {
  const key = "a.example:x.webp";
  const records = new Map([[key, { value: "Qm" + "a".repeat(44),
    metadata: { b: "filebase", f: 0 } }]]);
  const kv = memoryKv(records);
  await syncLifecycleProjection({ CIVIDGE_KV: kv }, {
    links: [key], placements: { kubo: { state: "PINNING" } },
  });
  assert.equal(records.get(key).metadata.f & 1, 1);
  assert.equal(records.get(key).metadata.f & 2, 0);
  await syncLifecycleProjection({ CIVIDGE_KV: kv }, {
    links: [key], placements: { filebase: { state: "PRESENT" } },
  });
  assert.equal(records.get(key).metadata.f & 1, 0);
});
