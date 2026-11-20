---
name: cividge-setup
description: Step-by-step setup, security hardening, and optional optimization guide for Cividge (frontend + cividge-kv-worker), prioritized into Minimum Required, Security & Quota Protection, and Optional Enhancements.
---

# Cividge Setup & Hardening Protocol

Use this skill when an agent helps a user deploy, configure, or harden Cividge (`cividge` + `cividge-kv-worker`). Follow phases strictly in order and pause whenever Cloudflare Dashboard actions (WAF rules, R2 CORS, R2 Custom Domain binding) require user confirmation.

> **Sanitization Rule**: Never commit real tokens, KV/account IDs, or personal domains into public repositories or example files. Always substitute placeholders (`example.com`, `your-domain.com`, `your-relay.pages.dev`).

---

## Phase 0: Pre-flight Interview

Before editing configuration or deploying, confirm these three choices with the user:
1. **Storage backend(s)**: Cloudflare R2 only, Filebase (IPFS) only, or **both R2 + Filebase** (recommended for `Auto` Video/Audio→R2 & Other→Filebase routing).
2. **Delivery domain strategy**: Worker Custom Domain (`media.example.com`), static `*.pages.dev` 307 relay (`cloudflare-pages-relay` skill), or multiple domains.
3. **Optional optimizations**: R2 Custom Domain `307` seek offload (`R2_PUBLIC_ORIGINS`), immediate Cloudflare cache purge, and/or home Kubo preservation node (`KUBO_GATEWAY_URL`).

---

## Phase 1: Minimum Required (Get Upload & Delivery Working)

All steps in Phase 1 are mandatory before uploads can succeed.

### 1.1 Prepare `cividge-kv-worker` configuration
1. Copy `wrangler.toml.example` to `wrangler.toml`.
2. Create a Workers KV namespace (`npx wrangler kv namespace create CIVIDGE_KV`) and set its ID under `[[kv_namespaces]]`.
3. Verify Durable Object bindings (`OBJECT_LIFECYCLE` -> `ObjectLifecycleV2`, `LINK_BINDING` -> `LinkBindingV2`) and `[[migrations]]` stay intact.
4. If using R2, create an R2 bucket and set `[[r2_buckets]]` (`binding = "R2_BUCKET"`) and `R2_BUCKET_NAME` under `[vars]`.
5. Set the required admin secret:
   ```bash
   npx wrangler secret put ADMIN_API_TOKEN
   ```

### 1.2 Prepare Storage & CORS
- **If using Cloudflare R2**:
  - Create an S3 API token (Account ID, Access Key ID, Secret Access Key).
  - Configure R2 bucket CORS (Dashboard: **R2 → Bucket → Settings → CORS Policy**) allowing browser-direct `PUT` from the **frontend origin** (e.g. `https://cividge.pages.dev`, NOT the media delivery domain), with methods `GET, HEAD, PUT, POST, DELETE`, `AllowedHeaders: ["*"]`, and `ExposeHeaders: ["ETag", "Content-Length", "Content-Type"]`.
- **If using Filebase (IPFS)**:
  - Create an IPFS bucket and S3 access keys (optionally a bucket-scoped IPFS RPC API key as `FILEBASE_IPFS_API_KEY`).

### 1.3 Configure at least one Public Delivery Domain
Public media `GET` requests on `*.workers.dev` are rejected with `404` by design. Configure at least one public entry point:
- **Worker Custom Domain**: Add `{ pattern = "media.example.com", custom_domain = true }` to `routes` in `wrangler.toml`.
- **Static Pages Relay**: Follow the `cloudflare-pages-relay` skill and register both `STATIC_RELAY_PUBLIC_HOSTS` and `STATIC_RELAY_BACKEND_HOSTS`.

### 1.4 Test & Deploy Worker
```bash
node --test test/*.test.js
npx wrangler deploy
```
Verify:
- `curl -sI https://<worker>.workers.dev/health-check.png` returns `404` (public media blocked on `workers.dev`).
- `curl -sI https://media.example.com/nonexistent.png` reaches the Worker cleanly (`404` rendered by Worker).

### 1.5 Connect Frontend (`cividge`) & Test Upload
Direct the user to open `https://cividge.pages.dev/` (or their own built Pages frontend via `cividge-deploy`) and enter:
1. **KV Delivery & Management Worker**: Worker URL + `ADMIN_API_TOKEN`
2. **R2 and/or Filebase**: Bucket credentials
3. **Delivery domains**: Add the delivery domain(s) configured in 1.3
4. Perform one small test upload and verify playback/image load in a fresh tab.

---

## Phase 2: Security & Quota Protection (Priority Order)

Apply these immediately for any internet-facing deployment to protect free-tier Worker/KV/R2 quotas and limit credential scope.

### Priority 1 — Cloudflare WAF Custom Rules (Block)
1. **Delivery domain scan guard** (Dashboard → Zone → **Security → WAF → Custom rules**):
   Block unapproved paths/methods before they hit Worker/KV:
   ```cloudflare
   http.host eq "media.example.com"
   and not starts_with(http.request.uri.path, "/api/")
   and not starts_with(http.request.uri.path, "/404-character.")
   and not (http.request.uri.path in {"/" "/favicon.ico" "/robots.txt"})
   and (
     not (http.request.uri.path.extension in {"jpg" "jpeg" "png" "webp" "gif" "avif" "jxl" "bmp" "ico" "mp4" "webm" "mov" "m4v" "avi" "ogv" "mp3" "wav" "ogg" "m4a" "flac" "aac" "pdf" "txt" "md" "json" "csv"})
     or not (http.request.method in {"GET" "HEAD"})
   )
   ```
