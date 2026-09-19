---
name: cloudflare-repo-sanitization
description: Sanitize and harden Cloudflare Workers and Pages repositories for safe public (open-source) release, including secret migration, token rotation to neutralize git history leaks, and creating clean template configurations.
---

# Cloudflare Repo Sanitization & Publicization Guide

This skill provides step-by-step procedures to sanitize Cloudflare Workers and Pages projects so they can be safely published as open-source (Public) repositories on GitHub without leaking credentials, tokens, or private resources.

---

## 1. The Core Threat: Git History Leakage

> [!CAUTION]
> Simply editing `wrangler.toml` or code to remove tokens and committing the change **DOES NOT** protect you.
> Anyone can inspect past commits (`git log -p`) on GitHub and retrieve the deleted credentials.

To achieve 100% security without complex git history rewriting, use **Token Rotation (Neutralization)**:
1. Generate **brand-new random tokens**.
2. Upload the new tokens to **Cloudflare Secrets** (`wrangler secret put`).
3. The old tokens recorded in git history become **useless garbage**, completely neutralizing the leak.

---

## 2. Standard Workflow

### Step 1: Identify Secrets & Credentials
Scan the codebase for credentials that must NOT be exposed:
- `ADMIN_API_TOKEN` / `UPLOAD_TOKEN` / `API_TOKEN`
- S3 / R2 Access & Secret Keys
- Third-party API keys (e.g. `FILEBASE_IPFS_API_KEY`)
- Webhook URLs (Discord, Slack, etc.)

```bash
# Example check command
git grep -i "token"
git grep -i "secret"
```

### Step 2: Generate Cryptographically Secure New Tokens
Never use human-typed passwords for API secrets. Generate 64-character hex strings:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 3: Remove Plaintext Vars & Move to Cloudflare Secrets

1. **Remove from `wrangler.toml`**:
   Delete secret keys from the `[vars]` block in `wrangler.toml`.
   *Note: Cloudflare rejects creating a secret if an identical name exists under `[vars]`. Deploy once or remove them first.*

2. **Deploy to clear plaintext vars from Cloudflare**:
   ```bash
   npx wrangler deploy
   ```

3. **Register secrets in Cloudflare**:
   ```bash
   echo "<NEW_TOKEN>" | npx wrangler secret put <SECRET_NAME>
   ```

4. **Verify active secrets**:
   ```bash
   npx wrangler secret list
   ```

### Step 4: Create Public Template (`wrangler.toml.example`)
Create a sanitized copy for public users:
- Replace private domain names with `your-domain.com`.
- Replace KV IDs with `your_kv_namespace_id`.
- Replace R2 bucket names with `your-bucket-name`.
- Document required secrets in comments.

### Step 5: Verify Verification & Invariants
1. Test API with new token: Ensure `200 OK`.
2. Test API with old token: Ensure `401 Unauthorized`.
3. Check working tree: Ensure clean git status.

---

## 3. Checklist Before Making Repository Public

- [ ] All sensitive tokens moved to Cloudflare Secrets (`wrangler secret list` confirms).
- [ ] New tokens rotated so historical git commits only contain invalid tokens.
- [ ] `wrangler.toml` contains zero plaintext passwords/tokens.
- [ ] `wrangler.toml.example` is provided for OSS users.
- [ ] `.gitignore` excludes `.env`, `*.local`, and credentials.
- [ ] API routes return `401` when probed with old credentials.
