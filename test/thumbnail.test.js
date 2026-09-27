import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ObjectLifecycleV2 } from "../lifecycle.js";
import { onRequestPost as uploadThumbnail } from "../thumbnail-api.js";
import { onRequestPost as lifecycleApi } from "../lifecycle-api.js";
import { onRequest as deliver } from "../delivery.js";
import { addLink, beginThumbnailUpload, claimThumbnailRelease, newLifecycle,
  removeLink, reportThumbnailRelease, reportThumbnailUpload, requestRelease,
  thumbnailR2Key } from "../lifecycle-model.js";

const objectId = label => `sha256:${createHash("sha256").update(label).digest("hex")}`;
const webp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80, 0]);

test("thumbnail belongs to parent, stays for peers, and releases only after final Link", () => {
  const id = objectId("video-one");
  const state = newLifecycle(id, [{ kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "video.mp4" } }]);
  addLink(state, "a.example:video.mp4");
  addLink(state, "b.example:alternate.mp4");
  const started = beginThumbnailUpload(state);
  reportThumbnailUpload(state, { ...started.claim, outcome: "present" });
  assert.equal(state.thumbnail.key, thumbnailR2Key(id));
  assert.equal(state.placements.r2.locator.key, "video.mp4");
  assert.deepEqual(state.links, ["a.example:video.mp4", "b.example:alternate.mp4"]);
  removeLink(state, "a.example:video.mp4");
  assert.throws(() => requestRelease(state), /active Links/);
  assert.equal(state.thumbnail.state, "PRESENT");
  removeLink(state, "b.example:alternate.mp4");
  requestRelease(state);
  assert.equal(state.thumbnail.state, "RELEASE_PENDING");
  const claim = claimThumbnailRelease(state).claim;
  assert.throws(() => addLink(state, "c.example:video.mp4"), /not linkable/);
  reportThumbnailRelease(state, { ...claim, outcome: "retryable", error: "R2 timeout" });
  assert.equal(state.state, "RELEASE_PENDING");
  const retry = claimThumbnailRelease(state).claim;
  reportThumbnailRelease(state, { ...retry, outcome: "released" });
  assert.equal(state.placements.r2.state, "RELEASE_PENDING");
  assert.equal(state.state, "RELEASE_PENDING", "parent waits for its media Placement too");
});

function fixture() {
  const id = objectId("video-two");
  const first = "a.example:video.mp4";
  const second = "b.example:another.mp4";
  const lifecycle = newLifecycle(id, [{ kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "video.mp4" } }]);
  addLink(lifecycle, first);
  addLink(lifecycle, second);
  const rows = new Map([
    [first, { value: "", metadata: { oid: id, b: "r2", k_s3: "video.mp4" } }],
    [second, { value: "", metadata: { oid: id, b: "r2", k_s3: "video.mp4" } }],
  ]);
  const values = new Map([["lifecycle", lifecycle]]);
  const r2 = new Map();
  const deleted = [];
  const kvReads = [];
  const env = {
    ADMIN_API_TOKEN: "secret", R2_BUCKET_NAME: "cividge",
    CIVIDGE_KV: {
      async getWithMetadata(key) { kvReads.push(key); return rows.get(key) || { value: null, metadata: null }; },
      async put(key, value, options) { rows.set(key, { value, metadata: options.metadata }); },
    },
    R2_BUCKET: {
      async put(key, bytes) { r2.set(key, new Uint8Array(bytes)); },
      async head(key) { return r2.has(key) ? { key } : null; },
      async get(key) { return r2.has(key) ? { body: new Blob([r2.get(key)]) } : null; },
      async delete(key) { deleted.push(key); r2.delete(key); },
    },
  };
  const durable = new ObjectLifecycleV2({ storage: {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async setAlarm() {}, async deleteAlarm() {},
  } }, env);
  env.OBJECT_LIFECYCLE = { idFromName: value => value,
    get: () => ({ fetch: (url, options) => durable.fetch(new Request(url, options)) }) };
  return { id, first, second, rows, values, r2, deleted, kvReads, env };
}

test("Worker thumbnail upload creates no public Link and both peer previews use one parent artifact", async () => {
  const f = fixture();
  const response = await uploadThumbnail({ request: new Request("https://worker.example/api/thumbnail", {
    method: "POST", headers: { Authorization: "Bearer secret", "X-Object-Id": f.id }, body: webp,
  }), env: f.env });
  assert.equal(response.status, 200);
  assert.deepEqual([...f.rows.keys()], [f.first, f.second], "canonical managed rows are only user Links");
  assert.equal(f.rows.get(f.first).metadata.th, thumbnailR2Key(f.id));
  assert.equal(f.rows.get(f.second).metadata.th, thumbnailR2Key(f.id));
  for (const link of [f.first, f.second]) {
    const [host, filename] = link.split(":");
    const preview = await deliver({ request: new Request(`https://${host}/${filename}?preview=1`),
      env: f.env, waitUntil() {}, next: () => new Response("not found", { status: 404 }) });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("Content-Type"), "image/webp");
  }
  assert.deepEqual(f.kvReads.slice(-2), [f.first, f.second], "one canonical lookup per preview");
  assert.deepEqual([...f.r2.keys()], [thumbnailR2Key(f.id)]);
});

