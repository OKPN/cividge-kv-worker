// Closed lifecycle model shared by the Durable Object and its tests.
// ObjectRef, Link and Placement are distinct identities. The authoritative
// relation is the Link set itself; no eventually-consistent ref counter exists.

export const OBJECT_STATES = new Set(["ACTIVE", "RELEASE_PENDING", "RELEASING", "RELEASED"]);
export const PLACEMENT_STATES = new Set([
  "ABSENT", "PIN_REQUESTED", "PINNING", "PRESENT",
  "RELEASE_PENDING", "RELEASING", "RELEASED", "RETRYABLE",
]);
// Longer than the browser's three-minute Kubo confirmation window so a valid
// executor can report before the authority reclaims an abandoned claim.
export const PLACEMENT_CLAIM_LEASE_MS = 240_000;

export function parseObjectRef(value) {
  const ref = String(value || "").trim();
  const match = /^(r2|ipfs):(.+)$/.exec(ref);
  if (!match || !match[2] || /[\r\n]/.test(match[2])) return null;
  const kind = match[1];
  const locator = kind === "ipfs" ? match[2].toLowerCase() : match[2];
  return { objectRef: kind + ":" + locator, kind, locator };
}

export function parseCanonicalLinkKey(value) {
  const key = String(value || "").trim();
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  const host = key.slice(0, separator).toLowerCase();
  const filename = key.slice(separator + 1);
  if (!host || !filename || host.includes("/") || /\s/.test(host)) return null;
  return { key: host + ":" + filename, host, filename };
}

function canonicalPlacement(placement, initialState = "PRESENT") {
  const kind = String(placement?.kind || "").trim().toLowerCase();
  const executor = String(placement?.executor || "").trim().toLowerCase();
  if (!["r2", "filebase", "kubo"].includes(kind)) throw new Error("Invalid placement kind");
  if (!["worker", "browser"].includes(executor)) throw new Error("Invalid placement executor");
  if ((kind === "r2") !== (executor === "worker")) throw new Error("Placement executor does not match capability holder");
  if (!placement?.locator || typeof placement.locator !== "object") throw new Error("Placement locator is required");
  return {
    kind,
    executor,
    locator: structuredClone(placement.locator),
    state: initialState,
    generation: 0,
    claim: null,
    lastCompletedClaim: null,
    error: null,
  };
}

function samePlacement(left, right) {
  return left.executor === right.executor && JSON.stringify(left.locator) === JSON.stringify(right.locator);
}

export function newLifecycle(objectRef, placements = []) {
  const parsed = parseObjectRef(objectRef);
  if (!parsed) throw new Error("Invalid ObjectRef");
  const mapped = {};
  for (const placement of placements) {
    const value = canonicalPlacement(placement);
    if (mapped[value.kind]) throw new Error("Duplicate placement kind");
    mapped[value.kind] = value;
  }
  return {
    version: 2,
    objectRef: parsed.objectRef,
    state: "ACTIVE",
    links: [],
    pendingLinkRemovals: [],
    placements: mapped,
  };
}

function activePreservingPlacement(current, exceptKind) {
  return Object.values(current.placements).some(placement =>
    placement.kind !== exceptKind && placement.state === "PRESENT"
  );
}

export function addLink(current, linkKey, placements = []) {
  const link = parseCanonicalLinkKey(linkKey);
  if (!link) throw new Error("Invalid canonical Link key");
  if (current.state === "RELEASED" || current.state === "RELEASING") throw new Error("Object is not linkable");
  if (current.links.includes(link.key)) throw new Error("Link already exists");
  if (current.state === "RELEASE_PENDING") {
    if (Object.values(current.placements).some(p => p.state === "RELEASING" || p.state === "RELEASED")) {
      throw new Error("Object release has already started");
    }
    current.state = "ACTIVE";
    for (const placement of Object.values(current.placements)) {
      if (placement.state === "RELEASE_PENDING" || placement.state === "RETRYABLE") {
        placement.state = "PRESENT";
        placement.claim = null;
        placement.error = null;
      }
    }
  }
  for (const rawPlacement of placements) {
    const placement = canonicalPlacement(rawPlacement);
    const existing = current.placements[placement.kind];
    if (!existing) current.placements[placement.kind] = placement;
    else if (!samePlacement(existing, placement)) throw new Error("A Placement cannot be reassigned to a different locator");
  }
  current.pendingLinkRemovals = current.pendingLinkRemovals.filter(key => key !== link.key);
  current.links.push(link.key);
  current.links.sort();
  return current;
}

