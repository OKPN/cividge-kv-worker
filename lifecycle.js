import {
  addLink,
  beginRemoveLink,
  claimPlacement,
  completeRemoveLink,
  newLifecycle,
  parseObjectRef,
  recoverExpiredPlacementClaims,
  reportPlacement,
  requestPlacementAcquire,
  requestPlacementRelease,
  requestRelease,
} from "./lifecycle-model.js";
import { syncLifecycleProjection } from "./lifecycle-api.js";

const STATE_KEY = "lifecycle";

// One Durable Object is named by one canonical ObjectRef. Its SQLite-backed
// storage is the authority for the Object <-> Link relation; delivery KV is
// only a projection and is intentionally never read here.
export class ObjectLifecycle {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const body = await request.json();
    const object = parseObjectRef(body.objectRef);
    if (!object) return json({ error: "Invalid ObjectRef" }, 400);

    let state = await this.ctx.storage.get(STATE_KEY);
    if (state && state.objectRef !== object.objectRef) return json({ error: "Durable Object identity mismatch" }, 409);
    if (state && recoverExpiredPlacementClaims(state)) await this.persist(state);
    const action = body.action;
    try {
      if (action === "createLink") {
        state = state || newLifecycle(object.objectRef, body.placements || []);
        // A successful storage upload may re-establish a Placement belonging
        // to a previously RELEASED ObjectRef. Run the existing acquire state
        // machine inside this single DO turn so stale release claims cannot
        // race the new Link into existence.
        for (const placement of body.confirmedPlacements || []) {
          requestPlacementAcquire(state, placement);
          const currentPlacement = state.placements[String(placement.kind || "").toLowerCase()];
          if (currentPlacement?.state === "PIN_REQUESTED") {
            const claimed = claimPlacement(state, currentPlacement.kind, "acquire", crypto.randomUUID());
            reportPlacement(state, currentPlacement.kind, { ...claimed.task, outcome: "present" });
          } else if (currentPlacement?.state === "PINNING") {
            throw new Error("Placement acquisition is already in progress");
          }
        }
        addLink(state, body.linkKey, body.placements || []);
      } else if (action === "beginRemoveLink") {
        if (!state) return json({ error: "Object lifecycle not found" }, 404);
        beginRemoveLink(state, body.linkKey);
      } else if (action === "completeRemoveLink") {
        if (!state) return json({ error: "Object lifecycle not found" }, 404);
        completeRemoveLink(state, body.linkKey);
      } else if (action === "requestRelease") {
        if (!state) return json({ error: "Object lifecycle not found" }, 404);
        requestRelease(state);
      } else if (action === "requestPlacementRelease") {
        if (!state) return json({ error: "Object lifecycle not found" }, 404);
        requestPlacementRelease(state, body.placement);
      } else if (action === "requestPlacementAcquire") {
        if (!state) return json({ error: "Object lifecycle not found" }, 404);
        requestPlacementAcquire(state, body.placement);
      } else if (action === "claimPlacement") {
        if (!state) return json({ error: "Object lifecycle not found" }, 404);
        const claim = claimPlacement(state, body.placement, body.operation, crypto.randomUUID());
        await this.persist(state);
        return json({ lifecycle: state, claim: claim.task });
      } else if (action === "reportPlacement") {
        if (!state) return json({ error: "Object lifecycle not found" }, 404);
        reportPlacement(state, body.placement, {
          claimId: body.claimId,
          generation: body.generation,
          operation: body.operation,
          outcome: body.outcome,
          error: body.error,
        });
      } else if (action === "inspect") {
        return json({ lifecycle: state || null });
      } else {
        return json({ error: "Unknown lifecycle action" }, 400);
      }
      await this.persist(state);
      return json({ lifecycle: state });
    } catch (error) {
      return json({ error: error.message }, 409);
    }
  }

  async alarm() {
    const state = await this.ctx.storage.get(STATE_KEY);
    if (!state) return;
    const recovered = recoverExpiredPlacementClaims(state);
    await this.persist(state);
    if (recovered) await syncLifecycleProjection(this.env, state);
  }

  async persist(state) {
    await this.ctx.storage.put(STATE_KEY, state);
    const nextExpiry = Object.values(state?.placements || {})
      .map(placement => Number(placement.claim?.expiresAt))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (nextExpiry) await this.ctx.storage.setAlarm(nextExpiry);
    else await this.ctx.storage.deleteAlarm();
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
