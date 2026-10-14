import test from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { onRequest as deliver, deliveryCacheRequest } from "../delivery.js";
import { purgeHybridCache } from "../cividge-kv.js";

const salt = "00112233445566778899aabbccddeeff";
const passwordMeta = { passwordSalt: salt,
  passwordHash: pbkdf2Sync("correct", Buffer.from(salt, "hex"), 100000, 32, "sha256").toString("hex") };
function fixture() {
  let reads = 0, origins = 0;
  let record = { value: "", metadata: { b: "r2", k_s3: "object", oid: `sha256:${"a".repeat(64)}`, g: 1 } };
  const entries = new Map();
  const pending = [];
  const prior = globalThis.caches;
  globalThis.caches = { default: {
    match: async request => entries.get(request.url)?.clone(),
    put: async (request, response) => entries.set(request.url, response.clone()),
  } };
  const env = { CIVIDGE_KV: { getWithMetadata: async () => { reads++; return record; } },
    R2_BUCKET: { get: async () => { origins++; return { body: "original", size: 8, writeHttpMetadata() {} }; } } };
  return { env, entries, get reads() { return reads; }, get origins() { return origins; },
    set record(value) { record = value; }, get record() { return record; },
    async send(path = "media.webp", options = {}) {
      const response = await deliver({ request: new Request(`https://relay.example/r/test-up/${path}`, options),
        env: { ...env, STATIC_RELAY_PUBLIC_HOSTS: "test-up.pages.dev" }, waitUntil: promise => pending.push(promise) });
      await Promise.all(pending.splice(0));
      return response;
    }, restore() { globalThis.caches = prior; } };
}

test("cached public 200 cannot bypass a subsequently protected Link", async () => {
  const f = fixture();
  try {
    assert.equal(await (await f.send()).text(), "original");
    f.record.metadata = { ...f.record.metadata, ...passwordMeta };
    for (const [path, headers] of [["media.webp", {}], ["media.webp", { Range: "bytes=0-1" }],
      ["media.mp4?preview=1", {}], ["media.webp", { "User-Agent": "Twitterbot", Accept: "text/html" }]]) {
      const response = await f.send(path, { headers });
      assert.match(response.headers.get("cache-control"), /no-store/);
      assert.match(await response.text(), /name="pwd"/);
    }
    assert.equal(f.origins, 1);
  } finally { f.restore(); }
});

test("cached 200 does not survive a KV-visible delete or shortened expiration", async () => {
  const f = fixture();
  try {
    await f.send();
    f.record.metadata.e = Math.floor(Date.now() / 1000) - 1;
    assert.equal((await f.send()).status, 404);
    f.record = null;
    assert.equal((await f.send()).status, 404);
    assert.equal(f.origins, 1);
  } finally { f.restore(); }
});

test("negative cache never suppresses a KV-visible new publication", async () => {
  const f = fixture();
  try {
    const record = f.record;
    f.record = null;
    const missing = await f.send();
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "public, max-age=0, s-maxage=60");
    assert.equal(f.origins, 0);
    f.record = record;
    assert.equal((await f.send()).status, 200);
  } finally { f.restore(); }
});

test("arbitrary query strings share a cache key but preview has its own representation", () => {
  const key = path => deliveryCacheRequest(new Request(`https://relay.example/r/test-up/a.mp4${path}`)).url;
  assert.equal(key("?random=one"), key("?random=two"));
  assert.notEqual(key(""), key("?preview=1"));
});

test("wrong parallel password attempts do not retrieve protected bytes", async () => {
  const f = fixture();
  const originalDerive = crypto.subtle.deriveBits;
  let derivations = 0;
  crypto.subtle.deriveBits = function(...args) { derivations++; return originalDerive.apply(this, args); };
  try {
    f.record.metadata = { ...f.record.metadata, ...passwordMeta };
    const responses = await Promise.all(Array.from({ length: 4 }, () => f.send("media.webp", {
      method: "POST", body: new URLSearchParams({ pwd: "wrong" }) })));
    assert.ok(responses.every(response => response.status === 403));
    assert.equal(f.reads, 4);
    assert.equal(f.origins, 0);
    assert.equal(derivations, 4);
  } finally { crypto.subtle.deriveBits = originalDerive; f.restore(); }
});

test("three-second friction applies to wrong password and malformed form, not successful authentication", async () => {
  const f = fixture();
  const originalTimeout = globalThis.setTimeout;
  const waits = [];
  globalThis.setTimeout = (callback, milliseconds) => {
    waits.push(milliseconds);
    queueMicrotask(callback);
    return 0;
  };
  try {
    f.record.metadata = { ...f.record.metadata, ...passwordMeta };
    assert.equal((await f.send("media.webp", { method: "POST", body: new URLSearchParams({ pwd: "wrong" }) })).status, 403);
    assert.deepEqual(waits, [3000]);
    assert.equal((await f.send("media.webp", { method: "POST", body: "invalid form", headers: { "Content-Type": "text/plain" } })).status, 400);
    assert.deepEqual(waits, [3000, 3000]);
    assert.equal((await f.send("media.webp", { method: "POST", body: new URLSearchParams({ pwd: "correct" }) })).status, 303);
    assert.deepEqual(waits, [3000, 3000]);
    assert.equal(f.origins, 0);
  } finally { globalThis.setTimeout = originalTimeout; f.restore(); }
});

test("a cache hit never grants freshness beyond remaining Link lifetime", async () => {
  const f = fixture();
  const originalNow = Date.now;
  const now = originalNow();
  try {
    f.record.metadata.expiresAt = now + 200_000;
    Date.now = () => now;
    await f.send();
    Date.now = () => now + 190_000;
    const hit = await f.send();
    assert.match(hit.headers.get("cache-control"), /max-age=10, s-maxage=10/);
    assert.equal(f.origins, 1);
  } finally { Date.now = originalNow; f.restore(); }
});

