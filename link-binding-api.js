import { parseCanonicalLinkKey } from "./lifecycle-model.js";

// Pre-release semantic cutover: old Link DO records used provider-derived
// ObjectRefs. This routing epoch starts clean without a dual reader. The
// public Link identity remains the unprefixed canonical host:filename.
const LINK_BINDING_EPOCH = "objectid-v1:";

export async function callLinkBinding(env, body) {
  const link = parseCanonicalLinkKey(body.linkKey);
  if (!link || !env.LINK_BINDING) throw new Error("Canonical Link key or LINK_BINDING binding is missing");
  const stub = env.LINK_BINDING.get(env.LINK_BINDING.idFromName(LINK_BINDING_EPOCH + link.key));
  const response = await stub.fetch("https://link-binding.internal/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, linkKey: link.key }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "Link binding operation failed");
    error.code = payload.code || "LIFECYCLE_CONFLICT";
    error.status = response.status;
    error.attempt = payload.attempt;
    throw error;
  }
  return payload;
}

export async function onRequestPost({ request, env }) {
  const token = String(env.ADMIN_API_TOKEN || env.API_TOKEN || "").trim();
  const supplied = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || supplied !== token) return json({ error: "Unauthorized" }, 401);
  try {
    return json(await callLinkBinding(env, await request.json()));
  } catch (error) {
    return json({ error: error.message, code: error.code, attempt: error.attempt }, error.status || 400);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}
