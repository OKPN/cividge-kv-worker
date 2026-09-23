import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as deliver } from "../delivery.js";
import { onRequestDelete, onRequestPost, onRequestRetireOldLink } from "../cividge-kv.js";
import { onRequestPost as onLifecyclePost, syncLifecycleProjection } from "../lifecycle-api.js";
import { ObjectLifecycle } from "../lifecycle.js";
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
    [first, { value: "r2", metadata: { b: "r2", k_s3: "shared.webp", e: 1 } }],
    [second, { value: "r2", metadata: { b: "r2", k_s3: "shared.webp" } }],
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

test("registry rejects bare Link keys and canonicalizes the host in accepted keys", async () => {
  const kv = memoryKv();
  const lifecycleCalls = [];
  const env = {
    CIVIDGE_KV: kv,
    ADMIN_API_TOKEN: "secret",
    OBJECT_LIFECYCLE: {
      idFromName: (name) => name,
      get: () => ({ fetch: async (_url, options) => {
        lifecycleCalls.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ lifecycle: {} }), { status: 200 });
      } }),
    },
  };
  const headers = { Authorization: "Bearer secret", "Content-Type": "application/json" };

  const bare = await onRequestPost({ request: new Request("https://worker.example/api/cividge-kv", {
    method: "POST", headers, body: JSON.stringify({ key: "bare.webp", cid: "r2", backend: "r2", s3Key: "bare.webp" }),
  }), env, waitUntil() {} });
  assert.equal(bare.status, 400);

  const canonical = await onRequestPost({ request: new Request("https://worker.example/api/cividge-kv", {
    method: "POST", headers, body: JSON.stringify({ key: "PUBLIC.EXAMPLE:ok.webp", cid: "r2", backend: "r2", s3Key: "ok.webp", allowedHost: "other.example" }),
  }), env, waitUntil() {} });
  assert.equal(canonical.status, 200);
  assert.equal(kv.calls.put[0].key, "public.example:ok.webp");
  assert.equal(kv.calls.put[0].options.metadata.d, "public.example");
  assert.equal(lifecycleCalls[0].objectRef, "r2:ok.webp");
});

