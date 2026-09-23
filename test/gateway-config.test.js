import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_GATEWAY_CONFIG, normalizeGatewayConfig, orderPublicGateways } from "../gateway-config.js";
import { handleGatewayConfig } from "../gateway-config-api.js";

test("public Gateway config is canonical and rejects provider or private endpoints", () => {
  assert.equal(normalizeGatewayConfig(DEFAULT_GATEWAY_CONFIG).endpoints.length, 5);
  assert.throws(() => normalizeGatewayConfig({ mode: "auto", endpoints: [
    { url: "https://ipfs.filebase.io/ipfs", region: "global" },
  ] }), /public HTTPS/);
  assert.throws(() => normalizeGatewayConfig({ mode: "auto", endpoints: [
    { url: "https://localhost/ipfs", region: "global" },
  ] }), /public HTTPS/);
});

test("Worker-side viewer continent changes only retrieval candidate order", () => {
  const config = normalizeGatewayConfig(DEFAULT_GATEWAY_CONFIG);
  assert.equal(orderPublicGateways(config, "AS")[0], "https://apac.orbitor.dev/ipfs");
  assert.equal(orderPublicGateways(config, "EU")[0], "https://eu.orbitor.dev/ipfs");
  assert.equal(orderPublicGateways(config, "NA")[0], "https://ipfs.orbitor.dev/ipfs");
  assert.equal(orderPublicGateways(config, undefined)[0], "https://dget.top/ipfs");
  config.mode = "manual";
  config.selectedUrl = "https://eu.orbitor.dev/ipfs";
  assert.equal(orderPublicGateways(config, "AS")[0], config.selectedUrl);
});

test("authenticated admin save changes the Worker-readable runtime config", async () => {
  const entries = new Map();
  const env = {
    ADMIN_API_TOKEN: "test-token",
    CIVIDGE_KV: {
      async get(key) { return entries.has(key) ? JSON.parse(entries.get(key)) : null; },
      async put(key, value) { entries.set(key, value); },
    },
  };
  const config = normalizeGatewayConfig({
    mode: "manual", selectedUrl: "https://eu.orbitor.dev/ipfs",
    endpoints: DEFAULT_GATEWAY_CONFIG.endpoints,
  });
  const save = await handleGatewayConfig(new Request("https://worker.test/api/gateway-config", {
    method: "PUT", headers: { Authorization: "Bearer test-token" }, body: JSON.stringify(config),
  }), env);
  assert.equal(save.status, 200);
  const read = await handleGatewayConfig(new Request("https://worker.test/api/gateway-config", {
    headers: { Authorization: "Bearer test-token" },
  }), env);
  const saved = (await read.json()).config;
  assert.equal(orderPublicGateways(saved, "AS")[0], "https://eu.orbitor.dev/ipfs");
  assert.equal((await handleGatewayConfig(new Request("https://worker.test/api/gateway-config"), env)).status, 401);
});
