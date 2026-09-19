---
name: cloudflare-custom-domain
description: >-
  Register, configure, verify, and troubleshoot custom domains for Cloudflare Workers
  (e.g., cividge-kv-worker) and Cloudflare Pages. Use this skill whenever adding a new
  domain, setting up Custom Domains in wrangler.toml, mapping delivery domains, or fixing
  DNS/routing issues (ENOTFOUND, 404, SSL) on custom domains.
---

# Cloudflare 独自ドメイン登録・設定ガイド

Cloudflare Workers（`cividge-kv-worker` 等）および Cloudflare Pages において、独自ドメイン・サブドメイン（例: `kv.k7m.f5.si`, `misskey-media.okpn.f5.si`）を追加・開通・診断するための標準手順書です。

---

## 1. Cloudflare Workers にカスタムドメインを追加する手順

### Step 1: `wrangler.toml` の `routes` にドメインを追加
`cividge-kv-worker/wrangler.toml` の `routes` 配列に、`custom_domain = true` を指定して新しいドメインを追加します。

```toml
routes = [
  { pattern = "kv.k7m.f5.si", custom_domain = true },
  { pattern = "misskey-media.okpn.f5.si", custom_domain = true },
  { pattern = "ipfs-relay.k7m.f5.si", custom_domain = true },
  { pattern = "relay.k7m.f5.si", custom_domain = true }
]
```

> **注意**: 対象ドメインの親ゾーン（例: `f5.si` や `k7m.f5.si`）が同じ Cloudflare アカウントに登録されている必要があります。

### Step 2: デプロイを実行
Worker ディレクトリで以下を実行します：

```bash
npx wrangler deploy
```

出力結果に以下のように表示されれば、Cloudflare 側での Custom Domain 登録・DNS レコード生成・SSL 証明書の発行が自動開始されます：
```text
Deployed cividge-kv-worker triggers:
  https://cividge-kv-worker.okpn.workers.dev
  kv.k7m.f5.si (custom domain)
```

### Step 3: DNS 浸透と接続テスト
Cloudflare の 1.1.1.1 DNS リゾルバを用いて DNS レコードが生成されたか確認します：

```bash
node -e "
const dns = require('dns');
const resolver = new dns.Resolver();
resolver.setServers(['1.1.1.1']);
resolver.resolve4('kv.k7m.f5.si', (err, addrs) => console.log(err ? err.code : addrs));
"
```

ローカル環境の DNS キャッシュをクリアして疎通確認：
```bash
ipconfig /flushdns
node -e "fetch('https://kv.k7m.f5.si/x7hjsnoh.webp').then(r => console.log(r.status))"
```

---

## 2. Cividge 配信システムとの整合性チェック

Worker に独自ドメインを通すだけでなく、Cividge のメディア配信システム（KV 台帳・静的リレー）と整合させる必要があります。

### ① KV 台帳（CIVIDGE_KV）のドメイン別キー
Cividge では、ドメイン制限や名前空間を分離するため、KV のキー名に `<domain>:<filename>` 形式が用いられます。
- 例: `kv.k7m.f5.si:x7hjsnoh.webp`
- メタデータ: `allowedHost` または `d` に対象ドメインが指定されている場合、そのドメイン以外からのリクエストはエッジで 404 遮断されます。

### ② 静的 Pages 互換リレー（STATIC_RELAY）の設定
もし静的 Pages 入口（例: `content-relay.pages.dev`）の後段として独自ドメイン Worker を使う場合、`wrangler.toml` の `[vars]` も確認します：
- `STATIC_RELAY_PUBLIC_HOSTS`: 許可する Pages 入口ホスト名一覧
- `STATIC_RELAY_BACKEND_HOSTS`: リレー先の背後 Worker ホスト名一覧

---

## 3. よくあるエラーと対処法

| 現象 / エラー | 原因 | 対処法 |
| :--- | :--- | :--- |
| `ENOTFOUND` / `getaddrinfo` | DNS レコードが存在しない | `wrangler.toml` の `routes` に登録して `npx wrangler deploy` を実行する |
| `Status: 404 (Not Found)` | KV 台帳に対象ファイルのレコードがない、または `allowedHost` 不一致 | 対象ドメイン用の KV レコードが存在するか確認（`wrangler kv key list --remote`） |
| `SSL Handshake Failed` | 証明書の発行待ち（通常数分以内） | 1.1.1.1 経由で DNS 反映を確認後、ブラウザをリロードする |
| 以前のファイルが消えた | 有効期限（TTL）切れまたは KV レコード未同期 | R2 に実体があるか `wrangler r2 object get` で確認し、必要に応じて KV レコードを再登録 |
