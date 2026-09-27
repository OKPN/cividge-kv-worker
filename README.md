# Cividge KV Worker

High-performance, edge-caching media delivery and metadata registry worker designed for [Cividge](https://github.com/OKPN/cividge). Built on Cloudflare Workers and Workers KV.

## Overview

cividge-kv-worker serves as the decentralized backend routing and caching layer for Cividge. It bridges Cloudflare Pages frontend, distributed IPFS storage (via Filebase), and Cloudflare R2 object storage with zero-egress cost and extreme resilience against high-traffic spikes (e.g. social media viral loops and DDoS).

## Key Features

- ⚡ **3-Tier Edge Caching Strategy**:
  - `BOARD` keeps short public browser/edge freshness: 1 hour for images/documents or 4 hours for audio/video; with zone purge configured, up to 1 day.
  - `PUBLISHED` explicitly allows up to 7 days at the public edge when a managed origin is present. Browser freshness remains at the short baseline. Without Filebase or Kubo preservation, public edge freshness is capped at 1 day.
  - Worker-to-IPFS-gateway fetch caching is separate: up to 1 year normally, 7 days for records marked unpinned, always capped by the Link's remaining lifetime when assigned. An existing cached upstream copy is not proof of a current Placement or protection against IPFS GC.
- 🤖 **Optimized Social Crawler & OGP Engine**:
  - Automatically intercepts crawlers from Misskey (SummalyBot), Twitter/X, Discord, Slack, Mastodon, and Bluesky.
  - Generates lightweight, instant OGP HTML cards with first-frame thumbnails (.thumb.webp) to completely bypass crawler timeouts and 10MB payload limitations.
- 🎵 **Multi-Media & Range Streaming Support**:
  - Native support for HTTP 206 Partial Content and byte-range requests for audio/video seeking (mp4, webm, mov, mp3, wav, m4a, flac, etc.).
  - Non-media files (PDF, plain text, Markdown, JSON, CSV) served cleanly without corruptive transforms.
- 🔒 **Edge Password Gate**:
  - Secure session-based verification gate using SHA-256 password hashes with zero origin overhead.
- 🪐 **IPFS Multi-Gateway Failover**:
  - Public HTTP Gateway peers are selected by the delivery Worker's viewer-continent policy or an administrator's manual choice, then tried in order. Filebase's provider gateway remains a separate origin candidate.
  - The frontend offers a built-in candidate catalog; the authenticated `GET/PUT /api/gateway-config` stores the actual runtime setting in `CIVIDGE_KV` (`config:ipfs_gateways`). KV propagation between regions is eventual.
- 🛡️ **Edge Protection**:
  - Immediate 404 caching on delivery-only domains for non-media requests, fully conserving Worker execution quotas.

## Architecture

```text
User / Social Bot (Misskey, Twitter, Discord)
               │
               ▼
   [ Cloudflare Edge Node ]
      ├── Is Social Bot?  ──────► Return Instant Lightweight OGP HTML (with thumb)
      ├── In Edge Cache?  ──────► Serve 200/206 directly (0 ms origin cost)
      ├── Has Password?   ──────► Render Form / Verify HMAC Session Cookie
      └── Cache Miss
               │
               ▼
     [ Workers KV Lookup ]
      ├── Direct Blob in KV? ───► Stream ArrayBuffer directly
      └── Lookup CID / S3Key
               │
               ▼
   [ Filebase IPFS / R2 Origin ] (Populates edge cache & returns byte stream)
```

## Setup & Deployment

### 🤖 For AI Coding Agents (Codex, Claude, etc.)

This repository includes official agent skills in [`.codex/skills/`](.codex/skills/) to automate safe deployments and public relay configuration without breaking routes:

- **`cividge-deploy`**: Validates syntax, preserves multi-relay host lists in `wrangler.toml`, deploys the Worker, and runs automated curl health checks.
- **`cloudflare-pages-relay`**: Generates function-free, disposable `pages.dev` 307 relays and registers them into `STATIC_RELAY_PUBLIC_HOSTS` cleanly.

### 1. Prerequisites

- Node.js (v18+)
- Cloudflare Account & [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 2. Configuration

Copy the example environment file:

```bash
cp .dev.vars.example .dev.vars
```

Set your secret admin API token in .dev.vars:

```env
ADMIN_API_TOKEN="your_strong_secret_token_here"
UPLOAD_TOKEN="a_separate_upload_only_token"
TEST_UPLOAD_TOKEN="optional_test_upload_only_token"
FILEBASE_IPFS_API_KEY="your_filebase_bucket_scoped_ipfs_rpc_api_key"
```

Configure your KV namespace in wrangler.toml:

```toml
name = "cividge-kv-worker"
main = "server.js"
compatibility_date = "2026-09-01"
workers_dev = true

[[kv_namespaces]]
binding = "CIVIDGE_KV"
id = "<your-kv-namespace-id>"

[secrets]
required = ["ADMIN_API_TOKEN"]
```

### Fresh KV reset / clean semantic cutover

When the domain schema or delivery projection changes substantially and old
test data need not be retained, create a **new, empty** KV namespace and switch
the Worker's `CIVIDGE_KV` binding to its ID. Do not copy keys, metadata, or
values from the old namespace. Deploy and verify read/write through the new
binding **before** deleting the old namespace. This is a clean baseline, not a
repair or migration of the old schema.

KV holds the delivery projection and runtime configuration, not Object
lifecycle authority. The reset removes old Link/host/metadata/generation/
`kuboStatus` projections and helps distinguish legacy ghost state from a bug
in the current implementation. Any ghost state generated after a clean reset
is more likely to come from current Cividge behavior. Old records have no
compatibility guarantee.

The reset also removes KV-stored configuration such as
`config:ipfs_gateways`. Until the administrator saves a new GatewayConfig,
the Worker uses its built-in gateway defaults. Resetting KV **does not**
delete or recreate Durable Objects, R2 objects, Filebase pins, or Kubo pins;
their authoritative/physical state remains. Existing public Links will not
be delivered from an empty KV until current Cividge explicitly projects them
again. Do not infer that a missing KV Link authorizes physical deletion.
Existing Durable Object Link bindings can still affect reuse or later
reprojection of the same identity. Edge-cached responses can also remain
visible until their cache lifetime ends; neither is erased by a KV reset.

### Fresh lifecycle authority cutover

When all existing Links and managed Objects are disposable, a clean cutover
also requires **new SQLite-backed namespaces for both ObjectLifecycle and
LinkBinding**. Keep the canonical ObjectRef and `host:filename` derivation;
point their existing binding names at newly created classes, not at renamed
classes (a class rename carries the old data). Pair this with an empty
`CIVIDGE_KV` namespace and a new browser managed-list cache generation.
Do not copy old DO or KV records. The current lifecycle schema starts at
version 2 and has `pendingLinkRemovals: []`; no version-1 repair path is used.

This discards old public Link authority and projection, so old URLs are not
preserved. It does **not** delete R2 objects, Filebase pins, Kubo pins, or
browser credentials. Physical files left in the same bucket can still appear
as local/unmanaged storage observations; they are not restored as Links.
GatewayConfig in the discarded KV returns to built-in defaults until saved
again. The delivery Cache API key is epoch-scoped so cached responses from the
previous authority are not reused; independent CDN/browser caches may have
their own lifetime. Verify the new read/write path before retiring the old
namespaces. The old physical files need separate, explicit maintenance if
their storage space should be reclaimed.

The 2026-09-27 clean cutover used new `ObjectLifecycleV2` and `LinkBindingV2`
SQLite namespaces and an empty delivery KV. After the new Worker and Pages
were live and the new KV was checked, the unused `ObjectLifecycle` and
`LinkBinding` classes were retired with a delete migration and the previous
KV namespace was removed. This did not act on provider storage.

### 3. Deploy to Production

Set the secret on Cloudflare:

```bash
npx wrangler secret put ADMIN_API_TOKEN
npx wrangler secret put UPLOAD_TOKEN
npx wrangler secret put TEST_UPLOAD_TOKEN
npx wrangler secret put FILEBASE_IPFS_API_KEY
```

Deploy the Worker:

```bash
npx wrangler deploy
```

## Public delivery hardening

This section is optional for a private setup, but recommended when public media
URLs may be posted to boards, chat services, or social platforms. It keeps a
stable `pages.dev` URL as the public entry while making the Worker domain a
small, controlled backend surface.

### 1. Use a static Pages relay as the public URL

Deploy the function-free Filebase relay template from the main
[Cividge repository](https://github.com/OKPN/cividge/tree/main/compatibility-layer/filebase).
It should redirect the public path to a compatibility Worker domain using the
internal `/r/` prefix:

```text
/* https://media.example.com/r/:splat 307
```

The public URL users share stays clean:

```text
https://your-public-relay.pages.dev/example.mp4
```

The redirect destination is only an implementation detail:

```text
https://media.example.com/r/your-public-relay/example.mp4
```

In `wrangler.toml`, allow the public Pages hostname so the Worker can resolve
the correct delivery-domain registry entry:

```toml
[vars]
STATIC_RELAY_PUBLIC_HOSTS = "your-public-relay.pages.dev"
```

`workers.dev` remains useful as an API endpoint for the Cividge client, but
this Worker intentionally rejects media delivery through `workers.dev`.

### 2. Normalize query strings at the compatibility domain

In the Cloudflare zone that owns `media.example.com`, create a **URL Rewrite
Rule**:

- Match: `http.host eq "media.example.com"`
- Path: **Preserve**
- Query: rewrite to an empty static value

This makes `example.webp?x=1` and `example.webp?x=random` reach the same
backend cache key. The `/r/` marker stays in the path, so the Worker still
recognizes a request that came through the approved public relay.

### 3. Bound unique-path traffic

In **Security → Security rules → Rate limiting rules**, add a rule for paths
starting with `/r/`:

- Counting characteristic: IP address
- Threshold: **30 requests per 10 seconds**
- Action: **Block**
- Mitigation timeout: **10 seconds**

On Cloudflare Free, rate-limit expressions are path-focused and only one rule
is available. Reserving `/r/` for this relay prevents the rule from affecting
unrelated services in the same zone.

### 4. Optional strict backend-only mode

After confirming that no legacy direct links to `media.example.com/<file>` need
to remain public, add a **Custom WAF Rule** with the **Block** action:

```cf
http.host eq "media.example.com"
and not starts_with(http.request.uri.path, "/r/")
and not starts_with(http.request.uri.path, "/api/")
```

This rejects arbitrary direct paths before the Worker runs while preserving the
relay path and authenticated API routes.

### What this protects

- Query-string variants of the same public file converge on one cached object.
- Repeated requests for the same missing path receive a short-lived cached 404.
- Unregistered media names return 404 without probing Filebase, IPFS gateways,
  or Kubo.
- Rate limiting bounds repeated unique `/r/` paths from one source IP.

This does not make an already-public CID secret, prevent a recipient from
redistributing a downloaded file, or fully stop a distributed botnet. Those are
properties of public content distribution rather than the Worker routing layer.

### External upload API / Filebase

`POST /api/upload?storage=filebase` uploads to Filebase through its IPFS RPC API and registers the returned CID in `CIVIDGE_KV`. It accepts `UPLOAD_TOKEN` or the optional `TEST_UPLOAD_TOKEN` (never `ADMIN_API_TOKEN`) and requires the secrets below:

- `UPLOAD_TOKEN`: the token used only by external upload clients such as the Windows **Send To** batch. Do not reuse `ADMIN_API_TOKEN`. The generated batch contains this token in plain text: never share, commit, or place it in a shared folder; rotate the secret immediately if it leaks.
- `TEST_UPLOAD_TOKEN`: an optional second upload-only credential for a test client. It has the same upload capability as `UPLOAD_TOKEN`; use a separate Worker and storage bindings when the test uploads must be isolated from production.
- `FILEBASE_IPFS_API_KEY`: a bucket-scoped Filebase IPFS RPC API key. This stays in the Worker and must never be placed in a browser, BAT file, or repository.
- `FILEBASE_DEDICATED_BUCKET=true` is required for Worker-managed Filebase RPC acquisition and physical unpin. The bucket selected by `FILEBASE_IPFS_API_KEY` **must be dedicated to Cividge Worker RPC placements**: do not mix browser/S3 uploads, external tools, or other applications' pins in that bucket. This is the ownership boundary (`Filebase bucket = Cividge-managed RPC Placement namespace`), not a performance preference. The default is `false`; without explicit confirmation the Worker neither acquires this Placement nor calls `pin/rm`.
- If Filebase `/add` returns a CID different from the preflight CID, the Worker stops before Link publication, records the observed CID in the unfinished Link attempt, and requires manual bucket inspection. It never automatically calls CID-wide `pin/rm` for that unexpected CID.

`[INV-FILEBASE-RPC-RELEASE-AUTHORITY]` ObjectLifecycle alone authorizes physical release. The Worker calls Filebase `pin/rm` only after claiming that authorized release, and reports success or a retryable failure back to ObjectLifecycle. A lost response is checked with read-only `pin/ls` before treating the pin as absent.

`[INV-FILEBASE-RPC-ACTUATOR-SCOPE]` The Worker actuates only a durable `filebase_rpc` Placement with `cividge_worker_rpc` provenance and a valid CID. Browser/S3 `filebase` Placements and pins owned outside the exclusive RPC bucket never become Worker cleanup tasks. Browser S3 credentials remain in the browser.

### Expiring links (no Cron)

Expiry is stored as Link metadata rather than Cloudflare KV native TTL. A
public GET performs one canonical `host:filename` lookup and returns 404 when
that Link is expired. GET never deletes KV records, repairs state, probes
storage, creates tombstones, or performs physical cleanup.

Link removal and expiry collection are lifecycle mutations. They must pass
through the ObjectRef-named Durable Object, remove only the selected delivery
projection, and leave every peer Link and Placement intact. An Object becomes
release-eligible only after the authoritative Link set and pending-removal set
are both empty. R2/Filebase/Kubo cleanup then uses generation-bound Placement
claims so a stale or duplicated executor cannot authorize deletion.

The client sends its upload token only as an `Authorization: Bearer` header. Do not place tokens in URL query strings.

The generated Windows **Send To** batch uses a raw-body upload (`X-Upload-Filename` plus `--data-binary`). Browser, raw-body, and multipart uploads share one decimal **80 MB (80,000,000 bytes)** limit. The Worker buffers the complete body to determine content identity and check the canonical Link before physical storage mutation.

## Supported File Extensions

- **Images**: webp, png, jpg, jpeg, gif, jxl, avif, bmp, ico
- **Video**: mp4, webm, mov, m4v, avi, ogv
- **Audio**: mp3, wav, ogg, m4a, flac, aac
- **Documents**: pdf, txt, md, json, csv

*Note: Executable files and archive formats (zip, 7z, rar, exe, html) are blocked by design for origin defense and security compliance.*

## License

MIT License
