// Canonical identity of exact, final immutable bytes. Storage locators and
// UnixFS CIDs are capabilities/metadata, never Object identity.
export function parseObjectId(value) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(value || ""));
  return match ? { objectRef: match[0], digest: match[1] } : null;
}

export async function objectIdFromBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
