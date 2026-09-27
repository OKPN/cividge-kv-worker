import assert from "node:assert/strict";
import test from "node:test";
import { objectIdFromBytes, parseObjectId } from "../object-id.js";
import { addLink, claimPlacement, newLifecycle, removeLink, reportPlacement,
  requestPlacementAcquire, requestPlacementRelease, requestRelease } from "../lifecycle-model.js";
import { classifyUpload } from "../upload.js";

const bytes = text => new TextEncoder().encode(text);
const cid = "Qm" + "A".repeat(44);

test("exact final bytes alone determine ObjectId across R2 and Filebase", async () => {
  const content = bytes("same immutable bytes");
  const first = await objectIdFromBytes(content);
  assert.equal(first, await objectIdFromBytes(new Uint8Array(content)));
  assert.notEqual(first, await objectIdFromBytes(bytes("different immutable bytes")));
  assert.deepEqual(parseObjectId(first), { objectRef: first, digest: first.slice(7) });
  assert.equal(parseObjectId(`r2:objects/${cid}`), null);
  assert.equal(parseObjectId(`ipfs:${cid}`), null);
  assert.equal(parseObjectId(first.toUpperCase()), null);

  const lifecycle = newLifecycle(first);
  const r2 = { kind: "r2", executor: "worker", locator: { bucket: "cividge", key: "objects/r2-key" } };
  const filebase = { kind: "filebase", executor: "browser", locator: { bucket: "cividge", key: "objects/filebase-key", cid } };
  requestPlacementAcquire(lifecycle, r2);
  let claim = claimPlacement(lifecycle, "r2", "acquire", "r2-acquire").task;
  reportPlacement(lifecycle, "r2", { ...claim, outcome: "present" });
  addLink(lifecycle, "a.example:first.webp");
  assert.equal(classifyUpload(null, lifecycle, "filebase", false, first), "create");
  requestPlacementAcquire(lifecycle, filebase);
  claim = claimPlacement(lifecycle, "filebase", "acquire", "filebase-acquire").task;
  reportPlacement(lifecycle, "filebase", { ...claim, outcome: "present" });
  addLink(lifecycle, "b.example:second.webp");
  addLink(lifecycle, "b.example:second.webp");
  assert.deepEqual(lifecycle.links, ["a.example:first.webp", "b.example:second.webp"]);
  assert.equal(lifecycle.placements.r2.state, "PRESENT");
  assert.equal(lifecycle.placements.filebase.state, "PRESENT");
  assert.equal(lifecycle.placements.filebase.locator.cid, cid); // CIDv0 case survives.
  assert.equal(classifyUpload({ status: "BOUND", objectRef: first }, lifecycle, "r2", true, first), "noop");
  assert.equal(classifyUpload({ status: "BOUND", objectRef: await objectIdFromBytes(bytes("other")) },
    lifecycle, "r2", true, first), "conflict");

  removeLink(lifecycle, "a.example:first.webp");
  assert.throws(() => requestRelease(lifecycle), /active Links/);
  assert.equal(lifecycle.placements.r2.state, "PRESENT");
  assert.equal(lifecycle.placements.filebase.state, "PRESENT");
  removeLink(lifecycle, "b.example:second.webp");
  requestRelease(lifecycle);
  assert.equal(lifecycle.state, "RELEASE_PENDING");
  assert.equal(lifecycle.placements.r2.state, "RELEASE_PENDING");
  assert.equal(lifecycle.placements.filebase.state, "RELEASE_PENDING");
});

test("Kubo is a placement of the same ObjectId and source release requires confirmed preservation", async () => {
  const id = await objectIdFromBytes(bytes("kubo-shared"));
  const lifecycle = newLifecycle(id, [{ kind: "filebase", executor: "browser", locator: { bucket: "cividge", key: "filebase-key", cid } }]);
  addLink(lifecycle, "a.example:media.webp");
  requestPlacementAcquire(lifecycle, { kind: "kubo", executor: "browser", locator: { cid } });
  assert.throws(() => requestPlacementRelease(lifecycle, "filebase"), /preserv|Placement|source/i);
  const claim = claimPlacement(lifecycle, "kubo", "acquire", "pin").task;
  reportPlacement(lifecycle, "kubo", { ...claim, outcome: "present" });
  requestPlacementRelease(lifecycle, "filebase");
  assert.equal(lifecycle.placements.filebase.state, "RELEASE_PENDING");
  assert.equal(lifecycle.placements.kubo.state, "PRESENT");
});

test("S3 bucket and key are Placement locators, never part of ObjectId", async () => {
  const id = await objectIdFromBytes(bytes("same bytes regardless of bucket"));
  assert.throws(() => newLifecycle(id, [{ kind: "r2", executor: "worker", locator: { key: "objects/key" } }]),
    /bucket and key/);
  assert.throws(() => newLifecycle(id, [{ kind: "filebase", executor: "browser", locator: { key: "objects/key", cid } }]),
    /bucket and key/);
  const lifecycle = newLifecycle(id, [{ kind: "r2", executor: "worker",
    locator: { bucket: "cividge", key: "objects/key" } }]);
  assert.equal(lifecycle.objectRef, id);
  addLink(lifecycle, "public.example:same.webp");
  assert.throws(() => addLink(lifecycle, "public.example:same.webp", [{ kind: "r2", executor: "worker",
    locator: { bucket: "another-bucket", key: "objects/key" } }]), /different locator/);
  assert.throws(() => requestPlacementAcquire(lifecycle, { kind: "r2", executor: "worker",
    locator: { bucket: "another-bucket", key: "objects/key" } }), /different locator/);
});