test("creating an alias projection leaves the source Link and projection intact", async () => {
  const source = "test-up.pages.dev:shared.webp";
  const alias = "testunko.pages.dev:shared.webp";
  const records = new Map([
    [source, { value: "r2", metadata: { b: "r2", d: "test-up.pages.dev", k_s3: "shared.webp", s: 10 } }],
  ]);
  const kv = memoryKv(records);
  const state = newLifecycle("r2:shared.webp", [
    { kind: "r2", executor: "worker", locator: { key: "shared.webp" } },
  ]);
  addLink(state, source);
  const env = {
    CIVIDGE_KV: kv,
    ADMIN_API_TOKEN: "secret",
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
        cid: "r2",
        backend: "r2",
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
  const state = newLifecycle("r2:media/example.webp", [
    { kind: "r2", executor: "worker", locator: { key: "media/example.webp" } },
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
  const state = newLifecycle("ipfs:bafytest", [
    { kind: "filebase", executor: "browser", locator: { key: "x.webp", cid: "bafytest" } },
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

test("a Link can cancel pending release but never resurrect releasing content", () => {
  const pending = newLifecycle("r2:x.webp", [{ kind: "r2", executor: "worker", locator: { key: "x.webp" } }]);
  requestRelease(pending);
  addLink(pending, "public.example:x.webp");
  assert.equal(pending.state, "ACTIVE");

  const releasing = newLifecycle("r2:y.webp", [{ kind: "r2", executor: "worker", locator: { key: "y.webp" } }]);
  requestRelease(releasing);
  claimPlacement(releasing, "r2", "release", "claim-r2");
  assert.throws(() => addLink(releasing, "public.example:y.webp"), /not linkable/);
});

test("duplicate actuator reports are idempotent and contradictory reports fail", () => {
  const state = newLifecycle("r2:duplicate.webp", [{ kind: "r2", executor: "worker", locator: { key: "duplicate.webp" } }]);
  requestRelease(state);
  const task = claimPlacement(state, "r2", "release", "claim-duplicate").task;
  reportPlacement(state, "r2", { ...task, outcome: "released" });
  reportPlacement(state, "r2", { ...task, outcome: "released" });
  assert.equal(state.state, "RELEASED");
  assert.throws(() => reportPlacement(state, "r2", { ...task, outcome: "retryable" }), /Contradictory/);
});

test("a linked source cannot be released while preservation is only pinning", () => {
  const state = newLifecycle("ipfs:bafy-preserve", [
    { kind: "filebase", executor: "browser", locator: { key: "source.webp", cid: "bafy-preserve" } },
  ]);
  addLink(state, "public.example:source.webp");
  requestPlacementAcquire(state, { kind: "kubo", executor: "browser", locator: { cid: "bafy-preserve" } });
  claimPlacement(state, "kubo", "acquire", "pin-claim");
  assert.throws(() => requestPlacementRelease(state, "filebase"), /another PRESENT placement/);
});

test("confirmed Kubo placement alone permits source release", () => {
  const state = newLifecycle("ipfs:bafy-confirmed", [
    { kind: "filebase", executor: "browser", locator: { key: "source.webp", cid: "bafy-confirmed" } },
  ]);
  addLink(state, "public.example:source.webp");
  requestPlacementAcquire(state, { kind: "kubo", executor: "browser", locator: { cid: "bafy-confirmed" } });
  const task = claimPlacement(state, "kubo", "acquire", "pin-confirm").task;
  reportPlacement(state, "kubo", { ...task, outcome: "present" });
  requestPlacementRelease(state, "filebase");
  assert.equal(state.placements.filebase.state, "RELEASE_PENDING");
});

test("createLink adds peer Links without changing an existing peer", () => {
  const state = newLifecycle("r2:shared.webp", [
    { kind: "r2", executor: "worker", locator: { key: "shared.webp" } },
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
  const placement = { kind: "filebase", executor: "browser", locator: { key: "same.webp", cid: "bafy-same" } };
  const state = newLifecycle("ipfs:bafy-same", [placement]);
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
  const placement = { kind: "filebase", executor: "browser", locator: { key: "same.webp", cid: "bafy-do-same" } };
  const released = newLifecycle("ipfs:bafy-do-same", [placement]);
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
      objectRef: "ipfs:bafy-do-same",
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
  const state = newLifecycle("r2:source.webp", [
    { kind: "r2", executor: "worker", locator: { key: "source.webp" } },
  ]);
  addLink(state, "test-up.pages.dev:source.webp");
  addLink(state, "test-up.pages.dev:alternate.webp");
  assert.equal(state.links.includes("test-up.pages.dev:source.webp"), true);
  assert.equal(state.links.includes("test-up.pages.dev:alternate.webp"), true);
});

test("an abandoned Kubo acquisition claim becomes retryable without inferring PRESENT", () => {
  const state = newLifecycle("ipfs:bafy-lease", [
    { kind: "filebase", executor: "browser", locator: { key: "lease.webp", cid: "bafy-lease" } },
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
  const state = newLifecycle("r2:retry.webp", [
    { kind: "r2", executor: "worker", locator: { key: "retry.webp" } },
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
  const state = newLifecycle("r2:retry-delete.webp", [
    { kind: "r2", executor: "worker", locator: { key: "retry-delete.webp" } },
  ]);
  addLink(state, linkKey);
  const records = new Map([[linkKey, { value: "r2", metadata: { b: "r2", k_s3: "retry-delete.webp" } }]]);
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
  const objectRef = "r2:retry-authority.webp";
  const state = newLifecycle(objectRef, [
    { kind: "r2", executor: "worker", locator: { key: "retry-authority.webp" } },
  ]);
  addLink(state, linkKey);
  const records = new Map([[linkKey, { value: "r2", metadata: { b: "r2", k_s3: "retry-authority.webp" } }]]);
  const kv = memoryKv(records);
  let failCompletion = true;
  const env = {
    CIVIDGE_KV: kv,
    ADMIN_API_TOKEN: "secret",
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

test("temporary retirement deletes only an unowned old KV projection after exact inspection", async () => {
  const key = "public.example:old.webp";
  const peer = "mirror.example:peer.webp";
  const cid = "QmOldContent";
  const records = new Map([
    [key, { value: cid, metadata: { b: "filebase", k_s3: "old.webp" } }],
    [peer, { value: cid, metadata: { b: "filebase", k_s3: "old.webp" } }],
  ]);
  const kv = memoryKv(records);
  const env = {
    CIVIDGE_KV: kv,
    ADMIN_API_TOKEN: "secret",
    OBJECT_LIFECYCLE: {
      idFromName: value => value,
      get: () => ({ fetch: async () => Response.json({ lifecycle: null }) }),
    },
  };
  const invoke = body => onRequestRetireOldLink({
    request: new Request("https://worker.example/api/maintenance/retire-old-link", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ key, ...body }),
    }),
    env,
    waitUntil() {},
  });
  const inspection = await (await invoke({ action: "inspect" })).json();
  assert.equal(inspection.owned, false);
  assert.equal(inspection.objectRef, "ipfs:qmoldcontent");
  assert.deepEqual(kv.calls.delete, []);

  const changed = await invoke({ action: "retire", expectedFingerprint: "wrong", expectedObjectRef: inspection.objectRef });
  assert.equal(changed.status, 409);
  assert.equal(records.has(key), true);

  records.set(key, { value: cid, metadata: { b: "filebase", k_s3: "old.webp", e: 123 } });
  const stale = await invoke({
    action: "retire",
    expectedFingerprint: inspection.fingerprint,
    expectedObjectRef: inspection.objectRef,
  });
  assert.equal(stale.status, 409);
  assert.equal(records.has(key), true);
  records.set(key, { value: cid, metadata: { b: "filebase", k_s3: "old.webp" } });

  const retired = await invoke({
    action: "retire",
    expectedFingerprint: inspection.fingerprint,
    expectedObjectRef: inspection.objectRef,
  });
  assert.equal(retired.status, 200);
  assert.deepEqual(kv.calls.delete, [key]);
  assert.equal(records.has(peer), true);
});

test("temporary retirement uses normal authority removal for an owned Link", async () => {
  const key = "public.example:old.webp";
  const peer = "mirror.example:peer.webp";
  const cid = "QmOwnedContent";
  const records = new Map([
    [key, { value: cid, metadata: { b: "filebase", k_s3: "old.webp" } }],
    [peer, { value: cid, metadata: { b: "filebase", k_s3: "old.webp" } }],
  ]);
  const kv = memoryKv(records);
  const state = newLifecycle("ipfs:qmownedcontent", [
    { kind: "filebase", executor: "browser", locator: { key: "old.webp", cid } },
  ]);
  addLink(state, key);
  addLink(state, peer);
  const env = {
    CIVIDGE_KV: kv,
    ADMIN_API_TOKEN: "secret",
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
  const invoke = body => onRequestRetireOldLink({
    request: new Request("https://worker.example/api/maintenance/retire-old-link", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ key, ...body }),
    }),
    env,
    waitUntil() {},
  });
  const inspection = await (await invoke({ action: "inspect" })).json();
  assert.equal(inspection.owned, true);
  const retired = await invoke({
    action: "retire",
    expectedFingerprint: inspection.fingerprint,
    expectedObjectRef: inspection.objectRef,
  });
  assert.equal(retired.status, 200);
  assert.deepEqual(state.links, [peer]);
  assert.equal(records.has(key), false);
  assert.equal(records.has(peer), true);
  assert.equal(state.placements.filebase.state, "PRESENT");
});

test("stale claim reports cannot mutate a newer placement generation", () => {
  const state = newLifecycle("r2:stale.webp", [
    { kind: "r2", executor: "worker", locator: { key: "stale.webp" } },
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
  const body = JSON.stringify({ action: "inspect", objectRef: "r2:test.webp" });
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
    ["a.example:x.webp", { value: "r2", metadata: { b: "r2", k_s3: "x.webp", f: 0 } }],
    ["b.example:x.webp", { value: "r2", metadata: { b: "r2", k_s3: "x.webp", f: 0 } }],
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
