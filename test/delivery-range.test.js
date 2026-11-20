import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as deliver, parseBytesRange, resolveR2PublicOrigin } from "../delivery.js";

test("parseBytesRange accepts single ranges and ignores the rest", () => {
  assert.deepEqual(parseBytesRange("bytes=0-99"), { offset: 0, length: 100 });
  assert.deepEqual(parseBytesRange("bytes=100-"), { offset: 100 });
  assert.deepEqual(parseBytesRange("bytes=-50"), { suffix: 50 });
  assert.equal(parseBytesRange("bytes=0-99,200-299"), null);
  assert.equal(parseBytesRange("items=0-1"), null);
  assert.equal(parseBytesRange("bytes=-"), null);
  assert.equal(parseBytesRange("bytes=-0"), null);
  assert.equal(parseBytesRange("bytes=50-40"), null);
  assert.equal(parseBytesRange(null), null);
  assert.equal(parseBytesRange(""), null);
});

const SIZE = 1000;

function mockR2Bucket() {
  return {
    get: async (key, options) => {
      const range = options?.range;
      let offset = 0;
      let length = SIZE;
      if (range?.suffix != null) {
        length = Math.min(range.suffix, SIZE);
        offset = SIZE - length;
      } else if (range?.offset != null) {
        offset = range.offset;
        if (offset >= SIZE) return null;
        length = Math.min(range.length ?? SIZE - offset, SIZE - offset);
      }
      const bytes = new Uint8Array(length).fill(7);
      return {
        body: new Blob([bytes]).stream(),
        size: SIZE,
        ...(range ? { range: { offset, length } } : {}),
        writeHttpMetadata: headers => headers.set("Content-Type", "video/mp4"),
      };
    },
    head: async () => ({ size: SIZE }),
  };
}

async function deliverVideo(range) {
  return deliver({
    request: new Request("https://public.example/video.mp4", {
      headers: range ? { Range: range } : {},
    }),
    env: {
      CIVIDGE_KV: { getWithMetadata: async () => ({ value: "", metadata: { b: "r2", k_s3: "video.mp4" } }) },
      R2_BUCKET: mockR2Bucket(),
    },
    waitUntil() {},
  });
}

test("R2 delivery without Range stays a full 200", async () => {
  const res = await deliverVideo(null);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Length"), String(SIZE));
  assert.equal(res.headers.get("Content-Range"), null);
});

test("R2 delivery honours a bounded Range with 206", async () => {
  const res = await deliverVideo("bytes=100-199");
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("Content-Range"), "bytes 100-199/1000");
  assert.equal(res.headers.get("Content-Length"), "100");
  const body = await res.arrayBuffer();
  assert.equal(body.byteLength, 100);
});

test("R2 delivery honours open-ended and suffix ranges", async () => {
  const open = await deliverVideo("bytes=900-");
  assert.equal(open.status, 206);
  assert.equal(open.headers.get("Content-Range"), "bytes 900-999/1000");
  const suffix = await deliverVideo("bytes=-100");
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("Content-Range"), "bytes 900-999/1000");
});

test("R2 delivery answers an unsatisfiable Range with 416", async () => {
  const res = await deliverVideo("bytes=2000-");
  assert.equal(res.status, 416);
  assert.equal(res.headers.get("Content-Range"), "bytes */1000");
});

const R2_ORIGINS = "k7m.f5.si=https://r2-cdn.k7m.f5.si,okpn.f5.si=https://r2-cdn.okpn.f5.si";

test("resolveR2PublicOrigin matches exact or subdomain parent and hides unconfigured relays", () => {
  const env = { R2_PUBLIC_ORIGINS: R2_ORIGINS };
  assert.equal(resolveR2PublicOrigin(env, "kv.k7m.f5.si"), "https://r2-cdn.k7m.f5.si");
  assert.equal(resolveR2PublicOrigin(env, "misskey-media.okpn.f5.si"), "https://r2-cdn.okpn.f5.si");
  assert.equal(resolveR2PublicOrigin(env, "punipuni-media.pages.dev"), null);
});