// Pending removal remains a reference until the KV projection is gone.
export function beginRemoveLink(current, linkKey) {
  const link = parseCanonicalLinkKey(linkKey);
  if (!link) throw new Error("Invalid canonical Link key");
  if (!current.links.includes(link.key)) {
    if (current.pendingLinkRemovals.includes(link.key)) return current;
    throw new Error("Link not found");
  }
  if (!current.pendingLinkRemovals.includes(link.key)) current.pendingLinkRemovals.push(link.key);
  return current;
}

export function completeRemoveLink(current, linkKey) {
  const link = parseCanonicalLinkKey(linkKey);
  if (!link) throw new Error("Invalid canonical Link key");
  if (!current.pendingLinkRemovals.includes(link.key)) {
    if (!current.links.includes(link.key)) return current;
    throw new Error("Link removal was not begun");
  }
  current.links = current.links.filter(key => key !== link.key);
  current.pendingLinkRemovals = current.pendingLinkRemovals.filter(key => key !== link.key);
  return current;
}

export function removeLink(current, linkKey) {
  beginRemoveLink(current, linkKey);
  return completeRemoveLink(current, linkKey);
}

export function requestRelease(current) {
  if (current.links.length !== 0 || current.pendingLinkRemovals.length !== 0) {
    throw new Error("Object still has active Links");
  }
  if (current.state === "RELEASED") return current;
  if (current.state === "RELEASING") throw new Error("Object release is already in progress");
  current.state = "RELEASE_PENDING";
  for (const placement of Object.values(current.placements)) {
    if (placement.state === "PRESENT" || placement.state === "RETRYABLE") {
      placement.state = "RELEASE_PENDING";
      placement.claim = null;
    }
  }
  return current;
}

export function requestPlacementRelease(current, kind) {
  const placement = current.placements[String(kind || "").toLowerCase()];
  if (!placement) throw new Error("Unknown placement");
  if (placement.state === "RELEASED") return current;
  if (placement.state === "RELEASING") throw new Error("Placement release is already in progress");
  if (current.links.length !== 0 && !activePreservingPlacement(current, placement.kind)) {
    throw new Error("A linked Object needs another PRESENT placement before source release");
  }
  placement.state = "RELEASE_PENDING";
  placement.claim = null;
  placement.error = null;
  return current;
}

export function requestPlacementAcquire(current, rawPlacement) {
  const requested = canonicalPlacement(rawPlacement, "PIN_REQUESTED");
  if (requested.kind !== "kubo") throw new Error("Only Kubo acquisition requires an external actuator");
  const existing = current.placements[requested.kind];
  if (existing && ["PRESENT", "PIN_REQUESTED", "PINNING"].includes(existing.state)) return current;
  if (existing && !samePlacement(existing, requested)) throw new Error("A Placement cannot be reassigned to a different locator");
  if (existing && ["RELEASE_PENDING", "RELEASING"].includes(existing.state)) {
    throw new Error("Placement release is in progress");
  }
  if (!existing) current.placements[requested.kind] = requested;
  else {
    existing.state = "PIN_REQUESTED";
    existing.claim = null;
    existing.error = null;
  }
  return current;
}

