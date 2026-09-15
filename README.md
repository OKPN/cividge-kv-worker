# Cividge KV Worker

High-performance, edge-caching media delivery and metadata registry worker designed for [Cividge](https://github.com/OKPN/cividge). Built on Cloudflare Workers and Workers KV.

## Overview

cividge-kv-worker serves as the decentralized backend routing and caching layer for Cividge. It bridges Cloudflare Pages frontend, distributed IPFS storage (via Filebase), and Cloudflare R2 object storage with zero-egress cost and extreme resilience against high-traffic spikes (e.g. social media viral loops and DDoS).

## Key Features

- ⚡ **3-Tier Edge Caching Strategy**:
  - Browser/Edge response caching (1 hour for images/documents, 4 hours for audio/video).
  - Unpinned / drifting IPFS asset auto-keepalive (7-day cache with automated upstream pinging).
  - Long-term upstream immutable caching (up to 1 year).
- 🤖 **Optimized Social Crawler & OGP Engine**:
  - Automatically intercepts crawlers from Misskey (SummalyBot), Twitter/X, Discord, Slack, Mastodon, and Bluesky.
  - Generates lightweight, instant OGP HTML cards with first-frame thumbnails (.thumb.webp) to completely bypass crawler timeouts and 10MB payload limitations.
- 🎵 **Multi-Media & Range Streaming Support**:
  - Native support for HTTP 206 Partial Content and byte-range requests for audio/video seeking (mp4, webm, mov, mp3, wav, m4a, lac, etc.).
  - Non-media files (PDF, plain text, Markdown, JSON, CSV) served cleanly without corruptive transforms.
- 🔒 **Edge Password Gate**:
  - Secure session-based verification gate using SHA-256 password hashes with zero origin overhead.
- 🪐 **IPFS Multi-Gateway Failover**:
  - Seamlessly falls back across multiple public IPFS gateways (ipfs.filebase.io, cloudflare-ipfs.com, ipfs.io, dweb.link) when primary nodes are congested.
- 🛡️ **Edge Protection**:
  - Immediate 404 caching on delivery-only domains for non-media requests, fully conserving Worker execution quotas.

## Architecture

`
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
`

## Setup & Deployment

### 1. Prerequisites

- Node.js (v18+)
- Cloudflare Account & [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 2. Configuration

Copy the example environment file:

`ash
cp .dev.vars.example .dev.vars
`

Set your secret admin API token in .dev.vars:

`nv
ADMIN_API_TOKEN="your_strong_secret_token_here"
UPLOAD_TOKEN="a_separate_upload_only_token"
FILEBASE_IPFS_API_KEY="your_filebase_bucket_scoped_ipfs_rpc_api_key"
`

Configure your KV namespace in wrangler.toml:

`	oml
name = "cividge-kv-worker"
main = "server.js"
compatibility_date = "2026-09-01"
workers_dev = true

[[kv_namespaces]]
binding = "IPFS_KV"
id = "<your-kv-namespace-id>"

[secrets]
required = ["ADMIN_API_TOKEN"]
`

### 3. Deploy to Production

Set the secret on Cloudflare:

`ash
npx wrangler secret put ADMIN_API_TOKEN
npx wrangler secret put UPLOAD_TOKEN
npx wrangler secret put FILEBASE_IPFS_API_KEY
`

Deploy the Worker:

`ash
npx wrangler deploy
`

### External upload API / Filebase

`POST /api/upload?storage=filebase` uploads to Filebase through its IPFS RPC API and registers the returned CID in `IPFS_KV`. It requires both secrets below:

- `UPLOAD_TOKEN`: the token used only by external upload clients such as the Windows **Send To** batch. Do not reuse `ADMIN_API_TOKEN`.
- `FILEBASE_IPFS_API_KEY`: a bucket-scoped Filebase IPFS RPC API key. This stays in the Worker and must never be placed in a browser, BAT file, or repository.

### Expiring links (no Cron)

Expiry is stored as metadata rather than Cloudflare KV native TTL. On the first request after an expiry, the delivery Worker returns 404, removes only that alias, and checks whether another alias still references the CID. Only the final alias creates the Kubo unpin tombstone; when `FILEBASE_IPFS_API_KEY` is configured, it also requests Filebase to remove the pin. There is no scheduled scan or work while an expired URL remains unvisited.

The client sends `UPLOAD_TOKEN` only as an `Authorization: Bearer` header. Do not place tokens in URL query strings.

## Supported File Extensions

- **Images**: webp, png, jpg, jpeg, gif, jxl, vif, mp, ico
- **Video**: mp4, webm, mov, m4v, vi, ogv
- **Audio**: mp3, wav, ogg, m4a, lac, ac
- **Documents**: pdf, 	xt, md, json, csv

*Note: Executable files and archive formats (zip, 7z, ar, xe, html) are blocked by design for origin defense and security compliance.*

## License

MIT License