test("GatewayConfig KV failure is 503 without contacting origin", async () => {
  const f = fixture();
  try {
    f.record = { value: `Qm${"a".repeat(44)}`, metadata: { b: "filebase" } };
    f.env.CIVIDGE_KV.get = async () => { throw new Error("config unavailable"); };
    const response = await f.send();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(f.origins, 0);
  } finally { f.restore(); }
});

test("session response and authenticated media are not stored in HTTP cache", async () => {
  const f = fixture();
  try {
    f.record.metadata = { ...f.record.metadata, ...passwordMeta };
    const session = await f.send("media.webp", { method: "POST", body: new URLSearchParams({ pwd: "correct" }) });
    assert.equal(session.status, 303);
    assert.match(session.headers.get("cache-control"), /no-store/);
    const cookie = session.headers.get("set-cookie").split(";")[0];
    const response = await f.send("media.webp", { headers: { Cookie: cookie } });
    assert.equal(await response.text(), "original");
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(f.entries.size, 0);
    f.record.metadata.g++;
    assert.match(await (await f.send("media.webp", { headers: { Cookie: cookie } })).text(), /name="pwd"/);
  } finally { f.restore(); }
});

test("malformed cookies cannot throw past the password gate", async () => {
  const f = fixture();
  try {
    f.record.metadata = { ...f.record.metadata, ...passwordMeta };
    assert.equal((await f.send("media.webp", { headers: { Cookie: "other=%invalid" } })).status, 200);
    assert.equal(f.origins, 0);
  } finally { f.restore(); }
});

test("KV failure is unavailable even when old public bytes are cached", async () => {
  const f = fixture();
  try {
    await f.send();
    f.env.CIVIDGE_KV.getWithMetadata = async () => { throw new Error("test KV outage"); };
    const response = await f.send();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(f.origins, 1);
  } finally { f.restore(); }
});

test("projection changes select different cached bytes; unknown query does not multiply entries", async () => {
  const f = fixture();
  try {
    await f.send("media.webp?nonce=1");
    await f.send("media.webp?nonce=2");
    assert.equal(f.origins, 1);
    assert.equal(f.reads, 2);
    assert.equal(f.entries.size, 1);
    f.record.metadata.oid = `sha256:${"b".repeat(64)}`;
    f.record.metadata.g = 2;
    f.env.R2_BUCKET.get = async () => ({ body: "new bytes", writeHttpMetadata() {} });
    assert.equal(await (await f.send()).text(), "new bytes");
    assert.equal(f.entries.size, 2);
  } finally { f.restore(); }
});

test("invalid relay identity does not query KV or origin", async () => {
  const f = fixture();
  try {
    const response = await deliver({ request: new Request("https://relay.example/r/unknown/file.webp"),
      env: { ...f.env, STATIC_RELAY_PUBLIC_HOSTS: "test-up.pages.dev" }, waitUntil() {} });
    assert.equal(response.status, 404);
    assert.equal(f.reads, 0);
    assert.equal(f.origins, 0);
  } finally { f.restore(); }
});

test("IPFS Range is forwarded and 206 is preserved; failed origin is 503", async () => {
  const f = fixture();
  const priorFetch = globalThis.fetch;
  try {
    f.record = { value: `Qm${"a".repeat(44)}`, metadata: { b: "filebase" } };
    f.env.CIVIDGE_KV.get = async () => null;
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers.Range, "bytes=0-1");
      return new Response("ab", { status: 206, headers: {
        "Content-Range": "bytes 0-1/8", "Content-Length": "2", "Content-Type": "video/mp4" } });
    };
    const response = await f.send("media.mp4", { headers: { Range: "bytes=0-1" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 0-1/8");
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    const failure = await f.send("media.mp4");
    assert.equal(failure.status, 503);
    assert.equal(failure.headers.get("cache-control"), "no-store");
  } finally { globalThis.fetch = priorFetch; f.restore(); }
});

test("OGP external strings remain text, not executable attributes", async () => {
  const f = fixture();
  try {
    const response = await f.send('x%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E.webp', {
      headers: { "User-Agent": "Twitterbot", Accept: "text/html" } });
    const html = await response.text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(f.origins, 0);
  } finally { f.restore(); }
});

test("purge covers direct and both relay identities without duplicate requests", async () => {
  const priorFetch = globalThis.fetch;
  const priorCaches = globalThis.caches;
  const calls = [];
  globalThis.caches = { default: { delete: async () => true } };
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body).files);
    return Response.json({ success: true });
  };
  try {
    const env = { CLOUDFLARE_ZONE_ID: "test-zone", CLOUDFLARE_PURGE_TOKEN: "dummy",
      STATIC_RELAY_PUBLIC_HOSTS: "test-up.pages.dev", STATIC_RELAY_BACKEND_HOSTS: "relay.example" };
    await purgeHybridCache(new Request("https://admin.example/api/cividge-kv"), env, "test-up.pages.dev:a.webp");
    assert.deepEqual(calls[0], ["https://relay.example/r/test-up/a.webp", "https://relay.example/r/test-up.pages.dev/a.webp"]);
    await purgeHybridCache(new Request("https://admin.example/api/cividge-kv"), env, "media.example:a.webp");
    assert.deepEqual(calls[1], ["https://media.example/a.webp"]);
  } finally { globalThis.fetch = priorFetch; globalThis.caches = priorCaches; }
});
