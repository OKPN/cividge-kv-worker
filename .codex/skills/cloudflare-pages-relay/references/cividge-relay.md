# Cividge Pages relay reference

## Architecture Tiers

Cividge supports two deployment modes for `pages.dev` URLs:

1. **Tier 1 (Starter: Standalone Pages with Functions)**
   - Used when you do not have a custom domain or compatibility Worker.
   - Deploy the frontend directly (`npm run build` → `npx wrangler pages deploy dist --project-name=cividge`).
   - Media delivery is handled directly by Pages Functions with an `IPFS_KV` binding.
   - Zero additional infrastructure, but subject to Pages Functions free quota limits and lacks custom zone WAF rules.

2. **Tier 2 (Hardened: Static 307 Relay - Documented Here)**
   - Used when you have a backend compatibility Worker / custom domain.
   - Pages acts strictly as a lightweight, function-free public door issuing 307 redirects.
   - Decouples public URLs from the origin, enables query cache-busting defense on the backend zone, and allows spawning unlimited disposable public addresses at zero invocation cost.

## Roles (Tier 2 Static Relay)

Use a static Pages project as the public URL that is pasted to a board. It
performs a cheap 307 redirect only. The storage delivery Worker or R2 domain
behind it remains the backend; do not paste that backend hostname into
Cividge's public delivery-domain selector when the relay is enabled.

```text
https://<project>.pages.dev/<file>
  → 307
https://<backend>/<marker>/<file>
```

The public project name becomes the Pages hostname. For example,
`--project-name=content-relay` produces `https://content-relay.pages.dev`.
When deploying a new project name, initialize it first with:
`npx wrangler pages project create <project-name> --production-branch main`

## Filebase / IPFS

Start from Cividge's
`compatibility-layer/filebase/_redirects.template`, copying it to an empty
folder as `_redirects`. Replace
`__FILEBASE_COMPATIBILITY_ORIGIN__` with the backend compatibility origin,
without a trailing slash.

The resulting rule must look like:

```text
/* https://ipfs-relay.example.com/r/:splat 307
```

Deploy:

```powershell
npx wrangler pages deploy .\filebase-public-relay --project-name=content-relay
```

Then verify:

```powershell
curl.exe -I "https://content-relay.pages.dev/example.webp?x=random"
```

The Location must use the backend's `/r/example.webp` path. The query-removal
rule belongs on the backend custom-domain zone; it must preserve `/r/`.

In Cividge, add and select `https://content-relay.pages.dev` under **Filebase
delivery domain**. In the KV Worker configuration, add the public hostname to
`STATIC_RELAY_PUBLIC_HOSTS` (comma-separated list, e.g. `host1.pages.dev,host2.pages.dev`)
and the backend hostname to `STATIC_RELAY_BACKEND_HOSTS` when they are not already
present, then redeploy the worker. The worker automatically searches across all
registered relay hosts.

## R2

Start from Cividge's `compatibility-layer/r2/_redirects.template`. Replace
`__R2_COMPATIBILITY_ORIGIN__` with the R2 custom domain or `r2.dev` origin,
without a trailing slash. The resulting rule must look like:

```text
/* https://media.example.com/:splat?r 307
```

The fixed `?r` replaces arbitrary incoming query strings at the static relay.
Deploy and verify the same way, then add and select the public Pages URL under
**R2 delivery domain**.

## Safety checks

- Keep the deployment directory static. A `functions/` directory changes the
  cost and attack surface.
- Never put credentials, KV bindings, or storage tokens in this project.
- Do not deploy over an existing Pages project unless the user named it or
  authorized the replacement.
- Test an actual media path before changing Cividge's selected delivery URL.
- If the user asks to publish, deploy, or alter a Cloudflare dashboard rule,
  obtain authorization at that mutation step.
