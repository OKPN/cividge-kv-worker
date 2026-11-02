export const IPFS_AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  NOT_FOUND_FROM_CHECKED_GATEWAYS: "NOT_FOUND_FROM_CHECKED_GATEWAYS",
  UNAVAILABLE: "UNAVAILABLE",
});

export function classifyGatewayStatuses(statuses) {
  const values = Array.from(statuses || []);
  if (values.some(status => Number.isInteger(status) && status >= 200 && status < 300)) {
    return IPFS_AVAILABILITY.AVAILABLE;
  }
  if (values.length > 0 && values.every(status => status === 404)) {
    return IPFS_AVAILABILITY.NOT_FOUND_FROM_CHECKED_GATEWAYS;
  }
  return IPFS_AVAILABILITY.UNAVAILABLE;
}

export async function probeGateway(url, cid, fetchImpl = fetch) {
  const target = `${url.replace(/\/$/, "")}/${encodeURIComponent(cid)}`;
  try {
    let response = await fetchImpl(target, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "Cividge-Availability-Probe/1.0" },
    });
    if (response.status === 405 || response.status === 501) {
      response = await fetchImpl(target, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
        headers: { Range: "bytes=0-0", "User-Agent": "Cividge-Availability-Probe/1.0" },
      });
      try { await response.body?.cancel(); } catch { /* best-effort close */ }
    }
    return response.status;
  } catch {
    return null;
  }
}

export async function inspectIpfsAvailability(cid, gateways, fetchImpl = fetch) {
  const statuses = await Promise.all(gateways.map(url => probeGateway(url, cid, fetchImpl)));
  return { status: classifyGatewayStatuses(statuses), checked: gateways.length };
}
