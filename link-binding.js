import { parseCanonicalLinkKey, parseObjectRef } from "./lifecycle-model.js";

const STATE_KEY = "binding";
const ATTEMPT_LEASE_MS = 5 * 60_000;

// One Durable Object is named by one canonical Link key. It owns the unique
// Link -> ObjectRef binding, not Object/Placement lifecycle or delivery reads.
export class LinkBinding {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    let body;
    try { body = await request.json(); } catch (_) { return json({ error: "Invalid JSON" }, 400); }
    const link = parseCanonicalLinkKey(body.linkKey);
    if (!link) return json({ error: "Invalid canonical Link key" }, 400);
    let state = await this.ctx.storage.get(STATE_KEY);
    if (state && state.linkKey !== link.key) return json({ error: "Link DO identity mismatch" }, 409);
    const action = body.action;
    if (action === "inspect") return json({ binding: state || null });
    try {
      if (action === "reserve") {
        const object = parseObjectRef(body.objectRef);
        if (!object || !body.attemptId) throw new Error("ObjectRef and attemptId are required");
        if (state?.status === "RETIRING") return json({ error: "Link removal is in progress", code: "LIFECYCLE_CONFLICT" }, 409);
        if (state?.status !== "RETIRED" && state?.objectRef && state.objectRef !== object.objectRef) {
          return json({ error: "Link is bound or reserved for another Object", code: "LINK_OBJECT_CONFLICT" }, 409);
        }
        if (state?.status === "RETIRED") {
          state.status = "RESERVED";
          state.objectRef = object.objectRef;
          state.attempt = null;
          state.generation = (state.generation || 0) + 1;
        }
        if (state?.attempt && state.attempt.id !== body.attemptId) {
          return json({ error: "Link has an unfinished upload attempt", code: "RESERVATION_CONFLICT", attempt: state.attempt }, 409);
        }
        if (state?.status === "BOUND" && !body.acquirePlacement) return json({ binding: state, result: "bound" });
        if (!state) state = { linkKey: link.key, objectRef: object.objectRef,
          status: "RESERVED", generation: 1, attemptGeneration: 0, attempt: null };
        if (!state.attempt) {
          if (body.placement && (!body.placement.kind ||
              !(body.placement.locator?.key || body.placement.locator?.cid))) {
            throw new Error("Upload Placement locator is required");
          }
          state.attempt = {
            id: String(body.attemptId),
            placement: body.placement || null,
            phase: "RESERVED",
            createdAt: Date.now(),
            expiresAt: Date.now() + ATTEMPT_LEASE_MS,
            generation: (state.attemptGeneration || 0) + 1,
          };
          state.attemptGeneration = state.attempt.generation;
        }
        await this.ctx.storage.put(STATE_KEY, state);
        return json({ binding: state, result: state.status === "BOUND" ? "reacquire" : "reserved" });
      }
      if (!state) return json({ error: "Link binding not found", code: "LINK_NOT_FOUND" }, 404);
      if (action === "takeover") {
        if (!state.attempt || state.attempt.id !== body.previousAttemptId ||
            state.objectRef !== parseObjectRef(body.objectRef)?.objectRef ||
            Date.now() < state.attempt.expiresAt || !body.attemptId) {
          throw new Error("Upload attempt is not recoverable yet");
        }
        state.attemptGeneration = (state.attemptGeneration || 0) + 1;
        state.attempt = { ...state.attempt, id: String(body.attemptId),
          generation: state.attemptGeneration, createdAt: Date.now(), expiresAt: Date.now() + ATTEMPT_LEASE_MS };
      } else if (action === "renew") {
        requireAttempt(state, body.attemptId, body.generation);
        state.attempt.expiresAt = Date.now() + ATTEMPT_LEASE_MS;
      } else if (action === "markPhysical") {
        requireAttempt(state, body.attemptId, body.generation);
        state.attempt.phase = "PHYSICAL_PUT_REPORTED";
        if (body.cid) state.attempt.cid = String(body.cid);
      } else if (action === "recordUnexpectedCid") {
        requireAttempt(state, body.attemptId, body.generation);
        if (!body.cid || !parseObjectRef(`ipfs:${String(body.cid).toLowerCase()}`)) {
          throw new Error("A valid observed CID is required");
        }
        // Observation only: this does not attest Placement ownership or
        // authorize pin/rm. A human must inspect the dedicated bucket.
        state.attempt.phase = "MANUAL_CID_REVIEW";
        state.attempt.unexpectedCid = String(body.cid);
      } else if (action === "commit") {
        if (state.status === "BOUND" && !state.attempt) return json({ binding: state });
        requireAttempt(state, body.attemptId, body.generation);
        state.status = "BOUND";
        state.attempt = null;
      } else if (action === "beginRemove") {
        if (state.status === "RETIRING") return json({ binding: state });
        if (state.status !== "BOUND" || state.attempt) throw new Error("Link is not removable");
        state.status = "RETIRING";
      } else if (action === "completeRemove") {
        if (state.status !== "RETIRING") throw new Error("Link removal was not begun");
        // Keep the generation so a delayed KV projection cannot impersonate
        // a future explicit rebind of the same canonical Link key.
        state.status = "RETIRED";
        state.attempt = null;
      } else if (action === "abort") {
        requireAttempt(state, body.attemptId, body.generation);
        // The actuator must first attest that the planned physical key is
        // absent. Otherwise keep the durable attempt for later recovery.
        if (body.physicalAbsent !== true) throw new Error("Physical absence must be confirmed before abort");
        if (state.status === "BOUND") state.attempt = null;
        else { state.status = "RETIRED"; state.attempt = null; }
      } else {
        return json({ error: "Unknown Link action" }, 400);
      }
      await this.ctx.storage.put(STATE_KEY, state);
      return json({ binding: state });
    } catch (error) {
      return json({ error: error.message, code: "LIFECYCLE_CONFLICT" }, 409);
    }
  }
}

function requireAttempt(state, attemptId, generation) {
  if (!state.attempt || state.attempt.id !== attemptId || state.attempt.generation !== generation) {
    throw new Error("Stale upload attempt");
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
