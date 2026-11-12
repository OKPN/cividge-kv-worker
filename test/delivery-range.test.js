import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as deliver, parseBytesRange } from "../delivery.js";

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