test("final parent release alone deletes thumbnail and failed cleanup remains retryable", async () => {
  const f = fixture();
  const begun = beginThumbnailUpload(f.values.get("lifecycle"));
  reportThumbnailUpload(f.values.get("lifecycle"), { ...begun.claim, outcome: "present" });
  f.r2.set(thumbnailR2Key(f.id), webp);
  const oneRemoved = f.values.get("lifecycle");
  removeLink(oneRemoved, f.first);
  f.values.set("lifecycle", oneRemoved);
  assert.equal(oneRemoved.thumbnail.state, "PRESENT");
  assert.deepEqual(f.deleted, []);
  removeLink(oneRemoved, f.second);
  f.values.set("lifecycle", oneRemoved);
  const originalDelete = f.env.R2_BUCKET.delete;
  let failOnce = true;
  f.env.R2_BUCKET.delete = async key => {
    if (key === thumbnailR2Key(f.id) && failOnce) { failOnce = false; throw new Error("transient"); }
    return originalDelete(key);
  };
  const request = () => new Request("https://worker.example/api/lifecycle", {
    method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "requestRelease", objectRef: f.id }),
  });
  const first = await lifecycleApi({ request: request(), env: f.env });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).lifecycle.thumbnail.state, "RETRYABLE");
  assert.ok(f.r2.has(thumbnailR2Key(f.id)));
  const second = await lifecycleApi({ request: request(), env: f.env });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).lifecycle.state, "RELEASED");
  assert.equal(f.r2.has(thumbnailR2Key(f.id)), false);
  assert.deepEqual(f.deleted, ["video.mp4", thumbnailR2Key(f.id)]);
});

test("genuine filename ending in thumb.webp remains a normal Link", () => {
  const state = newLifecycle(objectId("real-image"));
  addLink(state, "a.example:foo.thumb.webp");
  assert.deepEqual(state.links, ["a.example:foo.thumb.webp"]);
});

test("different bytes reusing a filename cannot inherit an old Object's preview", () => {
  const oldId = objectId("old-video-bytes");
  const newId = objectId("new-video-bytes");
  const old = newLifecycle(oldId);
  const fresh = newLifecycle(newId);
  addLink(old, "a.example:video.mp4");
  const claim = beginThumbnailUpload(old).claim;
  reportThumbnailUpload(old, { ...claim, outcome: "present" });
  removeLink(old, "a.example:video.mp4");
  requestRelease(old);
  addLink(fresh, "a.example:video.mp4");
  assert.notEqual(thumbnailR2Key(oldId), thumbnailR2Key(newId));
  assert.equal(fresh.thumbnail, null);
});

test("uncertain thumbnail upload cannot be promoted to PRESENT by cancelling release", () => {
  const state = newLifecycle(objectId("uncertain-video"));
  addLink(state, "a.example:video.mp4");
  const claim = beginThumbnailUpload(state).claim;
  reportThumbnailUpload(state, { ...claim, outcome: "failed", error: "lost PUT response" });
  assert.equal(state.thumbnail.state, "UNCERTAIN");
  removeLink(state, "a.example:video.mp4");
  requestRelease(state);
  assert.throws(() => addLink(state, "b.example:video.mp4"), /already started/);
  const cleanup = claimThumbnailRelease(state).claim;
  reportThumbnailRelease(state, { ...cleanup, outcome: "released" });
  assert.equal(state.state, "RELEASED");
});

test("preview PUT failure leaves the main video Link and Placement intact", async () => {
  const f = fixture();
  f.env.R2_BUCKET.put = async () => { throw new Error("preview R2 unavailable"); };
  const response = await uploadThumbnail({ request: new Request("https://worker.example/api/thumbnail", {
    method: "POST", headers: { Authorization: "Bearer secret", "X-Object-Id": f.id }, body: webp,
  }), env: f.env });
  assert.equal(response.status, 409);
  assert.deepEqual(f.values.get("lifecycle").links, [f.first, f.second]);
  assert.equal(f.values.get("lifecycle").placements.r2.state, "PRESENT");
  assert.equal(f.values.get("lifecycle").thumbnail.state, "UNCERTAIN");
  assert.equal(f.rows.get(f.first).metadata.th, undefined);
  assert.equal(f.rows.get(f.second).metadata.th, undefined);
});

test("explicit video re-upload rebuilds a missing preview without a new Link", async () => {
  const f = fixture();
  const post = () => uploadThumbnail({ request: new Request("https://worker.example/api/thumbnail", {
    method: "POST", headers: { Authorization: "Bearer secret", "X-Object-Id": f.id }, body: webp,
  }), env: f.env });
  assert.equal((await post()).status, 200);
  f.r2.delete(thumbnailR2Key(f.id));
  assert.equal((await post()).status, 200);
  assert.equal(f.r2.has(thumbnailR2Key(f.id)), true);
  assert.deepEqual([...f.rows.keys()], [f.first, f.second]);
});
