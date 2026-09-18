// functions/_middleware.js
// Cloudflare Pages Function Middleware: 静的ファイル 404 / SPA フォールバック時のスマート中継 (Catbox風ハイブリッド404 & パスワード保護ゲート)

import { CHARACTER_WEBP_BASE64 } from "./character_image.js";

let characterWebpBytes = null;
function getCharacterWebpBytes() {
  if (!characterWebpBytes) {
    const binStr = atob(CHARACTER_WEBP_BASE64);
    const len = binStr.length;
    characterWebpBytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      characterWebpBytes[i] = binStr.charCodeAt(i);
    }
  }
  return characterWebpBytes;
}

const CATBOX_404_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - File Not Found</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #f7f7f8;
      background-image: 
        repeating-linear-gradient(45deg, rgba(0, 0, 0, 0.02) 0, rgba(0, 0, 0, 0.02) 1px, transparent 0, transparent 8px),
        repeating-linear-gradient(-45deg, rgba(0, 0, 0, 0.02) 0, rgba(0, 0, 0, 0.02) 1px, transparent 0, transparent 8px);
      color: #222;
      text-align: center;
      padding: 24px 16px;
    }
    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      max-width: 480px;
      width: 100%;
    }
    .error-code {
      font-size: 76px;
      font-weight: 700;
      color: #2b2e35;
      line-height: 1;
      letter-spacing: 2px;
      margin-bottom: 2px;
    }
    .question-mark {
      font-size: 28px;
      font-weight: 800;
      color: #00bcd4;
      line-height: 1;
      margin-bottom: 12px;
      user-select: none;
    }
    .character-img {
      display: block;
      width: 100%;
      max-width: 260px;
      height: auto;
      object-fit: contain;
      margin: 0 auto 20px auto;
      user-select: none;
      -webkit-user-drag: none;
    }
    .message {
      font-size: 15px;
      font-weight: 600;
      color: #2b2b2b;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .home-link {
      display: inline-block;
      padding: 7px 32px;
      border: 1.5px solid #2f7584;
      border-radius: 9999px;
      color: #4a3e7a;
      text-decoration: underline;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s ease;
      background: transparent;
    }
    .home-link:hover {
      background: rgba(47, 117, 132, 0.08);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-code">404</div>
    <div class="question-mark">?</div>
    <img class="character-img" src="/404-character.webp" alt="404 Not Found" onerror="this.onerror=null; this.src='data:image/webp;base64,${CHARACTER_WEBP_BASE64}';">
    <div class="message">The file you're looking for doesn't exist<br>or has been removed.</div>
    <a href="/" class="home-link">Click me to go home</a>
  </div>
</body>
</html>`;

const CATBOX_404_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
  <rect width="100%" height="100%" fill="#f7f7f8"/>
  <rect width="96%" height="94%" x="2%" y="3%" fill="none" stroke="#cbd5e1" stroke-width="2" stroke-dasharray="6 4" rx="8"/>
  <text x="50%" y="36%" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="56" font-weight="700" fill="#2b2e35" text-anchor="middle" letter-spacing="2">404</text>
  <text x="50%" y="50%" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="24" font-weight="800" fill="#00bcd4" text-anchor="middle">?</text>
  <!-- 猫耳シルエット -->
  <path d="M 182 188 Q 186 166 193 176 Q 200 171 207 176 Q 214 166 218 188 Z" fill="#2b2e35"/>
  <circle cx="194" cy="195" r="2.5" fill="#00bcd4"/>
  <circle cx="206" cy="195" r="2.5" fill="#00bcd4"/>
  <text x="50%" y="82%" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13" font-weight="600" fill="#64748b" text-anchor="middle">FILE NOT FOUND OR REMOVED</text>
</svg>`;

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    if (parts.length >= 2) {
      list[parts.shift().trim()] = decodeURIComponent(parts.join("=").trim());
    }
  });
  return list;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(value).length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function getSessionKey(meta) {
  // passwordHash は KV 内だけに保持する。旧レコードは平文パスワードから一時的に導出する。
  const material = meta?.passwordHash || (meta?.password ? `legacy:${meta.password}` : "");
  if (!material) return null;
  return crypto.subtle.importKey("raw", new TextEncoder().encode(material), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function createSessionToken(filename, meta) {
  const key = await getSessionKey(meta);
  if (!key) return null;
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ f: filename, e: Math.floor(Date.now() / 1000) + 3600 })));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifySessionToken(token, filename, meta) {
  if (!token) return false;
  const [payload, signature] = String(token).split(".");
  if (!payload || !signature) return false;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (decoded.f !== filename || !Number.isFinite(decoded.e) || decoded.e <= Math.floor(Date.now() / 1000)) return false;
    const key = await getSessionKey(meta);
    return Boolean(key) && await crypto.subtle.verify("HMAC", key, base64UrlDecode(signature), new TextEncoder().encode(payload));
  } catch (_) {
    return false;
  }
}

