import { inspectIpfsAvailability } from "./ipfs-availability.js";
import { orderPublicGateways, readGatewayConfig } from "./gateway-config.js";

const CID_PATTERN = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;
const FILEBASE_GATEWAY = "https://ipfs.filebase.io/ipfs";
// Bound worst-case subrequests: five CIDs x four gateways x (HEAD + Range fallback).
const MAX_CIDS_PER_REQUEST = 5;
const MAX_GATEWAYS_PER_CID = 4;

function authorized(request, env) {
  const expected = String(env.ADMIN_API_TOKEN || env.API_TOKEN || "").trim();
  const supplied = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return Boolean(expected) && supplied === expected;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}

export async function handleIpfsAvailability(request, env) {
  if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  if (!env.CIVIDGE_KV) return json({ error: "CIVIDGE_KV binding not configured" }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const cids = Array.isArray(body?.cids) ? [...new Set(body.cids)] : null;
  if (!cids || cids.length < 1 || cids.length > MAX_CIDS_PER_REQUEST || cids.some(cid => typeof cid !== "string" || !CID_PATTERN.test(cid))) {
    return json({ error: `Provide 1 to ${MAX_CIDS_PER_REQUEST} valid IPFS CIDs` }, 400);
  }
  try {
    const config = await readGatewayConfig(env);
    const publicGateways = orderPublicGateways(config, request.cf?.continent, request.cf?.country);
    const customKuboGateway = String(env.KUBO_GATEWAY_URL || "").trim().replace(/\/$/, "");
    const gateways = [...new Set([...(customKuboGateway ? [customKuboGateway] : []), FILEBASE_GATEWAY, ...publicGateways])]
      .slice(0, MAX_GATEWAYS_PER_CID);
    const results = {};
    for (const cid of cids) {
      results[cid] = await inspectIpfsAvailability(cid, gateways);
    }
    return json({ results, checkedGateways: gateways.length });
  } catch {
    return json({ error: "Gateway availability could not be checked" }, 503);
  }
}
