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
    // A browser-held admin token must not be able to manufacture the durable
    // Worker-RPC provenance that authorizes CID-level unpin. Only trusted
    // in-Worker control flow may call this DO for RPC acquisition.
    const rpcAcquire = body.action === "requestPlacementAcquire" && body.placement?.kind === "filebase_rpc";
    const rpcClaim = body.action === "claimPlacement" && body.placement === "filebase_rpc" && body.operation === "acquire";
    const rpcReport = body.action === "reportPlacement" && body.placement === "filebase_rpc" && body.operation === "acquire";
    const rpcCreate = body.action === "createLink" &&
      [...(body.placements || []), ...(body.confirmedPlacements || [])].some(p => p.kind === "filebase_rpc");
    const workerReconcile = body.action === "reconcilePlacementForAcquire" && body.placement?.kind === "filebase_rpc";
    if (rpcAcquire || rpcClaim || rpcReport || rpcCreate || workerReconcile) {
      return json({ error: "Worker-managed RPC provenance cannot be asserted by an admin client" }, 403);
    }
    if (["beginThumbnailUpload", "reconcileMissingThumbnail", "reportThumbnailUpload", "claimThumbnailRelease", "reportThumbnailRelease"].includes(body.action)) {
      return json({ error: "Thumbnail actuator state is Worker-owned" }, 403);
    }
    if ((body.action === "requestPlacementAcquire" || body.action === "reconcilePlacementForAcquire") &&
        body.placement?.kind === "r2" &&
        (!env.R2_BUCKET_NAME || body.placement.locator?.bucket !== env.R2_BUCKET_NAME)) {
      return json({ error: "R2 Placement bucket does not match the Worker binding" }, 409);
    }
    if (body.action === "reconcilePlacementForAcquire") {
      const kind = body.placement?.kind;
      if (kind === "r2") {
        const key = body.placement?.locator?.key;
        if (!key || !env.R2_BUCKET || body.placement.locator.bucket !== env.R2_BUCKET_NAME) throw new Error("R2 Placement locator and binding are required");
        const head = await env.R2_BUCKET.head(key);
        if (head && head.customMetadata?.["object-id"] !== body.objectRef) throw new Error("R2 content identity cannot be verified");
        body.observation = head ? "present" : "absent";
      } else if (kind === "filebase") {
        if (body.observation === "present" &&
            body.observedCid !== body.placement?.locator?.cid) throw new Error("Filebase CID cannot be verified");
      } else throw new Error("Unsupported placement reconciliation");
    }
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

// The DO authorizes release first. This Worker only actuates bound R2 and
// explicitly Worker-created RPC placements; browser S3 and Kubo stay browser-owned.
export async function executeWorkerPlacements(env, objectRef, lifecycle) {
  for (const kind of ["r2", "filebase_rpc"]) {
    const placement = lifecycle?.placements?.[kind];
    if (!placement || !["RELEASE_PENDING", "RETRYABLE"].includes(placement.state)) continue;
    if (kind === "filebase_rpc" && !isManagedRpcReleaseEnabled(env, placement)) continue;
    lifecycle = await executeWorkerPlacement(env, objectRef, kind);
  }
  if (lifecycle?.thumbnail && ["RELEASE_PENDING", "RETRYABLE", "UNCERTAIN"].includes(lifecycle.thumbnail.state)) {
    lifecycle = await executeWorkerThumbnailRelease(env, objectRef);
  }
  return lifecycle;
}

async function executeWorkerThumbnailRelease(env, objectRef) {
  const claimed = await callLifecycle(env, { action: "claimThumbnailRelease", objectRef });
  try {
    if (!env.R2_BUCKET || claimed.claim.key !== claimed.lifecycle.thumbnail.key) {
      throw new Error("Thumbnail R2 release capability is unavailable");
    }
    await env.R2_BUCKET.delete(claimed.claim.key);
    return (await callLifecycle(env, { action: "reportThumbnailRelease", objectRef,
      claimId: claimed.claim.claimId, generation: claimed.claim.generation, outcome: "released" })).lifecycle;
  } catch (error) {
    return (await callLifecycle(env, { action: "reportThumbnailRelease", objectRef,
      claimId: claimed.claim.claimId, generation: claimed.claim.generation,
      outcome: "retryable", error: error.message })).lifecycle;
  }
}

