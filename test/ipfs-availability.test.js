import assert from "node:assert/strict";
import test from "node:test";
import { classifyGatewayStatuses, inspectIpfsAvailability, probeGateway } from "../ipfs-availability.js";
import { handleIpfsAvailability } from "../ipfs-availability-api.js";

test("gateway status distinguishes content absence from gateway failure", () => {
  assert.equal(classifyGatewayStatuses([404, 404]), "NOT_FOUND_FROM_CHECKED_GATEWAYS");
  assert.equal(classifyGatewayStatuses([404, 503]), "UNAVAILABLE");
  assert.equal(classifyGatewayStatuses([null, 429]), "UNAVAILABLE");
  assert.equal(classifyGatewayStatuses([206, 404]), "AVAILABLE");
});

test("probe falls back from unsupported HEAD to a bounded range GET", async () => {
  const calls = [];
  const result = await probeGateway("https://gateway.example/ipfs", "Qm" + "a".repeat(44), async (_url, init) => {
    calls.push(init);
    return init.method === "HEAD"
      ? new Response(null, { status: 405 })
      : new Response("x", { status: 206 });
  });
  assert.equal(result, 206);
  assert.equal(calls[1].headers.Range, "bytes=0-0");
});

test("availability API requires admin auth and bounds validated CID batches", async () => {
  const env = { ADMIN_API_TOKEN: "secret", CIVIDGE_KV: { get: async () => null } };
  const unauthorized = await handleIpfsAvailability(new Request("https://worker/api/ipfs-availability", { method: "POST", body: JSON.stringify({ cids: ["Qm" + "a".repeat(44)] }) }), env);
  assert.equal(unauthorized.status, 401);
  const invalid = await handleIpfsAvailability(new Request("https://worker/api/ipfs-availability", {
    method: "POST", headers: { Authorization: "Bearer secret" }, body: JSON.stringify({ cids: ["not-a-cid"] }),
  }), env);
  assert.equal(invalid.status, 400);
  const tooMany = await handleIpfsAvailability(new Request("https://worker/api/ipfs-availability", {
    method: "POST", headers: { Authorization: "Bearer secret" },
    body: JSON.stringify({ cids: Array.from({ length: 6 }, (_, i) => "Qm" + String(i + 1).repeat(44)) }),
  }), env);
  assert.equal(tooMany.status, 400);
});

test("availability endpoint checks a bounded gateway sample and marks only checked 404s", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 404 });
  };
  try {
    const cid = "Qm" + "b".repeat(44);
    const env = { ADMIN_API_TOKEN: "secret", CIVIDGE_KV: { get: async () => null } };
    const response = await handleIpfsAvailability(new Request("https://worker/api/ipfs-availability", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ cids: [cid] }),
    }), env);
    const payload = await response.json();
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(payload.results[cid].status, "NOT_FOUND_FROM_CHECKED_GATEWAYS");
    assert.equal(payload.checkedGateways, 4);
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("inspection returns availability based on all checked gateways", async () => {
  const result = await inspectIpfsAvailability("Qm" + "a".repeat(44), ["a", "b"], async url =>
    new Response(null, { status: url.startsWith("a/") ? 404 : 503 }));
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.checked, 2);
});
