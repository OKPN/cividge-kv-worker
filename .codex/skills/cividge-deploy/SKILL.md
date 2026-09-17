---
name: cividge-deploy
description: Safely pull latest code from GitHub and deploy Cividge frontend (Cloudflare Pages) or backend (Cloudflare KV Worker) with mandatory build and health verification.
---

# Cividge Safe Deployment Protocol

Use this skill when deploying updates from GitHub to Cloudflare for Cividge.
Never deploy without verifying the active branch, clean working tree, and post-deployment health check.

---

## 1. Frontend Deployment (`cividge` - Cloudflare Pages)

The frontend is a Vite SPA. **CRITICAL**: Never deploy the root repository folder directly to Pages; it must be built into `dist/` first.

### Path
`C:\Users\admin1\dev\cividge`

### Safety Rules
- **Do not bypass build**: Always run `npm run build` before deployment.
- **Do not overwrite other projects**: The Pages project name is strictly `cividge`.
- **Target folder**: Deploy `dist`, never `.`.

### Workflow
1. Navigate to directory:
   ```powershell
   cd C:\Users\admin1\dev\cividge
   ```
2. Check branch and pull latest changes:
   ```powershell
   git status
   git pull origin staging # or active branch
   ```
3. Install dependencies if `package.json` changed:
   ```powershell
   npm install
   ```
4. Build the distribution bundle:
   ```powershell
   npm run build
   ```
   *Verify that `dist/index.html` and `dist/assets/` exist without errors.*
5. Deploy to Cloudflare Pages:
   ```powershell
   npx wrangler pages deploy dist --project-name=cividge
   ```
6. Post-deployment verification:
   ```powershell
   curl.exe -I "https://cividge.pages.dev"
   ```
   *Must return `HTTP/1.1 200 OK`.*

---

## 2. Backend Deployment (`cividge-kv-worker` - Cloudflare Workers)

The backend handles KV routing, Ghost Path Shield (404 guard), OGP generation, and IPFS/Filebase delivery.

### Path
`C:\Users\admin1\dev\cividge-kv-worker`

### Safety Rules
- **Syntax check before deploy**: Always run `node --check delivery.js` and `server.js`.
- **Keep relay hosts intact**: Do not overwrite or erase entries in `STATIC_RELAY_PUBLIC_HOSTS` in `wrangler.toml`. Multiple hosts must remain comma-separated.

### Workflow
1. Navigate to directory:
   ```powershell
   cd C:\Users\admin1\dev\cividge-kv-worker
   ```
2. Pull latest changes:
   ```powershell
   git status
   git pull origin main
   ```
3. Verify syntax:
   ```powershell
   node --check delivery.js
   node --check server.js
   ```
4. Deploy to Cloudflare Workers:
   ```powershell
   npx wrangler deploy
   ```
5. Post-deployment verification (Relay & Media health check):
   ```powershell
   curl.exe -I -L "https://content-relay.pages.dev/8b1w9ncx.webp"
   curl.exe -I -L "https://testunko.pages.dev/x7hjsnoh.webp"
   ```
   *Both must return `307 Temporary Redirect` followed by `200 OK`.*

---

## 3. Emergency Rollback Protocol

If a deployment fails, crashes, or returns unexpected 404s/500s:
1. Revert to the last known working git commit:
   ```powershell
   git log -n 5 --oneline
   git reset --hard <working-commit-hash>
   ```
2. Redeploy immediately using the steps above.
3. If Workers/Pages platform rollback is needed, use Cloudflare Dashboard's **Deployments → Rollback**.