export function isManagedRpcReleaseEnabled(env, placement) {
  return env.FILEBASE_DEDICATED_BUCKET === "true" &&
    Boolean(String(env.FILEBASE_IPFS_API_KEY || "").trim()) &&
    placement?.kind === "filebase_rpc" && placement.executor === "worker" &&
    placement.provenance === "cividge_worker_rpc" &&
    /^Qm[1-9A-HJ-NP-Za-km-z]{44}$|^b[a-z2-7]{20,}$/.test(String(placement.locator?.cid || ""));
}

async function executeWorkerPlacement(env, objectRef, kind) {
  // claimPlacement is the release authorization. No provider I/O may precede it.
  const claimed = await callLifecycle(env, { action: "claimPlacement", objectRef, placement: kind, operation: "release" });
  try {
    if (kind === "r2") {
      if (!env.R2_BUCKET_NAME || claimed.claim.locator.bucket !== env.R2_BUCKET_NAME) {
        throw new Error("R2 release bucket does not match the Worker binding");
      }
      await env.R2_BUCKET.delete(claimed.claim.locator.key);
    } else {
      if (!isManagedRpcReleaseEnabled(env, claimed.lifecycle.placements.filebase_rpc)) {
        throw new Error("Filebase RPC release capability is not enabled for this Placement");
      }
      await unpinManagedRpcCid(env, claimed.claim.locator.cid);
    }
    return (await callLifecycle(env, {
      action: "reportPlacement",
      objectRef,
      placement: kind,
      claimId: claimed.claim.claimId,
      generation: claimed.claim.generation,
      operation: "release",
      outcome: "released",
    })).lifecycle;
  } catch (error) {
    return (await callLifecycle(env, {
      action: "reportPlacement",
      objectRef,
      placement: kind,
      claimId: claimed.claim.claimId,
      generation: claimed.claim.generation,
      operation: "release",
      outcome: "retryable",
      error: error.message,
    })).lifecycle;
  }
}

async function unpinManagedRpcCid(env, cid) {
  const headers = { Authorization: `Bearer ${String(env.FILEBASE_IPFS_API_KEY).trim()}` };
  let failure;
  try {
    const response = await fetch(`https://rpc.filebase.io/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, { method: "POST", headers });
    if (response.ok) return;
    failure = new Error(`Filebase RPC pin/rm returned ${response.status}`);
  } catch (error) {
    failure = error;
  }
  // A lost response may follow a successful unpin. Read-only pin/ls can prove
  // absence in this dedicated bucket; unknown/malformed responses stay retryable.
  try { if (await isManagedRpcCidPinned(env, cid) === false) return; }
  catch (_) { /* inconclusive: retain retryable release state */ }
  throw failure;
}

export async function isManagedRpcCidPinned(env, cid) {
  const apiKey = String(env.FILEBASE_IPFS_API_KEY || "").trim();
  if (env.FILEBASE_DEDICATED_BUCKET !== "true" || !apiKey) {
    throw new Error("Cividge-exclusive RPC bucket capability is required");
  }
  const response = await fetch("https://rpc.filebase.io/api/v0/pin/ls", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`Filebase RPC pin/ls returned ${response.status}`);
  const payload = await response.json();
  if (!payload || !payload.Keys || typeof payload.Keys !== "object") {
    throw new Error("Filebase RPC pin/ls returned an unknown shape");
  }
  return Object.prototype.hasOwnProperty.call(payload.Keys, cid);
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
  const filebaseRpc = lifecycle.placements?.filebase_rpc;
  for (const linkKey of lifecycle.links || []) {
    const existing = await env.CIVIDGE_KV.getWithMetadata(linkKey);
    if (!existing || existing.value === null || existing.value === undefined) continue;
    const metadata = { ...(existing.metadata || {}) };
    let flags = Number(metadata.f || 0);
    metadata.kuboPlacementState = kubo?.state || "ABSENT";
    if (kubo?.claim?.expiresAt) metadata.kuboClaimExpiresAt = Number(kubo.claim.expiresAt);
    else delete metadata.kuboClaimExpiresAt;
    // Absence and in-progress acquisition are not confirmed preservation.
    // Delivery uses this projection conservatively for its origin safety cap.
    if (![filebase, filebaseRpc].some(p => p?.state === "PRESENT")) flags |= 1;
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
    if (lifecycle.thumbnail?.state === "PRESENT") metadata.th = lifecycle.thumbnail.key;
    else delete metadata.th;
    await env.CIVIDGE_KV.put(linkKey, existing.value, { metadata });
  }
}

export { callLifecycle };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}