test("R2 public video/audio under objects/ 307-redirects to matching R2 custom domain without reading body", async () => {
  let getCalled = false;
  const bucket = {
    head: async (key) => (key === "objects/bafy1234567890abcdefghij" ? { size: SIZE } : null),
    get: async () => {
      getCalled = true;
      throw new Error("R2_BUCKET.get should not be called on 307 offload");
    },
  };
  const res = await deliver({
    request: new Request("https://misskey-media.okpn.f5.si/clip.mp4", {
      headers: { Range: "bytes=0-99" },
    }),
    env: {
      R2_PUBLIC_ORIGINS: R2_ORIGINS,
      CIVIDGE_KV: {
        getWithMetadata: async () => ({
          value: "",
          metadata: { b: "r2", k_s3: "objects/bafy1234567890abcdefghij" },
        }),
      },
      R2_BUCKET: bucket,
    },
    waitUntil() {},
  });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("Location"), "https://r2-cdn.okpn.f5.si/objects/bafy1234567890abcdefghij");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(getCalled, false);
});

test("R2 offload redirects static pages relay via receiving host and stays on Worker for expiring links, images, and missing R2 objects", async () => {
  const baseBucket = mockR2Bucket();
  // 1. Static pages relay (/r/punipuni-media/...) uses receiving host (relay.k7m.f5.si -> r2-cdn.k7m.f5.si)
  const relayRes = await deliver({
    request: new Request("https://relay.k7m.f5.si/r/punipuni-media/clip.mp4"),
    env: {
      STATIC_RELAY_PUBLIC_HOSTS: "punipuni-media.pages.dev",
      R2_PUBLIC_ORIGINS: R2_ORIGINS,
      CIVIDGE_KV: {
        getWithMetadata: async (key) => (key === "punipuni-media.pages.dev:clip.mp4"
          ? { value: "", metadata: { b: "r2", k_s3: "objects/bafy1234567890abcdefghij" } }
          : { value: null, metadata: null }),
      },
      R2_BUCKET: baseBucket,
    },
    waitUntil() {},
  });
  assert.equal(relayRes.status, 307);
  assert.equal(relayRes.headers.get("Location"), "https://r2-cdn.k7m.f5.si/objects/bafy1234567890abcdefghij");

  // 2. Expiring link stays on Worker
  const expRes = await deliver({
    request: new Request("https://kv.k7m.f5.si/clip.mp4"),
    env: {
      R2_PUBLIC_ORIGINS: R2_ORIGINS,
      CIVIDGE_KV: {
        getWithMetadata: async () => ({
          value: "",
          metadata: { b: "r2", k_s3: "objects/bafy1234567890abcdefghij", e: Math.floor(Date.now() / 1000) + 3600 },
        }),
      },
      R2_BUCKET: baseBucket,
    },
    waitUntil() {},
  });
  assert.equal(expRes.status, 200);

  // 3. Image stays on Worker
  const imgRes = await deliver({
    request: new Request("https://kv.k7m.f5.si/pic.webp"),
    env: {
      R2_PUBLIC_ORIGINS: R2_ORIGINS,
      CIVIDGE_KV: {
        getWithMetadata: async () => ({
          value: "",
          metadata: { b: "r2", k_s3: "objects/bafy1234567890abcdefghij" },
        }),
      },
      R2_BUCKET: baseBucket,
    },
    waitUntil() {},
  });
  assert.equal(imgRes.status, 200);

  // 4. Missing R2 object does not 307
  const missRes = await deliver({
    request: new Request("https://kv.k7m.f5.si/missing.mp4"),
    env: {
      R2_PUBLIC_ORIGINS: R2_ORIGINS,
      CIVIDGE_KV: {
        getWithMetadata: async () => ({
          value: "",
          metadata: { b: "r2", k_s3: "objects/bafy1234567890abcdefghij" },
        }),
      },
      R2_BUCKET: {
        head: async () => null,
        get: async () => null,
      },
    },
    waitUntil() {},
  });
  assert.notEqual(missRes.status, 307);
});