async function verifyPassword(inputPassword, meta) {
  if (!inputPassword || !meta) return false;
  if (meta.password && inputPassword === meta.password) return true;

  if (meta.passwordHash && meta.passwordSalt) {
    try {
      const saltBytes = new Uint8Array(meta.passwordSalt.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(inputPassword),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
      );
      const derivedBits = await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt: saltBytes,
          iterations: 100000,
          hash: "SHA-256",
        },
        keyMaterial,
        256
      );
      const hashHex = Array.from(new Uint8Array(derivedBits))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
      return hashHex === meta.passwordHash;
    } catch (e) {
      return false;
    }
  }
  return false;
}

function renderPasswordForm(filename, errorMsg = "") {
  const safeFilename = escapeHtml(filename);
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>保護されたファイル - Access Restricted</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #121316;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: #1e2025;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 32px 24px;
      width: 100%;
      max-width: 400px;
      text-align: center;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    .icon { font-size: 48px; margin-bottom: 12px; }
    h1 { font-size: 18px; margin-bottom: 8px; color: #ffffff; }
    .filename {
      font-size: 13px;
      color: #38bdf8;
      word-break: break-all;
      margin-bottom: 16px;
      font-family: monospace;
      background: rgba(56, 189, 248, 0.1);
      padding: 4px 8px;
      border-radius: 6px;
      display: inline-block;
    }
    p { font-size: 13px; color: #94a3b8; margin-bottom: 24px; line-height: 1.5; }
    input[type="password"] {
      width: 100%;
      height: 44px;
      background: #121316;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      color: #ffffff;
      padding: 0 16px;
      font-size: 16px;
      outline: none;
      margin-bottom: 12px;
      text-align: center;
      letter-spacing: 2px;
    }
    input[type="password"]:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2); }
    button {
      width: 100%;
      height: 44px;
      background: #6366f1;
      color: #ffffff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: bold;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #4f46e5; }
    .error {
      color: #f43f5e;
      font-size: 13px;
      margin-top: 14px;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <h1>保護されたファイル</h1>
    <div class="filename">${safeFilename}</div>
    <p>このファイルを閲覧するには合言葉（パスワード）が必要です。</p>
    <form method="POST" action="">
      <input type="password" name="pwd" placeholder="🔑 合言葉を入力" autofocus required autocomplete="off">
      <button type="submit">閲覧する</button>
    </form>
    ${errorMsg ? `<div class="error">⚠️ ${errorMsg}</div>` : ""}
  </div>
</body>
</html>`;
}

// 🤖 SNSクローラー（Misskey / SummalyBot, Twitter, Discord, Slack 等）の判定
function isSocialCrawler(userAgent = "") {
  const ua = userAgent.toLowerCase();
  return (
    ua.includes("summalybot") ||
    ua.includes("misskey") ||
    ua.includes("twitterbot") ||
    ua.includes("discordbot") ||
    ua.includes("telegrambot") ||
    ua.includes("facebookexternalhit") ||
    ua.includes("slackbot") ||
    ua.includes("bluesky") ||
    ua.includes("mastodon")
  );
}

// 🖼️ SNSクローラー向け軽量 OGP HTML レスポンス生成（大容量バイナリ取得によるプレビュー失敗を完全防止）
function renderOgpHtml(filename, rawUrl, ext, isVideo, origin, thumbnailKey = null) {
  const title = `${filename}`;
  const siteName = "Cividge Media";
  // 動画の場合は同名先頭フレームサムネイル（.thumb.webp）を最優先指定
  const videoThumbUrl = `${origin}/${encodeURIComponent(thumbnailKey || `${filename}.thumb.webp`)}`;
  const mediaUrl = rawUrl;
  const thumbUrl = isVideo ? videoThumbUrl : mediaUrl;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${title}">
  <meta property="og:site_name" content="${siteName}">
  <meta property="og:url" content="${mediaUrl}">
  <meta property="og:image" content="${thumbUrl}">
  <meta property="og:image:secure_url" content="${thumbUrl}">
  ${isVideo ? `
  <meta property="og:type" content="video.other">
  <meta property="og:video" content="${mediaUrl}">
  <meta property="og:video:secure_url" content="${mediaUrl}">
  <meta property="og:video:type" content="video/${ext === "webm" ? "webm" : "mp4"}">
  <meta name="twitter:card" content="player">
  <meta name="twitter:image" content="${thumbUrl}">
  <meta name="twitter:player" content="${mediaUrl}">
  ` : `
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${thumbUrl}">
  `}
</head>
<body style="margin:0;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;">
  ${isVideo ? `
  <video src="${mediaUrl}" poster="${thumbUrl}" controls autoplay playsinline style="max-width:100%;max-height:100vh;"></video>
  ` : `
  <img src="${mediaUrl}" alt="${title}" style="max-width:100%;max-height:100vh;object-fit:contain;">
  `}
</body>
</html>`;
}

function renderNotFoundResponse(request, cdnCacheSeconds = 60) {
  const accept = request.headers.get("accept") || "";
  const headers = {
    // 公開メディアの miss は短時間だけ負のキャッシュに載せる。`no-cache` では
    // Workers Cache が毎回 Worker を再実行するため、ランダム query による
    // 同一パスの再試行を抑止できない。
    "Cache-Control": cdnCacheSeconds > 0 ? `public, max-age=${cdnCacheSeconds}` : "no-store",
    ...(cdnCacheSeconds > 0 ? { "Cloudflare-CDN-Cache-Control": `public, max-age=${cdnCacheSeconds}` } : {}),
  };

  if (accept.includes("text/html")) {
    return new Response(CATBOX_404_HTML, {
      status: 404,
      headers: {
        ...headers,
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  return new Response(CATBOX_404_SVG, {
    status: 404,
    headers: {
      ...headers,
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function capCacheToExpiry(defaultSeconds, expiresAt) {
  if (!expiresAt) return defaultSeconds;
  const remainingSeconds = Math.ceil((Number(expiresAt) - Date.now()) / 1000);
  return Math.max(0, Math.min(defaultSeconds, remainingSeconds));
}

// Cloudflare のゾーン単位パージを設定した運用だけ、公開メディアの CDN TTL を延ばす。
// 片方でも未設定なら従来の短い TTL に戻るため、pages.dev 単独運用の挙動は変わらない。
function hasGlobalPurgeConfiguration(env) {
  return Boolean(
    env?.CLOUDFLARE_ZONE_ID &&
    (env?.CLOUDFLARE_PURGE_TOKEN || env?.CLOUDFLARE_API_TOKEN)
  );
}

function publicMediaCacheSeconds(env, { isVideoOrAudio = false, isUnpinned = false, expiresAt = null } = {}) {
  // FIFO 等で pin が外れた CID は、IPFS 上での実体を延命する既存の 7 日戦略を維持する。
  if (isUnpinned) return capCacheToExpiry(7 * 86400, expiresAt);

  // Zone purge を利用できる場合だけ 24 時間へ延長。未設定時は従来どおり、
  // 画像・通常ファイルは 1 時間、動画・音声は 4 時間。
  const defaultSeconds = hasGlobalPurgeConfiguration(env)
    ? 86400
    : (isVideoOrAudio ? 14400 : 3600);
  return capCacheToExpiry(defaultSeconds, expiresAt);
}

// アップロード時に台帳へ保存した実寸を、直リンクを事前解析するクライアントへ渡す。
function setImageDimensionHeaders(headers, meta = {}) {
  const width = Math.floor(Number(meta.w ?? meta.width));
  const height = Math.floor(Number(meta.h ?? meta.height));
  if (width > 0 && height > 0) {
    headers.set("X-Image-Width", String(width));
    headers.set("X-Image-Height", String(height));
  }
}

// 期限切れリンクは、最初にアクセスされた時だけ回収する。定期実行は行わない。
// 同じ CID を参照する別名が残る限り pin は維持し、最後のリンクなら Kubo 用の
// 墓標を作成する。FILEBASE_IPFS_API_KEY が設定済みの場合は Filebase pin も解放する。
async function cleanupExpiredAlias(env, request, key, expectedCid) {
  if (!(env?.CIVIDGE_KV || env?.IPFS_KV) || !key || !expectedCid) return;

  try {
    // 古いエッジ読み取り結果で、延長・再登録されたリンクを消さないよう再確認する。
    const latest = await (env.CIVIDGE_KV || env.IPFS_KV).getWithMetadata(key);
    const latestMeta = latest?.metadata || {};
    const latestExpiresAt = latestMeta.e ? latestMeta.e * 1000 : latestMeta.expiresAt;
    if (!latest?.value || latest.value !== expectedCid || !latestExpiresAt || Date.now() <= Number(latestExpiresAt)) return;

    if (latestMeta.blobKey) {
      await (env.CIVIDGE_KV || env.IPFS_KV).delete(latestMeta.blobKey).catch(() => {});
    }
    await (env.CIVIDGE_KV || env.IPFS_KV).delete(key);

    // KV list は1,000件ずつなので、全ページを確認できた場合だけ「最後」と断定する。
    let cursor = undefined;
    let isCidShared = false;
    do {
      const page = await (env.CIVIDGE_KV || env.IPFS_KV).list({ limit: 1000, ...(cursor ? { cursor } : {}) });
      isCidShared = (page.keys || []).some((item) => {
        if (item.name.startsWith("tombstone_") || item.name.startsWith("blob_")) return false;
        return (item.metadata?.c || item.metadata?.cid) === expectedCid;
      });
      cursor = page.list_complete === false ? page.cursor : undefined;
    } while (!isCidShared && cursor);

    if (!isCidShared) {
      // 自宅 Kubo が次回起動した際に回収できるよう、既存仕様の墓標を維持する。
      await (env.CIVIDGE_KV || env.IPFS_KV).put(`tombstone_${expectedCid}`, "1", { expirationTtl: 86400 * 30 }).catch(() => {});

      // S3実体削除用の墓標を作成（管理画面が開いた際にブラウザのS3クライアントが実体削除して墓標を消去する）
      const s3TargetKey = latestMeta.s3Key || latestMeta.s || (key.includes(":") ? key.split(":")[1] : key);
      if (s3TargetKey) {
        await (env.CIVIDGE_KV || env.IPFS_KV).put(`tombstone_s3_${encodeURIComponent(s3TargetKey)}`, "1", { expirationTtl: 86400 * 30 }).catch(() => {});
      }

      // Filebase 用の限定 RPC key がある運用では、最後の別名で pin も解放する。
      const filebaseKey = (env.FILEBASE_IPFS_API_KEY || "").trim();
      if (filebaseKey) {
        const release = await fetch(`https://rpc.filebase.io/api/v0/pin/rm?arg=${encodeURIComponent(expectedCid)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${filebaseKey}` },
        });
        if (!release.ok) console.warn(`Filebase unpin failed for expired CID (${release.status})`);
      }
    }

    // 同じ URL が残っているエッジキャッシュをこの PoP から外す。
    await caches.default.delete(request).catch(() => {});
  } catch (err) {
    // 配信の 404 自体は優先する。回収失敗時は次のアクセスで再試行される。
    console.warn("Expired alias cleanup failed:", err);
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  // ⚡ CORS プリフライト（OPTIONS）は最前線で即時204返却（無駄な処理・待機時間を完全排除）
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, If-Range, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname;
  // 🛡️ メディア配信エッジ判定:
  // KV Worker / 配信エッジへの非メディアリクエストやトップページアクセスは即時404返却
  const isMainApp = url.hostname === "cividge.pages.dev" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const isDeliveryEdge = !isMainApp;

  // workers.dev は管理 API の接続先としては残すが、公開メディアの配信入口には
  // しない。f5.si Zone の URL Rewrite / Rate Limit を迂回して Worker を直接
  // 叩かれる経路を閉じる。`/api/*` は server.js が先に処理するため影響しない。
  // URL 内部名ではなく受信 Host を使う。Custom Domain で実行される Worker は
  // 内部 URL が workers.dev を指す場合があるため、前者で判定すると正規配信まで
  // 誤って遮断してしまう。
  const requestHost = (request.headers.get("Host") || url.hostname).toLowerCase().split(":")[0];
  if (requestHost.endsWith(".workers.dev")) {
    return renderNotFoundResponse(request, 86400);
  }

  // 静的 Pages 互換レイヤーは query ではなく内部パスで印を渡す。
  // 背後ドメイン側で query を捨てても、どの公開入口の台帳を参照すべきか失わない。
  const STATIC_RELAY_PATH_PREFIX = "r/";
  let rawFilename = pathname.replace(/^\/+/, "");
  const hasStaticRelayPathMarker = rawFilename.startsWith(STATIC_RELAY_PATH_PREFIX);
  if (hasStaticRelayPathMarker) {
    rawFilename = rawFilename.slice(STATIC_RELAY_PATH_PREFIX.length);
  }
  if (rawFilename.startsWith("404-character.")) {
    return new Response(getCharacterWebpBytes(), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  if (rawFilename.startsWith("api/")) {
    return renderNotFoundResponse(request);
  }

  let filename = rawFilename;
  try {
    filename = decodeURIComponent(rawFilename);
  } catch (e) {
    filename = rawFilename;
  }

  if (!filename) {
    return renderNotFoundResponse(request);
  }

  const extMatch = pathname.match(/\.(webp|png|jpe?g|gif|jxl|avif|bmp|ico|mp4|webm|mov|m4v|avi|ogv|mp3|wav|ogg|m4a|flac|aac|pdf|txt|md|json|csv)$/i) ||
                   filename.match(/\.(webp|png|jpe?g|gif|jxl|avif|bmp|ico|mp4|webm|mov|m4v|avi|ogv|mp3|wav|ogg|m4a|flac|aac|pdf|txt|md|json|csv)$/i);
  if (!extMatch) {
    return renderNotFoundResponse(request, 86400);
  }

  // 🛡️ ファイル名長上限ガード: 100文字を超えるリクエストはKVを検索せず即座に404（24時間キャッシュ）
  if (Array.from(filename).length > 100) {
    return renderNotFoundResponse(request, 86400);
  }

  let targetCid = null;
  let meta = {};
  let resolvedKvKey = "";
  if (env && (env.CIVIDGE_KV || env.IPFS_KV)) {
    try {
      const currentHost = url.hostname.toLowerCase();
      // 静的 Pages 入口から背後の Worker へ転送された場合だけ、入口ホストの
      // ドメイン別台帳を引く。値は環境変数で許可したホストに限定するため、
      // 任意の query で別ホストの名前空間を読ませることはできない。
      const relayHost = (url.searchParams.get("__cividge_relay") || "")
        .trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
      const allowedRelayHosts = String(env.STATIC_RELAY_PUBLIC_HOSTS || "")
        .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
      // `r/` は query 除去ルールと共存できる静的公開入口の印。
      // 旧 `?r` / `__cividge_relay=<host>` も移行期間は受け付ける。
      const isRelayRequest = hasStaticRelayPathMarker || url.searchParams.has("r");
      let candidateRelayHosts = [];
      if (allowedRelayHosts.includes(relayHost)) {
        candidateRelayHosts.push(relayHost);
      } else if (isRelayRequest) {
        // 静的リレー経由の場合は、許可された全Pagesホストを照会候補とする
        candidateRelayHosts.push(...allowedRelayHosts);
      }

      const lookupDomainKey = async (host) => {
        let result = await (env.CIVIDGE_KV || env.IPFS_KV).getWithMetadata(`${host}:${filename}`);
        let keyName = filename;
        if ((!result || !result.value) && filename !== rawFilename) {
          result = await (env.CIVIDGE_KV || env.IPFS_KV).getWithMetadata(`${host}:${rawFilename}`);
          keyName = rawFilename;
        }
        return { result, keyName };
      };

      let resolvedHost = "";
      let kvRes = null;
      let resolvedFilename = filename;
      let isDomainSpecific = false;

      // 1. 静的リレー候補ホスト（content-relay, testunko など）から順次キーを探索
      for (const host of candidateRelayHosts) {
        const lookup = await lookupDomainKey(host);
        if (lookup.result && lookup.result.value) {
          resolvedHost = host;
          kvRes = lookup.result;
          resolvedFilename = lookup.keyName;
          isDomainSpecific = true;
          break;
        }
      }

      // 2. リレー候補で見つからなければ、直接アクセスされた背後ホストで照会
      if (!isDomainSpecific) {
        resolvedHost = currentHost;
        const lookup = await lookupDomainKey(currentHost);
        if (lookup.result && lookup.result.value) {
          kvRes = lookup.result;
          resolvedFilename = lookup.keyName;
          isDomainSpecific = true;
        }
      }

      // 2. 見つからなければ従来のファイル名単体キーでフォールバック照会
      if (!isDomainSpecific) {
        kvRes = await (env.CIVIDGE_KV || env.IPFS_KV).getWithMetadata(filename);
      }
      if ((!kvRes || !kvRes.value) && filename !== rawFilename) {
        kvRes = await (env.CIVIDGE_KV || env.IPFS_KV).getWithMetadata(rawFilename);
      }

      if (kvRes && kvRes.value) {
        targetCid = kvRes.value;
        meta = kvRes.metadata || {};
        resolvedKvKey = isDomainSpecific ? `${resolvedHost}:${resolvedFilename}` : filename;
        // 旧形式や単体キーのレコードでも allowedHost が設定されている。
        // 静的 Pages 入口からの正規 marker がある場合は、候補ホストの中から
        // レコードの allowedHost と合致するものを __resolvedPublicHost に設定する。
        const allowedHost = meta.d || meta.allowedHost || "";
        const matchedRelayHost = candidateRelayHosts.find(h => allowedHost.includes(h));
        meta.__resolvedPublicHost = isDomainSpecific
          ? resolvedHost
          : (matchedRelayHost || currentHost);
      }
    } catch (kvErr) {
      console.warn("IPFS_KV get error:", kvErr);
    }
  }

  // 台帳に存在しないファイル名は、IPFS Gateway を検索しない。ランダムパス
  // 攻撃で Filebase・公開 Gateway・Kubo の上流アクセスを発生させない。
  // 正規の公開リンクは必ず KV 台帳の CID または保存キーを持つという不変条件に
  // 依存する。
  if (!targetCid) {
    return renderNotFoundResponse(request, 60);
  }

  // ⏳ 時限アップロードの有効期限チェック（期限切れは即座に404、短縮キー e にも対応）
  const expiresTimestamp = meta.e ? (meta.e * 1000) : meta.expiresAt;
  if (expiresTimestamp && Date.now() > Number(expiresTimestamp)) {
    // waitUntil により 404 を待たせず、期限切れアクセス時だけ後始末する。
    const cleanup = cleanupExpiredAlias(env, request, resolvedKvKey, targetCid);
    context.waitUntil?.(cleanup) || cleanup;
    return renderNotFoundResponse(request);
  }

  // 🌐 配信ドメイン制限チェック（各ドメインは完全独立：設定されたドメイン以外からのアクセスは即座に404で遮断）
  const allowedDomain = meta.d || meta.allowedHost;
  if (allowedDomain && typeof allowedDomain === "string" && allowedDomain.trim()) {
    const allowedHostnames = allowedDomain.split(",").map(h => h.trim().toLowerCase().replace(/^https?:\/\//, "").split('/')[0].split(':')[0]).filter(Boolean);
    // 静的入口を正規に経由した場合は、入口側の台帳ホストを検証対象にする。
    const currentHostname = meta.__resolvedPublicHost || url.hostname.toLowerCase();
    if (allowedHostnames.length > 0 && !allowedHostnames.includes(currentHostname)) {
      return renderNotFoundResponse(request, 60);
    }
  }

  // 🔒 パスワード保護の検証ゲート
  const hasPassword = Boolean(meta.password || meta.passwordHash);
  if (hasPassword) {
    const cookies = parseCookies(request.headers.get("Cookie"));
    const cookieKey = "auth_" + encodeURIComponent(filename);
    const authCookie = cookies[cookieKey];

    const isSessionAuthed = await verifySessionToken(authCookie, filename, meta);

    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const pwd = formData.get("pwd");
        if (await verifyPassword(pwd, meta)) {
          const sessionToken = await createSessionToken(filename, meta);
          if (!sessionToken) throw new Error("Unable to create session");
          return new Response(null, {
            status: 303,
            headers: {
              "Location": request.url,
              "Set-Cookie": `${cookieKey}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
            },
          });
        } else {
          // 🛡️ パスワード総当たり・辞書攻撃対策:
          // KVの書き込み枠（1日1,000回）を浪費せず、1秒強制スリープでツールの高速試行を無力化
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return new Response(renderPasswordForm(filename, "合言葉（パスワード）が正しくありません"), {
            status: 403,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "private, no-cache, no-store",
              "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
              "X-Frame-Options": "DENY",
              "Referrer-Policy": "no-referrer",
            },
          });
        }
      } catch (postErr) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return new Response(renderPasswordForm(filename, "入力処理でエラーが発生しました"), {
          status: 400,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "private, no-cache, no-store",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
    }

    if (!isSessionAuthed) {
      return new Response(renderPasswordForm(filename), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-cache, no-store",
          "Vary": "Cookie",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
  }

  // 🤖 SNSクローラー（Misskey Summaly, Twitter, Discord等）への OGP HTML 即時応答
  // OGP HTML を即座に返すことで、Misskey/SummalyBot がメタデータとサムネイル画像を確実に取得・カード展開できるようにする
  const userAgent = request.headers.get("user-agent") || "";
  const crawlerExt = extMatch[1].toLowerCase();
  const isCrawlerVideo = (crawlerExt === "mp4" || crawlerExt === "webm");
  if (!hasPassword && isSocialCrawler(userAgent)) {
    const ogpThumbnailKey = meta.th || meta.thumbnailKey || ((meta.k_s3 || meta.s3Key) ? `${meta.k_s3 || meta.s3Key}.thumb.webp` : null);
    const ogpHtml = renderOgpHtml(filename, request.url, crawlerExt, isCrawlerVideo, url.origin, ogpThumbnailKey);
    return new Response(ogpHtml, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Worker Cache のキーは User-Agent を分離しない。OGP HTML を共有
        // キャッシュに置くと通常の直リンクへ誤配信し得るのでキャッシュしない。
        "Cache-Control": "no-store",
        "Cloudflare-CDN-Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // 3. KV に実データ（blobKey または blob_<filename>）が直接格納されている場合は即時配信
  if (env && (env.CIVIDGE_KV || env.IPFS_KV)) {
    try {
      const blobKey = meta.blobKey || ("blob_" + filename);
      const directData = await (env.CIVIDGE_KV || env.IPFS_KV).get(blobKey, "arrayBuffer");
      if (directData) {
        const headers = new Headers();
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        headers.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, X-Image-Width, X-Image-Height");
        headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Accept-Ranges", "bytes");
        const extLower = extMatch[1].toLowerCase();
        const isVideo = ["mp4", "webm", "mov", "m4v", "avi", "ogv"].includes(extLower);
        const isAudio = ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(extLower);
        const CACHE_SECONDS = publicMediaCacheSeconds(env, {
          isVideoOrAudio: isVideo || isAudio,
          expiresAt: expiresTimestamp,
        });
        if (hasPassword) {
          headers.set("Cache-Control", `private, max-age=${CACHE_SECONDS}`);
          headers.set("Cloudflare-CDN-Cache-Control", "private, no-store");
          headers.set("Vary", "Cookie, Accept-Encoding");
        } else {
          headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
          headers.set("Cloudflare-CDN-Cache-Control", `public, max-age=${CACHE_SECONDS}`);
          headers.set("Vary", "Accept-Encoding");
        }
        headers.set("Content-Length", String(directData.byteLength));
        const mimeMap = {
          webp: "image/webp", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", jxl: "image/jxl", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
          mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", avi: "video/x-msvideo", ogv: "video/ogg",
          mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac",
          pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
          json: "application/json; charset=utf-8", csv: "text/csv; charset=utf-8",
        };
        const ext = extMatch[1].toLowerCase();
        headers.set("Content-Type", meta.mime || mimeMap[ext] || "application/octet-stream");
        setImageDimensionHeaders(headers, meta);
        return new Response(directData, { status: 200, headers });
      }
    } catch (directErr) {
      console.warn("Direct blob read error:", directErr);
    }
  }

  // 3.5. R2 ストレージに保存されている場合は R2 バケットから直接配信
  if (env && env.R2_BUCKET && (meta.backend === "r2" || (!targetCid && filename))) {
    try {
      const r2Key = meta.s3Key || meta.k_s3 || filename;
      const r2Obj = await env.R2_BUCKET.get(r2Key);
      if (r2Obj) {
        const headers = new Headers();
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        headers.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, X-Image-Width, X-Image-Height");
        headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Accept-Ranges", "bytes");
        const extLower = extMatch[1].toLowerCase();
        const isVideo = ["mp4", "webm", "mov", "m4v", "avi", "ogv"].includes(extLower);
        const isAudio = ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(extLower);
        const CACHE_SECONDS = publicMediaCacheSeconds(env, {
          isVideoOrAudio: isVideo || isAudio,
          expiresAt: expiresTimestamp,
        });
        headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
        headers.set("Cloudflare-CDN-Cache-Control", `public, max-age=${CACHE_SECONDS}`);
        headers.set("Vary", "Accept-Encoding");
        r2Obj.writeHttpMetadata(headers);
        headers.set("Content-Type", meta.mime || headers.get("Content-Type") || "application/octet-stream");
        return new Response(r2Obj.body, { status: 200, headers });
      }
    } catch (r2Err) {
      console.warn("R2 read error:", r2Err);
    }
  }

  // 候補ターゲット（CID、S3Key、ファイル名）を順次試行
  const candidates = [];
  if (targetCid) candidates.push(targetCid);
  const effectiveS3Key = meta.k_s3 || meta.s3Key;
  if (effectiveS3Key && !candidates.includes(effectiveS3Key)) candidates.push(effectiveS3Key);
  if (!candidates.includes(filename)) candidates.push(filename);

  // 🪐 複数公共IPFSゲートウェイとピン状態に応じた動的優先ルーティング
  // See: [INV-DELIVERY-002] (ストレージ状態に応じたゲートウェイ動的ルーティング)
  const isKuboPinned = meta.kuboStatus === "pinned" || Boolean((meta.f || 0) & 2);
  const isUnpinned = Boolean(meta.unpinned) || Boolean((meta.f || 0) & 1);

  // 公共ゲートウェイ群（Protocol Labs / Pinata / 4EVERLAND など DHT 経由で探索可能なノード）
  const publicGateways = [
    "https://dweb.link/ipfs",
    "https://ipfs.io/ipfs",
    "https://gateway.pinata.cloud/ipfs",
    "https://4everland.io/ipfs",
  ];
  const filebaseGateway = "https://ipfs.filebase.io/ipfs";

  // 自宅 Kubo の専用公開ゲートウェイ（環境変数 KUBO_GATEWAY_URL があれば最優先）
  const customKuboGateway = (env && env.KUBO_GATEWAY_URL ? env.KUBO_GATEWAY_URL : "").trim().replace(/\/$/, "");

  let orderedGateways = [];
  if (customKuboGateway) {
    orderedGateways.push(customKuboGateway);
  }

  if (isKuboPinned) {
    // 🟣 自宅 Kubo 保全済み:
    // DHT 経由で自宅 Kubo からブロックを取り寄せる公共GWを最優先にし、Filebase 帯域消費をゼロ化。
    // 自宅 PC が電源オフの時だけ、Filebase を最後のフォールバックとして叩いて 404 を防ぐ。
    orderedGateways.push(...publicGateways, filebaseGateway);
  } else {
    // 🟢 Filebase ピン留め中 または 🌊 アンピン漂流中:
    // 最もデータ実体・エッジキャッシュが最後まで残存している Filebase を最優先で叩いて即座に救出。
    // Filebase で見つからない（完全にGC消去された）場合は、フォールバックとして公共GWを探索する。
    // ※アンピン漂流中ファイルは Cloudflare エッジに 7日間（604,800秒）キャッシュされるため、Filebase 帯域消費も週1回で極小。
    orderedGateways.push(filebaseGateway, ...publicGateways);
  }

  // ⏱️ 登録からの経過時間判定（30秒以内ならアップロード直後の初期同期中とみなす猶予ステート）
  // See: [INV-DELIVERY-001] (台帳存在時の 404 キャッシュ禁止 / Grace Period)
  const registeredTime = meta.registeredAt || (meta.t ? meta.t * 1000 : 0) || meta.lastModified || 0;
  const isWithinGracePeriod = registeredTime > 0 && (Date.now() - registeredTime < 30000);

  // アンピン状態の判定: FIFO等でアンピンされたファイルは 7日間（604,800秒）キャッシュ
  // （週1回の上流アクセスでIPFSノードのGC消去を回避・延命し、Filebase転送枠も死守）
  // 通常ピン留め中は 1年間（31,536,000秒）キャッシュ
  const UPSTREAM_CACHE_SECONDS = capCacheToExpiry(isUnpinned ? (7 * 86400) : 31536000, expiresTimestamp);

  const isHead = request.method === "HEAD";

  let upstreamResponse = null;
  const maxFetchAttempts = isWithinGracePeriod ? 2 : 1; // 30秒以内の初期同期なら1回自動リトライ

  for (let attempt = 0; attempt < maxFetchAttempts; attempt++) {
    if (attempt > 0) {
      // 1回目の失敗後、1.2秒待機して Filebase のインデックス完了を待つ
      await new Promise(r => setTimeout(r, 1200));
    }

    for (const candidate of candidates) {
      for (const gw of orderedGateways) {
        try {
          upstreamResponse = await fetch(`${gw}/${candidate}`, {
            method: isHead ? "HEAD" : "GET",
            redirect: "follow",
            signal: AbortSignal.timeout(6000),
            headers: {
              "User-Agent": "Cividge-KV-Relay/1.0",
              ...(request.headers.get("Range") ? { "Range": request.headers.get("Range") } : {}),
              ...(request.headers.get("If-Range") ? { "If-Range": request.headers.get("If-Range") } : {}),
            },
            cf: {
              cacheEverything: !hasPassword,
              ...(hasPassword ? { cacheTtl: 0 } : {
                // 30秒以内の初期同期中は 404 を絶対に Worker キャッシュしない (0秒)
                cacheTtlByStatus: { "200-299": UPSTREAM_CACHE_SECONDS, "404": isWithinGracePeriod ? 0 : 60, "500-599": 0 }
              }),
            },
          });

          if (upstreamResponse && upstreamResponse.ok) {
            break;
          }
        } catch (err) {
          console.warn(`Upstream fetch attempt failed for ${gw}/${candidate}:`, err.name === "TimeoutError" ? "Timeout (6s)" : err.message || err);
        }
      }
      if (upstreamResponse && upstreamResponse.ok) {
        break;
      }
    }
    if (upstreamResponse && upstreamResponse.ok) {
      break;
    }
  }

  if (!upstreamResponse || !upstreamResponse.ok) {
    // ⚠️ 登録から30秒以内のファイルは初期同期ラグの可能性が高いため、エッジに404を焼き付けない (0秒 / no-store)
    // 30秒を超えた長期不在（自宅ノードオフライン等）は、Worker防護のため通常通り60秒キャッシュする
    const notFoundTtl = isWithinGracePeriod ? 0 : 60;
    return renderNotFoundResponse(request, notFoundTtl);
  }

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, X-Image-Width, X-Image-Height");
  headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");  // 常に宣言（iOS Safari等がシーク非対応と誤判定するのを防止）
  setImageDimensionHeaders(headers, meta);

  // 3層キャッシュ戦略: ブラウザ=CDNレスポンス(画像1時間/動画・音声4時間、アンピン漂流中は7日間) / 上流フェッチ(通常1年/アンピン7日)
  const isVideo = ["mp4", "webm", "mov", "m4v", "avi", "ogv"].includes(extMatch[1].toLowerCase());
  const isAudio = ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(extMatch[1].toLowerCase());
  // 🌊 アンピン（IPFS漂流中）ファイルは、7日間に1回アクセスがあれば上流をつついて延命し、アクセスが無ければ自然消滅するよう7日間に設定
  const CACHE_SECONDS = publicMediaCacheSeconds(env, {
    isVideoOrAudio: isVideo || isAudio,
    isUnpinned,
    expiresAt: expiresTimestamp,
  });
  if (hasPassword) {
    headers.set("Cache-Control", `private, max-age=${CACHE_SECONDS}`);
    headers.set("Cloudflare-CDN-Cache-Control", "private, no-store");
    headers.set("Vary", "Cookie, Accept-Encoding");
  } else {
    headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    headers.set("Cloudflare-CDN-Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    headers.set("Vary", "Accept-Encoding");
  }

  const contentLength = upstreamResponse.headers.get("content-length");
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }
  // 206 Partial Content 対応: 動画・音声シーク再生に必須
  const contentRange = upstreamResponse.headers.get("content-range");
  if (contentRange) {
    headers.set("Content-Range", contentRange);
  }

  const mimeMap = {
    webp: "image/webp",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    jxl: "image/jxl",
    avif: "image/avif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    m4v: "video/mp4",
    avi: "video/x-msvideo",
    ogv: "video/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    flac: "audio/flac",
    aac: "audio/aac",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    json: "application/json; charset=utf-8",
    csv: "text/csv; charset=utf-8",
  };
  const ext = extMatch[1].toLowerCase();
  headers.set("Content-Type", mimeMap[ext] || upstreamResponse.headers.get("content-type") || "application/octet-stream");

  return new Response(isHead ? null : upstreamResponse.body, {
    status: upstreamResponse.status,  // 200 or 206 をそのまま返す
    headers,
  });
}
