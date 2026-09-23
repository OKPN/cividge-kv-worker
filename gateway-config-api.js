import { GATEWAY_CONFIG_KEY, normalizeGatewayConfig, readGatewayConfig } from "./gateway-config.js";

function authorized(request, env) {
  const token = String(env.ADMIN_API_TOKEN || env.API_TOKEN || "").trim();
  const supplied = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return Boolean(token) && supplied === token;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}

export async function handleGatewayConfig(request, env) {
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  if (!env.CIVIDGE_KV) return json({ error: "CIVIDGE_KV binding not configured" }, 503);
  try {
    if (request.method === "GET") return json({ config: await readGatewayConfig(env) });
    if (request.method !== "PUT") return json({ error: "Method Not Allowed" }, 405);
    const config = normalizeGatewayConfig(await request.json());
    await env.CIVIDGE_KV.put(GATEWAY_CONFIG_KEY, JSON.stringify(config));
    return json({ config });
  } catch (error) {
    return json({ error: error.message }, error instanceof SyntaxError || error instanceof TypeError ? 400 : 422);
  }
}
