import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as deliver, publicMediaCacheLifetimes } from "../delivery.js";
import { LinkBindingV2 } from "../link-binding.js";

test("BOARD preserves short browser and edge TTL regardless of preservation", () => {
  assert.deepEqual(publicMediaCacheLifetimes({}, { cachePolicy: "BOARD", hasManagedOrigin: true }),
    { browserSeconds: 3600, edgeSeconds: 3600 });
  assert.deepEqual(publicMediaCacheLifetimes({}, { cachePolicy: "BOARD", hasManagedOrigin: false,
    isVideoOrAudio: true }), { browserSeconds: 14400, edgeSeconds: 14400 });
  assert.deepEqual(publicMediaCacheLifetimes({ CLOUDFLARE_ZONE_ID: "zone", CLOUDFLARE_PURGE_TOKEN: "token" },
    { cachePolicy: "BOARD", hasManagedOrigin: true }), { browserSeconds: 86400, edgeSeconds: 86400 });
});

test("PUBLISHED changes edge, not browser, with origin and expiry caps", () => {
  assert.deepEqual(publicMediaCacheLifetimes({}, { cachePolicy: "PUBLISHED", hasManagedOrigin: true }),
    { browserSeconds: 3600, edgeSeconds: 7 * 86400 });
  assert.deepEqual(publicMediaCacheLifetimes({}, { cachePolicy: "PUBLISHED", hasManagedOrigin: false }),
    { browserSeconds: 3600, edgeSeconds: 86400 });
  const expiresAt = Date.now() + 18 * 3600 * 1000;
  const capped = publicMediaCacheLifetimes({}, { cachePolicy: "PUBLISHED", expiresAt });
  assert.ok(capped.edgeSeconds <= 18 * 3600);
  assert.ok(capped.edgeSeconds >= 18 * 3600 - 2);
  assert.ok(capped.browserSeconds <= capped.edgeSeconds);
  assert.deepEqual(publicMediaCacheLifetimes({}, { cachePolicy: "PUBLISHED", expiresAt: Date.now() - 1 }),
    { browserSeconds: 0, edgeSeconds: 0 });
});

test("R2 delivery applies Link policy after object HTTP metadata", async () => {
  const deliverR2 = async cachePolicy => deliver({
    request: new Request("https://public.example/photo.webp"),
    env: {
      CIVIDGE_KV: { getWithMetadata: async key => {
        assert.equal(key, "public.example:photo.webp");
        return { value: "r2", metadata: { b: "r2", k_s3: "photo.webp", cp: cachePolicy } };
      } },
      R2_BUCKET: { get: async () => ({
        body: new Blob(["image"]).stream(),
        writeHttpMetadata: headers => {
          headers.set("Content-Type", "image/webp");
          headers.set("Cache-Control", "public, max-age=31536000");
        },
      }) },
    },
    waitUntil() {},
  });
  const board = await deliverR2("BOARD");
  assert.equal(board.status, 200);
  assert.match(board.headers.get("Cache-Control"), /max-age=3600, s-maxage=3600/);
  const published = await deliverR2("PUBLISHED");
  assert.equal(published.status, 200);
  assert.match(published.headers.get("Cache-Control"), /max-age=3600, s-maxage=604800/);
  assert.equal(published.headers.get("Cloudflare-CDN-Cache-Control"), "public, max-age=604800");
});

test("LinkBinding keeps Cache Policy closed and preserves it on expiry-only changes", async () => {
  const values = new Map();
  const binding = new LinkBindingV2({ storage: {
    get: async key => values.get(key),
    put: async (key, value) => values.set(key, structuredClone(value)),
  } });
  const send = async body => binding.fetch(new Request("https://test.invalid/", {
    method: "POST", body: JSON.stringify({ linkKey: "test-up.pages.dev:file.webp", ...body }),
  }));
  const reserved = await (await send({ action: "reserve", objectRef: "ipfs:Qm" + "a".repeat(44),
    attemptId: "test" })).json();
  await send({ action: "commit", attemptId: "test", generation: reserved.binding.attempt.generation });
  const published = await (await send({ action: "acknowledgePolicy", generation: 1,
    expiresAt: null, cachePolicy: "PUBLISHED" })).json();
  assert.equal(published.binding.policy.cachePolicy, "PUBLISHED");
  const expiryOnly = await (await send({ action: "acknowledgePolicy", generation: 1,
    expiresAt: Date.now() + 86400_000 })).json();
  assert.equal(expiryOnly.binding.policy.cachePolicy, "PUBLISHED");
  const invalid = await send({ action: "acknowledgePolicy", generation: 1,
    expiresAt: null, cachePolicy: "blog" });
  assert.equal(invalid.status, 409);
});
