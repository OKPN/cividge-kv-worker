// upload.js
// Cloudflare Worker: 外部スクリプト・Windows「送る」バッチ用 POST アップロード API

import { onRequestPost as registerCanonicalLink } from "./cividge-kv.js";

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Upload-Password, X-Upload-Filename, X-Custom-Domain, X-Delivery-Domain, X-Storage-Backend",
    },
  });
}

// 🔑 投稿専用 API トークンの疎通・一致検証ハンドラ
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!verifyUploadAuth(request, env)) {
    return new Response(JSON.stringify({ success: false, valid: false, error: "Unauthorized: Invalid or missing token" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    });
  }
  return new Response(JSON.stringify({ success: true, valid: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
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

// Cloudflare Free/Pro の 100 MB request-body 上限を超えないよう、十進 99 MB とする。
const MAX_UPLOAD_BYTES = 99 * 1000 * 1000;
const MAX_UPLOAD_LABEL = "99 MB";
const MAX_BUFFERED_UPLOAD_BYTES = 80 * 1024 * 1024;
const MAX_BUFFERED_UPLOAD_LABEL = "80 MiB";

class UploadTooLargeError extends Error {
  constructor() {
    super(`File too large (Max: ${MAX_UPLOAD_LABEL})`);
    this.name = "UploadTooLargeError";
  }
}

function createSizeLimitedStream(source, maxBytes) {
  const reader = source.getReader();
  let byteLength = 0;
  const body = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("Upload size limit exceeded");
        controller.error(new UploadTooLargeError());
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { body, getByteLength: () => byteLength };
}

export async function putR2Upload(bucket, key, fileStream, fileBuffer, declaredLength, contentType) {
  const metadata = {
    httpMetadata: { contentType },
    customMetadata: { size: String(declaredLength || fileBuffer?.byteLength || 0) },
  };
  if (fileBuffer) {
    await bucket.put(key, fileBuffer, metadata);
    return fileBuffer.byteLength;
  }

  // A size-limiting ReadableStream no longer carries the request body's
  // implicit length. R2 requires either bytes or a FixedLengthStream. Preserve
  // streaming for ordinary raw-body clients when Content-Length is known.
  if (declaredLength > 0 && typeof FixedLengthStream !== "undefined") {
    const fixed = new FixedLengthStream(declaredLength);
    await Promise.all([
      bucket.put(key, fixed.readable, metadata),
      fileStream.pipeTo(fixed.writable),
    ]);
    return declaredLength;
  }

  // Chunked/unknown-length uploads cannot be sent to R2 as a generic stream.
  // The input stream is already guarded by MAX_UPLOAD_BYTES; buffer only this
  // exceptional path and retain the stricter buffered ceiling.
  const buffered = await new Response(fileStream).arrayBuffer();
  if (buffered.byteLength > MAX_BUFFERED_UPLOAD_BYTES) {
    throw new Error(`Chunked R2 upload too large (Max: ${MAX_BUFFERED_UPLOAD_LABEL})`);
  }
  await bucket.put(key, buffered, {
    ...metadata,
    customMetadata: { size: String(buffered.byteLength) },
  });
  return buffered.byteLength;
}

function createFilebaseMultipartStream(fileStream, filename, contentType) {
  const boundary = `----cividge-${crypto.randomUUID()}`;
  const safeFilename = String(filename || "upload_file").replace(/[\r\n"]/g, "_");
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: ${contentType || "application/octet-stream"}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = fileStream.getReader();
  let stage = 0;

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: new ReadableStream({
      async pull(controller) {
        if (stage === 0) {
          stage = 1;
          controller.enqueue(prefix);
          return;
        }
        if (stage === 1) {
          const { done, value } = await reader.read();
          if (!done) {
            controller.enqueue(value);
            return;
          }
          stage = 2;
        }
        if (stage === 2) {
          stage = 3;
          controller.enqueue(suffix);
          return;
        }
        controller.close();
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
  };
}

function isIpfsCid(value) {
  return typeof value === "string" && /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(value);
}

// ファイル名を最大100文字に制限し、超過時は安全に切り詰めてハッシュを付与
export function truncateFilename(filename, maxLength = 100) {
  if (!filename || typeof filename !== "string") return filename || "";
  const fullChars = Array.from(filename);
  if (fullChars.length <= maxLength) return filename;

  const dotIndex = filename.lastIndexOf(".");
  let ext = "";
  let baseStr = filename;
  if (dotIndex > 0 && dotIndex < filename.length - 1) {
    ext = filename.slice(dotIndex);
    baseStr = filename.slice(0, dotIndex);
  }

  let hash = "";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const rand = new Uint8Array(4);
    crypto.getRandomValues(rand);
    hash = Array.from(rand, b => b.toString(36).padStart(2, "0")).join("").slice(0, 6);
  } else {
    hash = Math.random().toString(36).slice(2, 8);
  }

  const suffix = `_${hash}${ext}`;
  const suffixChars = Array.from(suffix);
  const allowedBaseCharsCount = Math.max(1, maxLength - suffixChars.length);
  const baseChars = Array.from(baseStr);
  const truncatedBase = baseChars.slice(0, allowedBaseCharsCount).join("").replace(/[._\s-]+$/, "");

  return `${truncatedBase}${suffix}`;
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

async function uploadStreamToFilebase(fileStream, filename, contentType, env) {
  const apiKey = (env.FILEBASE_IPFS_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Filebase 投稿は未設定です。Worker に FILEBASE_IPFS_API_KEY を secret として設定してください。");
  }
  const multipart = createFilebaseMultipartStream(fileStream, filename, contentType);
  const response = await fetch("https://rpc.filebase.io/api/v0/add?cid-version=0", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": multipart.contentType,
    },
    body: multipart.body,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Filebase 投稿エラー (${response.status}): ${responseText.slice(0, 300)}`);
  }
  for (const line of responseText.trim().split(/\r?\n/).reverse()) {
    try {
      const payload = JSON.parse(line);
      const candidate = payload.Hash || payload.Cid?.["/"] || payload.cid;
      if (isIpfsCid(candidate)) return candidate;
    } catch (_) {}
  }
  throw new Error("Filebase から有効な CID が返されませんでした。");
}

// 投稿トークンの検証。管理トークンは投稿 API に流用しない。
export function verifyUploadAuth(request, env) {
  // Both values have the same upload-only capability. TEST_UPLOAD_TOKEN is
  // intentionally not an admin credential; it merely lets a separate test
  // client use a distinct secret.
  const uploadTokens = [env.UPLOAD_TOKEN, env.TEST_UPLOAD_TOKEN]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  // No upload credential configured: disable this API entirely.
  if (uploadTokens.length === 0) return false;

  let clientToken = "";
  const authHeader = (request.headers.get("Authorization") || "").trim();
  if (authHeader) {
    clientToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : authHeader;
  }
  return uploadTokens.includes(clientToken);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 1. 認証チェック
  if (!verifyUploadAuth(request, env)) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized: Invalid or missing token" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  if (!env.CIVIDGE_KV || !env.OBJECT_LIFECYCLE) {
    return new Response(JSON.stringify({ success: false, error: "CIVIDGE_KV and OBJECT_LIFECYCLE bindings are required" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const contentTypeHeader = request.headers.get("Content-Type") || "";
    const isMultipart = contentTypeHeader.includes("multipart/form-data");
    const declaredLength = Number(request.headers.get("content-length") || 0);
    const declaredLimit = isMultipart ? MAX_BUFFERED_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
    const declaredLimitLabel = isMultipart ? MAX_BUFFERED_UPLOAD_LABEL : MAX_UPLOAD_LABEL;
    if (declaredLength > declaredLimit) {
      return new Response(JSON.stringify({ success: false, error: `File too large (Max: ${declaredLimitLabel})` }), {
        status: 413,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    let fileBuffer = null;
    let fileStream = null;
    let streamByteLength = null;
    let originalFilename = url.searchParams.get("filename") || request.headers.get("X-Upload-Filename") || "";
    // パスワードを URL に入れると履歴・ログへ残り得るため、ヘッダーか multipart のみ許可。
    let password = (request.headers.get("X-Upload-Password") || "").trim();
    let contentType = "";

    if (isMultipart) {
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
      if (!request.body) {
        return new Response(JSON.stringify({ success: false, error: "No file content uploaded" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      const limited = createSizeLimitedStream(request.body, MAX_UPLOAD_BYTES);
      fileStream = limited.body;
      streamByteLength = limited.getByteLength;
      contentType = contentTypeHeader.split(";")[0].trim();
    }

    if (!fileBuffer && !fileStream) {
      return new Response(JSON.stringify({ success: false, error: "No file content uploaded" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (fileBuffer && fileBuffer.byteLength === 0) {
      return new Response(JSON.stringify({ success: false, error: "No file content uploaded" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (fileBuffer && fileBuffer.byteLength > MAX_BUFFERED_UPLOAD_BYTES) {
      return new Response(JSON.stringify({ success: false, error: `File too large (Max: ${MAX_BUFFERED_UPLOAD_LABEL})` }), {
        status: 413,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 2. ファイル名正規化（最大100文字制限）
    originalFilename = truncateFilename(originalFilename, 100);

    // 3. 拡張子バリデーション
    let ext = originalFilename.includes(".") ? originalFilename.split(".").pop().toLowerCase() : "";
    if (!ext || !ALLOWED_EXTS.includes(ext)) {
      ext = "webp"; // デフォルト拡張子
    }
    contentType = contentType || MIME_MAP[ext] || "application/octet-stream";

    // 3. 命名ルールに基づく shortKey の生成 (random / original / date_random)
    const namingRule = (url.searchParams.get("naming") || request.headers.get("X-Upload-Naming") || "random").toLowerCase();
    const randomArray = new Uint8Array(4);
    crypto.getRandomValues(randomArray);
    const randomStr = Array.from(randomArray, b => b.toString(36).padStart(2, "0")).join("").substring(0, 6);

    let shortKey = `${randomStr}.${ext}`;
    if (namingRule === "original" && originalFilename) {
      const lastDot = originalFilename.lastIndexOf(".");
      let baseName = lastDot > 0 ? originalFilename.slice(0, lastDot) : originalFilename;
      baseName = baseName.replace(/[/\\?%*:|"<>]/g, "_").trim().replace(/\s+/g, "_");
      if (baseName) {
        shortKey = `${baseName}.${ext}`;
      }
    } else if (namingRule === "date_random") {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, "0");
      const d = String(now.getUTCDate()).padStart(2, "0");
      shortKey = `${y}${m}${d}_${randomStr}.${ext}`;
    }

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
      passwordMeta = {
        passwordHash: hashHex,
        passwordSalt: saltHex,
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
    let targetCid = null;
    const storageBackend = (url.searchParams.get("storage") || request.headers.get("X-Storage-Backend") || "").trim().toLowerCase();

    let uploadedSize = 0;
    if (storageBackend === "filebase") {
      targetCid = fileStream
        ? await uploadStreamToFilebase(fileStream, originalFilename || shortKey, contentType, env)
        : await uploadToFilebase(fileBuffer, originalFilename || shortKey, contentType, env);
      uploadedSize = fileBuffer ? fileBuffer.byteLength : streamByteLength();
    } else if (storageBackend === "r2" && env.R2_BUCKET) {
      uploadedSize = await putR2Upload(env.R2_BUCKET, shortKey, fileStream, fileBuffer, declaredLength, contentType);
    } else if (storageBackend === "r2") {
      throw new Error("R2 投稿は未設定です。Worker に R2_BUCKET binding を設定してください。");
    } else if (fileBuffer) {
      throw new Error("storage=filebase or storage=r2 is required");
    } else {
      throw new Error("ストリーミング投稿では storage=filebase または storage=r2 を指定してください。");
    }

    if (uploadedSize === 0) throw new Error("No file content uploaded");

    // 7. Link publication uses the same control-plane endpoint as every
    // other caller. Upload owns physical creation; it never owns KV or
    // lifecycle mutation directly.
    const registryUrl = new URL("/api/cividge-kv", request.url);
    const registryRequest = new Request(registryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${(env.ADMIN_API_TOKEN || env.API_TOKEN || "").trim()}`,
      },
      body: JSON.stringify({
        key: `${cleanHostname}:${shortKey}`,
        cid: storageBackend === "r2" ? "r2" : targetCid,
        size: uploadedSize,
        mime: contentType,
        s3Key: shortKey,
        password,
        backend: storageBackend,
        createOnly: true,
      }),
    });
    // Do not fetch the Worker's own public URL. Besides adding a second
    // routing/failure surface, same-Worker self-fetch is not a lifecycle
    // primitive. Invoke the one canonical registry handler in-process.
    const registryResponse = await registerCanonicalLink({
      request: registryRequest,
      env,
      waitUntil: context.waitUntil,
    });
    if (!registryResponse.ok) {
      const detail = await registryResponse.json().catch(() => ({}));
      throw new Error(detail.error || `Link registration failed (${registryResponse.status})`);
    }

    // 8. レスポンス返却
    const targetUrl = `${publicOrigin}/${encodeURIComponent(shortKey)}`;

    return new Response(JSON.stringify({
      success: true,
      url: targetUrl,
      key: shortKey,
      filename: shortKey,
      size: uploadedSize,
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
      status: err instanceof UploadTooLargeError ? 413 : 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
