import assert from "node:assert/strict";
import test from "node:test";
import { onRequestPost, callLifecycle } from "../lifecycle-api.js";
import { ObjectLifecycle } from "../lifecycle.js";

const cid = "Qm" + "a".repeat(44);
const objectRef = `ipfs:${cid.toLowerCase()}`;
const rpcPlacement = { kind: "filebase_rpc", executor: "worker",
  provenance: "cividge_worker_rpc", locator: { cid } };

function fixture(vars = {}) {
  const records = new Map();
  const env = { ADMIN_API_TOKEN: "admin", FILEBASE_IPFS_API_KEY: "test-key", ...vars };
  const storage = {
    get: async key => records.get(key),
    put: async (key, value) => records.set(key, structuredClone(value)),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const lifecycle = new ObjectLifecycle({ storage }, env);
  env.OBJECT_LIFECYCLE = { idFromName: value => value,
    get: () => ({ fetch: (url, options) => lifecycle.fetch(new Request(url, options)) }) };
  return env;
}

async function present(env, placement = rpcPlacement) {
  await callLifecycle(env, { action: "requestPlacementAcquire", objectRef, placement });
  const { claim } = await callLifecycle(env, { action: "claimPlacement", objectRef,
    placement: placement.kind, operation: "acquire" });
  await callLifecycle(env, { action: "reportPlacement", objectRef,
    placement: placement.kind, claimId: claim.claimId, generation: claim.generation,
    operation: "acquire", outcome: "present" });
}

async function requestRelease(env) {
  const request = new Request("https://worker.example/api/lifecycle", {
    method: "POST", headers: { Authorization: "Bearer admin", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "requestRelease", objectRef }),
  });
  const response = await onRequestPost({ request, env });
  assert.equal(response.status, 200);
  return (await response.json()).lifecycle;
}

test("dedicated bucket is required before any RPC physical unpin", async () => {
  const env = fixture({ FILEBASE_DEDICATED_BUCKET: "false" });
  await present(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("physical unpin must not run"); };
  try {
    const state = await requestRelease(env);
    assert.equal(state.placements.filebase_rpc.state, "RELEASE_PENDING");
  } finally { globalThis.fetch = originalFetch; }
});

test("browser-held admin token cannot forge Worker RPC provenance", async () => {
  const env = fixture({ FILEBASE_DEDICATED_BUCKET: "true" });
  const response = await onRequestPost({ env, request: new Request("https://worker.example/api/lifecycle", {
    method: "POST", headers: { Authorization: "Bearer admin", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "requestPlacementAcquire", objectRef, placement: rpcPlacement }),
  }) });
  assert.equal(response.status, 403);
  assert.equal((await callLifecycle(env, { action: "inspect", objectRef })).lifecycle, null);
});

test("browser S3 Placement is never a Worker RPC cleanup target", async () => {
  const env = fixture({ FILEBASE_DEDICATED_BUCKET: "true" });
  await present(env, { kind: "filebase", executor: "browser", locator: { key: "x.webp", cid } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("browser Placement must not be unpinned by Worker"); };
  try {
    const state = await requestRelease(env);
    assert.equal(state.placements.filebase.state, "RELEASE_PENDING");
  } finally { globalThis.fetch = originalFetch; }
});

test("authorized RPC release survives a lost pin/rm response", async () => {
  const env = fixture({ FILEBASE_DEDICATED_BUCKET: "true" });
  await present(env);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).includes("pin/rm")) throw new Error("response lost");
    return Response.json({ Keys: {} });
  };
  try {
    const state = await requestRelease(env);
    assert.equal(state.placements.filebase_rpc.state, "RELEASED");
    assert.equal(state.state, "RELEASED");
    assert.equal(calls.length, 2);
    assert.match(calls[0], /pin\/rm/);
    assert.match(calls[1], /pin\/ls/);
  } finally { globalThis.fetch = originalFetch; }
});

test("inconclusive RPC failure remains retryable and does not resurrect Object", async () => {
  const env = fixture({ FILEBASE_DEDICATED_BUCKET: "true" });
  await present(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const state = await requestRelease(env);
    assert.equal(state.placements.filebase_rpc.state, "RETRYABLE");
    assert.equal(state.state, "RELEASE_PENDING");
  } finally { globalThis.fetch = originalFetch; }
});
