// functions/_middleware.js
// Cloudflare Pages Function Middleware: 静的ファイル 404 / SPA フォールバック時のスマート中継 (Catbox風ハイブリッド404 & パスワード保護ゲート)

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
    <img class="character-img" src="/404-character.webp" alt="404 Not Found" onerror="this.style.display='none'">
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
    <div class="filename">${filename}</div>
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
function renderOgpHtml(filename, rawUrl, ext, isVideo, origin) {
  const title = `${filename}`;
  const siteName = "Cividge Media";
  // 動画の場合は同名先頭フレームサムネイル（.thumb.webp）を最優先指定
  const videoThumbUrl = `${origin}/${filename}.thumb.webp`;
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
    "Cache-Control": "no-cache",
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
  // 🛡️ メディア配信エッジ判定:
  // KV Worker / 配信エッジへの非メディアリクエストやトップページアクセスは即時404返却
  const isMainApp = url.hostname === "cividge.pages.dev" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const isDeliveryEdge = !isMainApp;

  const rawFilename = pathname.replace(/^\/+/, "");
  if (rawFilename.startsWith("api/") || rawFilename.startsWith("404-character.")) {
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

  let targetCid = null;
  let meta = {};
  if (env && env.IPFS_KV) {
    try {
      const currentHost = url.hostname.toLowerCase();
      // 1. ドメイン個別キー (例: "misskey-media.pages.dev:7ud1yi6z.mp4") で優先照会
      let kvRes = await env.IPFS_KV.getWithMetadata(`${currentHost}:${filename}`);
      if (!kvRes && filename !== rawFilename) {
        kvRes = await env.IPFS_KV.getWithMetadata(`${currentHost}:${rawFilename}`);
      }
      // 2. 見つからなければ従来のファイル名単体キーでフォールバック照会
      if (!kvRes) {
        kvRes = await env.IPFS_KV.getWithMetadata(filename);
      }
      if (!kvRes && filename !== rawFilename) {
        kvRes = await env.IPFS_KV.getWithMetadata(rawFilename);
      }
      if (kvRes) {
        targetCid = kvRes.value;
        meta = kvRes.metadata || {};
      }
    } catch (kvErr) {
      console.warn("IPFS_KV get error:", kvErr);
    }
  }

  // ⏳ 時限アップロードの有効期限チェック（期限切れは即座に404、短縮キー e にも対応）
  const expiresTimestamp = meta.e ? (meta.e * 1000) : meta.expiresAt;
  if (expiresTimestamp && Date.now() > Number(expiresTimestamp)) {
    return renderNotFoundResponse(request);
  }

  // 🌐 配信ドメイン制限チェック（設定されたドメイン以外からのアクセスは即座に404で遮断）
  // 🌟 公式配信エッジ群（content-cache, content-relay, misskey-media, blobs-cache, cividge）は相互にスムーズな切り替え・配信を許可
  const allowedDomain = meta.d || meta.allowedHost;
  if (allowedDomain && typeof allowedDomain === "string" && allowedDomain.trim()) {
    const allowedHostnames = allowedDomain.split(",").map(h => h.trim().toLowerCase().replace(/^https?:\/\//, "").split('/')[0].split(':')[0]).filter(Boolean);
    const currentHostname = url.hostname.toLowerCase();
    if (allowedHostnames.length > 0 && !allowedHostnames.includes(currentHostname)) {
      return renderNotFoundResponse(request, 60); // 許可外ドメインアクセスは1分キャッシュ
    }
  }

  // 🔒 パスワード保護の検証ゲート
  const hasPassword = Boolean(meta.password || meta.passwordHash);
  if (hasPassword) {
    const cookies = parseCookies(request.headers.get("Cookie"));
    const cookieKey = "auth_" + encodeURIComponent(filename);
    const authCookie = cookies[cookieKey];

    const isSessionAuthed = Boolean(authCookie && meta.sessionSecret && authCookie === meta.sessionSecret);

    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const pwd = formData.get("pwd");
        if (await verifyPassword(pwd, meta)) {
          const secret = meta.sessionSecret || ("sec_" + Math.random().toString(36).slice(2));
          return new Response(null, {
            status: 303,
            headers: {
              "Location": request.url,
              "Set-Cookie": `${cookieKey}=${encodeURIComponent(secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
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
    const ogpHtml = renderOgpHtml(filename, request.url, crawlerExt, isCrawlerVideo, url.origin);
    return new Response(ogpHtml, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "Cloudflare-CDN-Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // 3. KV に実データ（blobKey または blob_<filename>）が直接格納されている場合は即時配信
  if (env && env.IPFS_KV) {
    try {
      const blobKey = meta.blobKey || ("blob_" + filename);
      const directData = await env.IPFS_KV.get(blobKey, "arrayBuffer");
      if (directData) {
        const headers = new Headers();
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        headers.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
        headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Accept-Ranges", "bytes");
        const extLower = extMatch[1].toLowerCase();
        const isVideo = ["mp4", "webm", "mov", "m4v", "avi", "ogv"].includes(extLower);
        const isAudio = ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(extLower);
        const CACHE_SECONDS = (isVideo || isAudio) ? 14400 : 3600; // 動画・音声4時間 / その他1時間
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
        return new Response(directData, { status: 200, headers });
      }
    } catch (directErr) {
      console.warn("Direct blob read error:", directErr);
    }
  }

  // 候補ターゲット（CID、S3Key、ファイル名）を順次試行
  const candidates = [];
  if (targetCid) candidates.push(targetCid);
  const effectiveS3Key = meta.k_s3 || meta.s3Key;
  if (effectiveS3Key && !candidates.includes(effectiveS3Key)) candidates.push(effectiveS3Key);
  if (!candidates.includes(filename)) candidates.push(filename);

  // 🪐 複数公共IPFSゲートウェイへのアクセス分散（マルチキャッシュ伝播 & Filebase転送量節約）
  const ipfsGateways = [
    "https://ipfs.filebase.io/ipfs",
    "https://cloudflare-ipfs.com/ipfs",
    "https://ipfs.io/ipfs",
    "https://dweb.link/ipfs",
  ];

  // アンピン状態の判定: FIFO等でアンピンされたファイルは 7日間（604,800秒）キャッシュ
  // （週1回の上流アクセスでIPFSノードのGC消去を回避・延命し、Filebase転送枠も死守）
  // 通常ピン留め中は 1年間（31,536,000秒）キャッシュ
  const isUnpinned = Boolean(meta.unpinned) || Boolean((meta.f || 0) & 1);
  const UPSTREAM_CACHE_SECONDS = isUnpinned ? (7 * 86400) : 31536000;

  // ゲートウェイの優先順位を分散（アンピン時は公共ノードにも均等にアクセスを散らす）
  const orderedGateways = isUnpinned
    ? [...ipfsGateways].sort(() => Math.random() - 0.5)
    : ipfsGateways;

  const isHead = request.method === "HEAD";

  let upstreamResponse = null;
  for (const candidate of candidates) {
    for (const gw of orderedGateways) {
      try {
        upstreamResponse = await fetch(`${gw}/${candidate}`, {
          method: isHead ? "HEAD" : "GET",
          signal: AbortSignal.timeout(4000),
          headers: {
            "User-Agent": "Cividge-KV-Relay/1.0",
            ...(request.headers.get("Range") ? { "Range": request.headers.get("Range") } : {}),
            ...(request.headers.get("If-Range") ? { "If-Range": request.headers.get("If-Range") } : {}),
          },
          cf: {
            cacheEverything: !hasPassword,
            ...(hasPassword ? { cacheTtl: 0 } : {
              cacheTtlByStatus: { "200-299": UPSTREAM_CACHE_SECONDS, "404": 60, "500-599": 0 }
            }),
          },
        });

        if (upstreamResponse && upstreamResponse.ok) {
          break;
        }
      } catch (err) {
        console.warn(`Upstream fetch attempt failed for ${gw}/${candidate}:`, err.name === "TimeoutError" ? "Timeout (4s)" : err.message || err);
      }
    }
    if (upstreamResponse && upstreamResponse.ok) {
      break;
    }
  }


  if (!upstreamResponse || !upstreamResponse.ok) {
    return renderNotFoundResponse(request);
  }

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");  // 常に宣言（iOS Safari等がシーク非対応と誤判定するのを防止）

  // 3層キャッシュ戦略: ブラウザ=CDNレスポンス(画像1時間/動画・音声4時間、アンピン漂流中は7日間) / 上流フェッチ(通常1年/アンピン7日)
  const isVideo = ["mp4", "webm", "mov", "m4v", "avi", "ogv"].includes(extMatch[1].toLowerCase());
  const isAudio = ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(extMatch[1].toLowerCase());
  // 🌊 アンピン（IPFS漂流中）ファイルは、7日間に1回アクセスがあれば上流をつついて延命し、アクセスが無ければ自然消滅するよう7日間に設定
  const CACHE_SECONDS = isUnpinned ? (7 * 86400) : ((isVideo || isAudio) ? 14400 : 3600);
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
