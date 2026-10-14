// Public HTTP gateways are retrieval capabilities, never Placements.
export const GATEWAY_CONFIG_KEY = "config:ipfs_gateways";
export const DEFAULT_GATEWAY_CONFIG = Object.freeze({
  mode: "auto",
  selectedUrl: "",
  endpoints: [
    { url: "https://apac.orbitor.dev/ipfs", region: "apac", enabled: true },
    { url: "https://dget.top/ipfs", region: "global", enabled: true },
    { url: "https://ipfs.orbitor.dev/ipfs", region: "na", enabled: true },
    { url: "https://eu.orbitor.dev/ipfs", region: "eu", enabled: true },
    { url: "https://latam.orbitor.dev/ipfs", region: "latam", enabled: true },
  ],
});

const REGIONS = new Set(["global", "apac", "eu", "na", "latam"]);

// Explicit routing coverage: Mexico, Central America, Caribbean countries and
// territories, and South America. This is a selection policy, not geolocation
// or a claim about a Gateway's physical location.
const LATAM_COUNTRIES = new Set([
  "MX", "BZ", "GT", "HN", "SV", "NI", "CR", "PA",
  "AG", "AI", "AW", "BB", "BL", "BQ", "BS", "CU", "CW", "DM", "DO",
  "GD", "GP", "HT", "JM", "KN", "KY", "LC", "MF", "MQ", "MS", "PR",
  "SX", "TC", "TT", "VC", "VG", "VI",
  "AR", "BO", "BR", "CL", "CO", "EC", "FK", "GF", "GY", "PE", "PY", "SR", "UY", "VE",
]);

export function normalizeGatewayConfig(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.endpoints)) throw new Error("Gateway endpoints are required");
  if (input.endpoints.length > 16) throw new Error("Too many Gateway endpoints");
  const seen = new Set();
  const endpoints = input.endpoints.map(raw => {
    const url = new URL(String(raw?.url || "").trim());
    const path = url.pathname.replace(/\/+$/, "");
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash ||
        !path.endsWith("/ipfs") || hostname === "ipfs.filebase.io" ||
        hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") ||
        hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname)) {
      throw new Error("Gateway must be a public HTTPS /ipfs endpoint, separate from Filebase");
    }
    const normalizedUrl = `${url.origin}${path}`;
    if (seen.has(normalizedUrl)) throw new Error("Duplicate Gateway endpoint");
    seen.add(normalizedUrl);
    if (!REGIONS.has(raw.region)) throw new Error("Invalid Gateway region");
    return { url: normalizedUrl, region: raw.region, enabled: raw.enabled !== false };
  });
  const mode = input.mode;
  if (mode !== "auto" && mode !== "manual") throw new Error("Invalid Gateway selection policy");
  const selectedUrl = String(input.selectedUrl || "");
  if (mode === "manual" && !endpoints.some(item => item.enabled && item.url === selectedUrl)) {
    throw new Error("Manual selection requires an enabled Gateway");
  }
  return { mode, selectedUrl: mode === "manual" ? selectedUrl : "", endpoints };
}

export async function readGatewayConfig(env) {
  if (!env.CIVIDGE_KV) throw new Error("CIVIDGE_KV binding not configured");
  const saved = await env.CIVIDGE_KV.get(GATEWAY_CONFIG_KEY, "json");
  return saved ? normalizeGatewayConfig(saved) : normalizeGatewayConfig(DEFAULT_GATEWAY_CONFIG);
}

export function orderPublicGateways(config, continent, country) {
  const enabled = config.endpoints.filter(item => item.enabled);
  if (config.mode === "manual") {
    return [config.selectedUrl, ...enabled.map(item => item.url).filter(url => url !== config.selectedUrl)];
  }
  const region = LATAM_COUNTRIES.has(String(country || "").toUpperCase()) || continent === "SA" ? "latam"
    : continent === "AS" || continent === "OC" ? "apac"
    : continent === "EU" || continent === "AF" ? "eu"
      : continent === "NA" ? "na" : "global";
  return enabled.slice().sort((a, b) => {
    const rank = item => item.region === region ? 0 : item.region === "global" ? 1 : 2;
    return rank(a) - rank(b);
  }).map(item => item.url);
}
