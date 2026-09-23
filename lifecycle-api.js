import { parseObjectRef } from "./lifecycle-model.js";

function verifyAdminAuth(request, env) {
  const token = String(env.ADMIN_API_TOKEN || env.API_TOKEN || "").trim();
  const header = String(request.headers.get("Authorization") || "").trim();
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : header;
  return Boolean(token) && supplied === token;
}

function lifecycleStub(env, objectRef) {
  const parsed = parseObjectRef(objectRef);
  if (!parsed || !env.OBJECT_LIFECYCLE) return null;
  return { objectRef: parsed.objectRef, stub: env.OBJECT_LIFECYCLE.get(env.OBJECT_LIFECYCLE.idFromName(parsed.objectRef)) };
}

async function callLifecycle(env, body) {
  const target = lifecycleStub(env, body.objectRef);
  if (!target) throw new Error("Object lifecycle binding or ObjectRef is missing");
  const response = await target.stub.fetch("https://object-lifecycle.internal/", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, objectRef: target.objectRef }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Lifecycle operation failed");
  return payload;
}

export async function onRequestPost({ request, env }) {
  if (!verifyAdminAuth(request, env)) return json({ error: "Unauthorized: Admin token required" }, 401);
  try {
    const body = await request.json();
    const payload = await callLifecycle(env, body);
    if (body.action === "requestRelease" || body.action === "requestPlacementRelease") {
      const lifecycle = await executeWorkerPlacements(env, body.objectRef, payload.lifecycle);
      await syncLifecycleProjection(env, lifecycle);
      return json({ success: true, lifecycle, browserTasks: pendingBrowserTasks(lifecycle) });
    }
    if (body.action === "requestPlacementAcquire") {
      await syncLifecycleProjection(env, payload.lifecycle);
      return json({ success: true, ...payload, browserTasks: pendingBrowserTasks(payload.lifecycle) });
    }
    if (body.action === "reportPlacement") await syncLifecycleProjection(env, payload.lifecycle);
    return json({ success: true, ...payload });
  } catch (error) {
    return json({ error: error.message }, 409);
  }
}

// R2 is bound to this Worker, so its physical capability holder is server-side.
// Filebase/Kubo are intentionally not executed here: their credentials/capability
// holders remain in the browser and must claim/report an authorized task.
async function executeWorkerPlacements(env, objectRef, lifecycle) {
  const placement = lifecycle?.placements?.r2;
  if (!placement || placement.state !== "RELEASE_PENDING") return lifecycle;
  const claimed = await callLifecycle(env, { action: "claimPlacement", objectRef, placement: "r2", operation: "release" });
  try {
    const keys = [claimed.claim.locator.key, claimed.claim.locator.thumbnailKey].filter(Boolean);
    for (const key of keys) await env.R2_BUCKET.delete(key);
    return (await callLifecycle(env, {
      action: "reportPlacement",
      objectRef,
      placement: "r2",
      claimId: claimed.claim.claimId,
      generation: claimed.claim.generation,
      operation: "release",
      outcome: "released",
    })).lifecycle;
  } catch (error) {
    return (await callLifecycle(env, {
      action: "reportPlacement",
      objectRef,
      placement: "r2",
      claimId: claimed.claim.claimId,
      generation: claimed.claim.generation,
      operation: "release",
      outcome: "retryable",
      error: error.message,
    })).lifecycle;
  }
}

function pendingBrowserTasks(lifecycle) {
  return Object.values(lifecycle?.placements || {})
    .filter(placement => placement.executor === "browser" && (
      placement.state === "RELEASE_PENDING" ||
      placement.state === "RETRYABLE" ||
      placement.state === "PIN_REQUESTED"
    ))
    .map(placement => ({
      kind: placement.kind,
      locator: placement.locator,
      operation: placement.state === "PIN_REQUESTED" ? "acquire" : "release",
    }));
}

export async function syncLifecycleProjection(env, lifecycle) {
  if (!env.CIVIDGE_KV || !lifecycle) return;
  const kubo = lifecycle.placements?.kubo;
  const filebase = lifecycle.placements?.filebase;
  for (const linkKey of lifecycle.links || []) {
    const existing = await env.CIVIDGE_KV.getWithMetadata(linkKey);
    if (!existing || existing.value === null || existing.value === undefined) continue;
    const metadata = { ...(existing.metadata || {}) };
    let flags = Number(metadata.f || 0);
    metadata.kuboPlacementState = kubo?.state || "ABSENT";
    if (kubo?.claim?.expiresAt) metadata.kuboClaimExpiresAt = Number(kubo.claim.expiresAt);
    else delete metadata.kuboClaimExpiresAt;
    if (filebase?.state === "RELEASED") flags |= 1;
    else flags &= ~1;
    if (kubo?.state === "PRESENT") {
      flags = (flags | 2) & ~4;
      metadata.kuboStatus = "pinned";
      if (kubo.locator?.cid) {
        metadata.c_cid = kubo.locator.cid;
        metadata.contentCid = kubo.locator.cid;
      }
    } else {
      flags = (flags | 4) & ~2;
      metadata.kuboStatus = "not_pinned";
    }
    metadata.f = flags;
    await env.CIVIDGE_KV.put(linkKey, existing.value, { metadata });
  }
}

export { callLifecycle };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}
