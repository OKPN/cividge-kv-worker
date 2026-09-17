---
name: cloudflare-pages-relay
description: Create or update a function-free Cloudflare Pages relay with Wrangler, obtain a chosen pages.dev URL, and connect it to a Cividge Filebase/IPFS or R2 delivery origin.
---

# Cloudflare Pages Relay

Use this skill when a user wants a board-facing, disposable `pages.dev` media URL
that redirects to their real Cividge delivery origin (Security-Hardened Step 2),
or wants to create/register such a static Pages relay with Wrangler.

> **Note on Architecture Tiers**:
> - **Tier 1 (Starter / Standalone Pages)**: Users without a custom domain can deploy Cividge directly to Pages with KV binding. Media is served directly by Pages Functions.
> - **Tier 2 (Hardened Static 307 Relay - This Skill)**: Users with a delivery Worker / custom domain use function-free static `_redirects` to spawn disposable `pages.dev` addresses. This decouples the public address from the backend origin, neutralizes query cache-busting attacks, and allows unlimited zero-cost relays.

It is not for deploying the Cividge frontend itself, changing storage credentials, or adding Cloudflare DNS custom domains.

## Preserve the two-layer direction

Do not reverse these roles:

```text
public, pasted URL: https://<chosen-project>.pages.dev/<file>
             307 → backend delivery origin: https://<worker-or-custom-host>/r/<file>
```

For Filebase, the public Pages URL is selected in Cividge's **Filebase delivery
domain** list. The backend host is the IPFS/Filebase compatibility Worker, for
example `ipfs-relay.example.com`. For R2, use the analogous R2 list and an R2
delivery origin. A Pages URL is the public entry, not the backend host.

## Workflow

1. Read [the provider guide](references/cividge-relay.md). Choose **Filebase**
   or **R2**; their redirect templates intentionally differ.
2. Confirm the exact desired Pages project name with the user if it is not
   provided. The name determines the public `https://<project>.pages.dev` URL.
   Do not invent or replace an existing public project without authorization.
3. Copy the matching template to a new, minimal deployment folder and replace
   only its origin placeholder. The folder must contain `_redirects` and no
   `functions/` directory: otherwise media requests can consume Pages Function
   invocations.
4. If deploying a brand new Pages project name, initialize it first:
   `npx wrangler pages project create <project> --production-branch main`
   Then deploy the static folder:
   `npx wrangler pages deploy <folder> --project-name=<project>`
   Treat deploy as an external mutation and obtain the authorization required by
   the active environment before executing it.
5. Verify a real or deliberately harmless test path with `curl.exe -I`. Confirm
   a single 307, the preserved filename path, the intended backend hostname,
   and the expected fixed `/r/` marker (Filebase) or `?r` query (R2).
6. In `cividge-kv-worker/wrangler.toml`, append the new public hostname to
   `STATIC_RELAY_PUBLIC_HOSTS` as a comma-separated list (e.g. `host1.pages.dev,host2.pages.dev`),
   then redeploy the worker (`npx wrangler deploy`). The worker automatically
   searches all configured relay hosts.
7. Only after verification, add/select the resulting Pages URL in Cividge's
   matching delivery-domain control. If UI automation is unavailable, tell the
   user exactly which field receives the public Pages URL. Do not put the
   backend custom domain in that field.

## Cloudflare backend prerequisites

Filebase's backend compatibility host must recognize the public Pages hostname
as an allowed static relay origin. In the Cividge KV Worker, keep
`STATIC_RELAY_PUBLIC_HOSTS` (comma-separated for multiple relays) and
`STATIC_RELAY_BACKEND_HOSTS` aligned with the deployed public and backend hosts.
On the backend custom-domain zone, configure a URL Rewrite Rule to discard
arbitrary query strings while preserving the `/r/` path. That rule is a separate
user-authorized Cloudflare dashboard change.

Do not add a custom domain, WAF rule, rate limit, or cache rule merely because
the relay is being deployed. Those are separate choices.

## Completion report

Report the public Pages URL, backend origin, template type, test redirect
result, and whether the URL was registered in Cividge. State explicitly if a
remaining dashboard configuration requires user action.
