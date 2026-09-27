import { callLifecycle, executeWorkerPlacements, syncLifecycleProjection } from "./lifecycle-api.js";
import { parseObjectRef, thumbnailR2Key } from "./lifecycle-model.js";

// Admin-supplied preview bytes are a dependent artifact of an already-linked
// ObjectId. Only this Worker can acquire the DO claim and write its R2 key.
export async function onRequestPost({ request, env }) {
  const expected = String(env.ADMIN_API_TOKEN || env.API_TOKEN || "").trim();
  const supplied = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || supplied !== expected) return json({ error: "Unauthorized" }, 401);
  const object = parseObjectRef(request.headers.get("X-Object-Id"));
  if (!object) return json({ error: "Invalid parent ObjectId" }, 400);
  if (!env.R2_BUCKET) return json({ error: "Thumbnail R2 capability is unavailable" }, 503);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length < 12 || bytes.length > 4_000_000 ||
      String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
      String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") {
    return json({ error: "A WebP thumbnail of at most 4 MB is required" }, 400);
  }
  let started;
  try {
    const inspected = await callLifecycle(env, { action: "inspect", objectRef: object.objectRef });
    if (inspected.lifecycle?.thumbnail?.state === "PRESENT") {
      if (!env.R2_BUCKET.head) throw new Error("Thumbnail R2 inspection is unavailable");
      const observed = await env.R2_BUCKET.head(thumbnailR2Key(object.objectRef));
      if (!observed) {
        const reconciled = await callLifecycle(env, { action: "reconcileMissingThumbnail", objectRef: object.objectRef });
        await syncLifecycleProjection(env, reconciled.lifecycle);
      }
    }
    started = await callLifecycle(env, { action: "beginThumbnailUpload", objectRef: object.objectRef });
    if (started.noOp) return json({ success: true, noOp: true });
    const key = thumbnailR2Key(object.objectRef);
    await env.R2_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: { "parent-object-id": object.objectRef },
    });
    const completed = await callLifecycle(env, { action: "reportThumbnailUpload", objectRef: object.objectRef,
      claimId: started.claim.claimId, generation: started.claim.generation, outcome: "present" });
    await syncLifecycleProjection(env, completed.lifecycle);
    if (!completed.lifecycle.links.length) {
      const settled = await executeWorkerPlacements(env, object.objectRef, completed.lifecycle);
      await syncLifecycleProjection(env, settled);
    }
    return json({ success: true });
  } catch (error) {
    if (started?.claim) {
      try {
        const failed = await callLifecycle(env, { action: "reportThumbnailUpload", objectRef: object.objectRef,
          claimId: started.claim.claimId, generation: started.claim.generation,
          outcome: "failed", error: error.message });
        await syncLifecycleProjection(env, failed.lifecycle);
        if (!failed.lifecycle.links.length) await executeWorkerPlacements(env, object.objectRef, failed.lifecycle);
      } catch (_) { /* lease recovery retains the deterministic key for cleanup */ }
    }
    return json({ error: error.message }, 409);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