export function claimPlacement(current, kind, operation, claimId, now = Date.now()) {
  const placement = current.placements[String(kind || "").toLowerCase()];
  if (!placement) throw new Error("Unknown placement");
  if (!claimId) throw new Error("claimId is required");
  const intent = String(operation || "").toLowerCase();
  const acquire = intent === "acquire";
  const release = intent === "release";
  if (!acquire && !release) throw new Error("Invalid placement operation");
  const claimable = acquire
    ? placement.state === "PIN_REQUESTED"
    : placement.state === "RELEASE_PENDING" || placement.state === "RETRYABLE";
  if (!claimable) throw new Error("Placement is not claimable");
  if (release && current.links.length === 0 && current.state !== "RELEASE_PENDING") {
    throw new Error("Object is not releasable");
  }
  placement.generation += 1;
  const claimedAt = Number(now);
  placement.claim = {
    claimId: String(claimId),
    generation: placement.generation,
    operation: intent,
    claimedAt,
    expiresAt: claimedAt + PLACEMENT_CLAIM_LEASE_MS,
  };
  placement.state = acquire ? "PINNING" : "RELEASING";
  placement.error = null;
  if (release && current.links.length === 0) current.state = "RELEASING";
  return { lifecycle: current, task: taskForPlacement(placement) };
}

// Browser-held capabilities can disappear on reload or network failure. Claims
// therefore have a durable lease: expiry revokes only the actuator claim and
// returns the Placement to a claimable state. It never infers physical state.
export function recoverExpiredPlacementClaims(current, now = Date.now()) {
  let changed = false;
  for (const placement of Object.values(current?.placements || {})) {
    const claim = placement.claim;
    if (!claim || !Number.isFinite(Number(claim.expiresAt)) || Number(claim.expiresAt) > Number(now)) continue;
    if (placement.state === "PINNING" && claim.operation === "acquire") {
      placement.state = "PIN_REQUESTED";
    } else if (placement.state === "RELEASING" && claim.operation === "release") {
      placement.state = "RETRYABLE";
      if (current.links.length === 0) current.state = "RELEASE_PENDING";
    } else {
      continue;
    }
    placement.error = "Placement actuator claim expired";
    placement.claim = null;
    changed = true;
  }
  return changed;
}

function taskForPlacement(placement) {
  return {
    kind: placement.kind,
    executor: placement.executor,
    locator: structuredClone(placement.locator),
    claimId: placement.claim.claimId,
    generation: placement.claim.generation,
    operation: placement.claim.operation,
    claimedAt: placement.claim.claimedAt,
    expiresAt: placement.claim.expiresAt,
  };
}

export function reportPlacement(current, kind, report) {
  const placement = current.placements[String(kind || "").toLowerCase()];
  if (!placement) throw new Error("Unknown placement");
  const claimId = String(report?.claimId || "");
  const generation = Number(report?.generation);
  const outcome = String(report?.outcome || "");
  const operation = String(report?.operation || "");
  const completed = placement.lastCompletedClaim;
  if (completed && completed.claimId === claimId && completed.generation === generation) {
    if (completed.outcome === outcome && completed.operation === operation) return current;
    throw new Error("Contradictory duplicate placement report");
  }
  const claim = placement.claim;
  if (!claim || claim.claimId !== claimId || claim.generation !== generation || claim.operation !== operation) {
    throw new Error("Stale placement claim");
  }
  const expectedState = operation === "acquire" ? "PINNING" : "RELEASING";
  if (placement.state !== expectedState) throw new Error("Placement claim is not active");
  if (outcome === "present" && operation === "acquire") {
    placement.state = "PRESENT";
    placement.error = null;
  } else if (outcome === "released" && operation === "release") {
    placement.state = "RELEASED";
    placement.error = null;
  } else if (outcome === "retryable") {
    placement.state = operation === "acquire" ? "PIN_REQUESTED" : "RETRYABLE";
    placement.error = String(report?.error || "Placement executor failed");
  } else {
    throw new Error("Invalid placement outcome");
  }
  placement.lastCompletedClaim = { claimId, generation, operation, outcome };
  placement.claim = null;
  const allReleased = Object.values(current.placements).every(p => p.state === "RELEASED");
  if (current.links.length === 0) current.state = allReleased ? "RELEASED" : "RELEASE_PENDING";
  else current.state = "ACTIVE";
  return current;
}
