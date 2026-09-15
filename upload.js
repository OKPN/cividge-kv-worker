// upload.js
// Cloudflare Worker: 外部スクリプト・Windows「送る」バッチ用 POST アップロード API

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Upload-Password, X-Custom-Domain, X-Delivery-Domain, X-Storage-Backend",
    },
  });
}

// 許可拡張子一覧
const ALLOWED_EXTS = [
  "jpg", "jpeg", "png", "webp", "gif", "avif", "jxl", "bmp", "ico",
  "mp4", "webm", "ogv", "mov", "m4v", "avi",
  "mp3", "wav", "ogg", "m4a", "flac", "aac",
  "zip", "7z", "rar", "tar", "gz",
  "pdf", "txt", "md", "json", "csv"
];

const MIME_MAP = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", avif: "image/avif", jxl: "image/jxl", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  zip: "application/zip", "7z": "application/x-7z-compressed", pdf: "application/pdf"
};

function isIpfsCid(value) {
  return typeof value === "string" && /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(value);
}

// Filebase の IPFS RPC API へ投稿する。S3 Access/Secret Key をクライアントへ
// 出さず、Worker の FILEBASE_IPFS_API_KEY（バケット限定キー）だけで実行する。
async function uploadToFilebase(fileBuffer, filename, contentType, env) {
  const apiKey = (env.FILEBASE_IPFS_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Filebase 投稿は未設定です。Worker に FILEBASE_IPFS_API_KEY を secret として設定してください。");
  }

  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer], { type: contentType || "application/octet-stream" }), filename);

  const response = await fetch("https://rpc.filebase.io/api/v0/add?cid-version=0", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Filebase 投稿エラー (${response.status}): ${responseText.slice(0, 300)}`);
  }

  // IPFS API は複数行 JSON を返す実装があるため、末尾から CID を探す。
  let cid = "";
  for (const line of responseText.trim().split(/\r?\n/).reverse()) {
    try {
      const payload = JSON.parse(line);
      const candidate = payload.Hash || payload.Cid?.["/"] || payload.cid;
      if (isIpfsCid(candidate)) {
        cid = candidate;
        break;
      }
    } catch (_) {}
  }
  if (!cid) {
    throw new Error("Filebase から有効な CID が返されませんでした。");
  }
  return cid;
}

// 投稿トークンの検証 (外部投稿はトークン設定必須)
function verifyAuth(request, env) {
  const adminToken = (env.ADMIN_API_TOKEN || env.API_TOKEN || "").trim();
  const uploadToken = (env.UPLOAD_TOKEN || "").trim();
  const requiredToken = adminToken || uploadToken;

  // 🛡️ トークンが環境変数に設定されていない場合は、不正投稿を防ぐため拒否
  if (!requiredToken) return false;

  let clientToken = "";
  const authHeader = (request.headers.get("Authorization") || "").trim();
  if (authHeader) {
    clientToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : authHeader;
  }
  if (!clientToken) {
    const url = new URL(request.url);
    clientToken = (url.searchParams.get("token") || url.searchParams.get("api_token") || "").trim();
  }

  if (adminToken && clientToken === adminToken) return true;
  if (uploadToken && clientToken === uploadToken) return true;
  return false;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 1. 認証チェック
  if (!verifyAuth(request, env)) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized: Invalid or missing token" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  if (!env.IPFS_KV) {
    return new Response(JSON.stringify({ success: false, error: "IPFS_KV binding is not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    let fileBuffer = null;
    let originalFilename = url.searchParams.get("filename") || "";
    let password = (request.headers.get("X-Upload-Password") || url.searchParams.get("password") || "").trim();
    let contentType = "";

    const contentTypeHeader = request.headers.get("Content-Type") || "";

    if (contentTypeHeader.includes("multipart/form-data")) {
      const formData = await request.formData();
      const uploadedFile = formData.get("file") || formData.get("image");
      if (uploadedFile && typeof uploadedFile.arrayBuffer === "function") {
        originalFilename = originalFilename || uploadedFile.name || "upload_file";
        contentType = uploadedFile.type || "";
        fileBuffer = await uploadedFile.arrayBuffer();
      }
      if (formData.get("password")) {
        password = String(formData.get("password")).trim();
      }
    } else {
      fileBuffer = await request.arrayBuffer();
      contentType = contentTypeHeader.split(";")[0].trim();
    }

    if (!fileBuffer || fileBuffer.byteLength === 0) {
      return new Response(JSON.stringify({ success: false, error: "No file content uploaded" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 2. 拡張子バリデーション
    let ext = originalFilename.includes(".") ? originalFilename.split(".").pop().toLowerCase() : "";
    if (!ext || !ALLOWED_EXTS.includes(ext)) {
      ext = "webp"; // デフォルト拡張子
    }
    contentType = contentType || MIME_MAP[ext] || "application/octet-stream";

    // 3. ランダムファイル名生成（6文字英数）
    const randomArray = new Uint8Array(4);
    crypto.getRandomValues(randomArray);
    const randomStr = Array.from(randomArray, b => b.toString(36).padStart(2, "0")).join("").substring(0, 6);
    const shortKey = `${randomStr}.${ext}`;

    // 4. パスワードハッシュ生成 (PBKDF2)
    let passwordMeta = {};
    if (password) {
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
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
      const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, "0")).join("");
      const saltHex = Array.from(saltBytes).map(b => b.toString(16).padStart(2, "0")).join("");
      const sessionSecret = "sec_" + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join("");

      passwordMeta = {
        password,
        passwordHash: hashHex,
        passwordSalt: saltHex,
        sessionSecret,
      };
    }

    // 5. 返却・配信先ドメインの決定
    let targetDomainParam = (
      url.searchParams.get("domain") ||
      request.headers.get("X-Delivery-Domain") ||
      request.headers.get("X-Custom-Domain") ||
      env.CUSTOM_DOMAIN ||
      ""
    ).trim();

    // ホスト名のみの正規化（KV allowedHost用）
    let cleanHostname = "";
    let publicOrigin = "";
    if (targetDomainParam) {
      cleanHostname = targetDomainParam.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0].toLowerCase();
      publicOrigin = /^https?:\/\//i.test(targetDomainParam) ? targetDomainParam : `https://${targetDomainParam}`;
      publicOrigin = publicOrigin.replace(/\/+$/, "");
    } else {
      cleanHostname = url.hostname.toLowerCase();
      publicOrigin = url.origin;
    }

    // 6. ストレージへの保存
    const blobKey = `blob_${shortKey}`;
    let targetCid = null;
    const storageBackend = (url.searchParams.get("storage") || request.headers.get("X-Storage-Backend") || "").trim().toLowerCase();

    if (storageBackend === "filebase") {
      targetCid = await uploadToFilebase(fileBuffer, originalFilename || shortKey, contentType, env);
    } else if (storageBackend === "r2" && env.R2_BUCKET) {
      await env.R2_BUCKET.put(shortKey, fileBuffer, {
        httpMetadata: { contentType },
        customMetadata: { size: String(fileBuffer.byteLength) },
      });
    } else if (storageBackend === "r2") {
      throw new Error("R2 投稿は未設定です。Worker に R2_BUCKET binding を設定してください。");
    } else {
      // storage 未指定時のみ、後方互換として KV に直接実データを保持する。
      if (env.IPFS_KV) {
        await env.IPFS_KV.put(blobKey, fileBuffer);
      }
    }

    // 7. KV にルーティング登録（キーは shortKey 単体とし、ドメイン制限は allowedHost メタデータで管理）
    if (env.IPFS_KV) {
      const kvMetadata = {
        blobKey,
        size: fileBuffer.byteLength,
        mime: contentType,
        registeredAt: Date.now(),
        ...(storageBackend ? { backend: storageBackend } : { backend: "kv" }),
        ...(targetCid ? { cid: targetCid } : {}),
        ...(cleanHostname ? { allowedHost: cleanHostname, d: cleanHostname } : {}),
        ...passwordMeta,
      };

      await env.IPFS_KV.put(shortKey, targetCid || shortKey, { metadata: kvMetadata });
    }

    // 8. レスポンス返却
    const targetUrl = `${publicOrigin}/${encodeURIComponent(shortKey)}`;

    return new Response(JSON.stringify({
      success: true,
      url: targetUrl,
      key: shortKey,
      filename: shortKey,
      size: fileBuffer.byteLength,
      domain: cleanHostname,
      storage: storageBackend || "kv",
      cid: targetCid || null,
      hasPassword: Boolean(password),
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Upload error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