2. **R2 Custom Domain `/objects/` guard** (**Mandatory whenever R2 Custom Domain is enabled**):
   Without this rule, bot scans against `/`, `/.env`, or `/wp-login.php` reach R2 and burn paid/free-tier R2 Class B operations even on 404 responses:
   ```cloudflare
   http.host eq "r2-cdn.example.com"
   and (
     not starts_with(http.request.uri.path, "/objects/")
     or http.request.uri.path eq "/objects/"
     or not (http.request.method in {"GET" "HEAD"})
   )
   ```
   > **Important**: If an existing zone-wide rule matches `http.host contains "example.com"`, place the `r2-cdn.example.com` rule in its own mutually exclusive `or (...)` branch and exclude `r2-cdn.example.com` from the general rule (`and not (http.host eq "r2-cdn.example.com")`) so `/`, `/robots.txt`, and allowed extensions cannot leak through to R2.

### Priority 2 — External Upload Token Separation
Set an upload-only token so external integrations (scripts, Windows SendTo, third-party tools) never receive delete/list privileges (`ADMIN_API_TOKEN`):
```bash
npx wrangler secret put UPLOAD_TOKEN
```

### Priority 3 — Rate Limiting
Configure a Cloudflare Rate Limiting rule on `/r/` or `/api/` (e.g. `30 requests / 10 seconds` per IP → Block).

### Priority 4 — Shared Filebase Bucket Safety
Keep `FILEBASE_DEDICATED_BUCKET = "false"` in `wrangler.toml` unless the Filebase bucket is 100% dedicated to Cividge Worker RPC pins.

---

## Phase 3: Optional Enhancements (Priority Order)

### Priority 1 — R2 Custom Domain Video/Audio `307` Seek Offload (`R2_PUBLIC_ORIGINS`)
Offloads `206 Range` video/audio seeks from Worker/KV directly to an R2 Custom Domain for unauthenticated, non-expiring `objects/<cid>` items while keeping R2→Kubo fallback via `R2_BUCKET.head()`.
1. Ask the user to attach an R2 Custom Domain (e.g. `r2-cdn.example.com`) to their R2 bucket in Cloudflare Dashboard.
2. Confirm the **Priority 1 R2 WAF rule** (`/objects/` + `GET`/`HEAD` only) is active **before** proceeding.
3. Add `R2_PUBLIC_ORIGINS` under `[vars]` in `cividge-kv-worker/wrangler.toml`:
   ```toml
   R2_PUBLIC_ORIGINS = "example.com=https://r2-cdn.example.com"
   ```
   Multiple zones are comma-separated (`example.com=https://r2-cdn.example.com,other-zone.example=https://r2-cdn.other-zone.example`) and matched uniformly against the receiving `requestHost`.
4. Deploy Worker (`npx wrangler deploy`) and verify with `curl`:
   ```bash
   # Expect HTTP 307 Location: https://r2-cdn.example.com/objects/<cid>
   curl -sI -H "Range: bytes=0-99" https://media.example.com/<video.mp4>
   # Expect HTTP 206 Partial Content directly from R2 Custom Domain
   curl -sI -H "Range: bytes=0-99" https://r2-cdn.example.com/objects/<cid>
   ```

### Priority 2 — Dual R2 + Filebase & `Auto` Storage Destination
When both R2 and Filebase are configured in the Cividge frontend, the **Storage destination** selector defaults to **Auto (Video/Audio→R2 / Other→Filebase)** while leaving **Delivery domain** selectable. This pairs R2 seek offload for video/audio with edge-cached Filebase delivery for images/documents to preserve R2 free-tier capacity.

### Priority 3 — Immediate Edge Cache Purge
Set `CLOUDFLARE_ZONE_ID` and secret `CLOUDFLARE_PURGE_TOKEN` so deleted or replaced links purge Cloudflare edge caches immediately.

### Priority 4 — Home Kubo Node + Cloudflare Tunnel (`KUBO_GATEWAY_URL`) + Stealth Mode
1. Expose local Kubo Gateway via Cloudflare Tunnel (e.g. `https://kubo-gw.example.com/ipfs`) with `Gateway.NoFetch: true` and localhost-bound RPC/Gateway (`127.0.0.1`).
2. Set `KUBO_GATEWAY_URL = "https://kubo-gw.example.com/ipfs"` in `wrangler.toml`.
3. Optionally enable client-only stealth P2P settings on Kubo (`Addresses.Swarm: []`, `Swarm.RelayClient.Enabled: false`, `Swarm.DisableNatPortMap: true`, `Routing.Type: "dhtclient"`, `Provide.Strategy: ""`) to avoid exposing the home IP on public IPFS DHTs.

---

## Agent Guardrails
- **Pause on Dashboard Steps**: Never guess whether WAF rules, R2 Custom Domain bindings, or R2 CORS policies were saved—present exact copy-paste snippets and wait for the user's confirmation.
- **No Unapproved Data Mutations**: Never delete KV keys, R2 objects, or run fresh KV cutovers unless explicitly requested.
- **No Public Leaks**: Never put real endpoints, secrets, or personal hostnames into `wrangler.toml.example`, READMEs, tests, or skills.
