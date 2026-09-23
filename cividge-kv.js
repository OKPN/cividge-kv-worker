// cividge-kv.js
// Cividge delivery projection API.  Link/Object lifecycle authority lives in
// ObjectLifecycle; this module only projects canonical Links into delivery KV.
import { callLifecycle } from "./lifecycle-api.js";
import { callLinkBinding } from "./link-binding-api.js";

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, If-Range, X-Upload-Password, X-Upload-Filename, X-Custom-Domain, X-Delivery-Domain, X-Storage-Backend",
    },
  });
}

// 🛡️ IPFS CID 判定ヘルパー（"r2" などの特殊マーカー値や無効値を除外）
function isRealIpfsCid(c) {
  return typeof c === "string" && c !== "r2" && (c.startsWith("Qm") || c.startsWith("baf") || c.length > 20);
}

function parseCanonicalLinkKey(value) {
  const key = String(value || "").trim();
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  const host = key.slice(0, separator).toLowerCase();
  const filename = key.slice(separator + 1);
  if (!host || !filename || host.includes("/") || /\s/.test(host)) return null;
  return { key: `${host}:${filename}`, host, filename };
}

function objectRefForRegistration({ backend, cid, contentCid, s3Key, thumbnailKey, kuboStatus }) {
  const normalizedBackend = String(backend || "").toLowerCase();
  if (normalizedBackend === "r2" || cid === "r2") {
    const key = String(s3Key || "").trim();
    if (!key) throw new Error("R2 ObjectRef requires s3Key");
    const placements = [{ kind: "r2", executor: "worker", locator: { key, ...(thumbnailKey ? { thumbnailKey } : {}) } }];
    return {
      objectRef: `r2:${key}`,
      placements,
    };
  }
  const ipfsCid = String(contentCid || cid || "").trim();
  if (!isRealIpfsCid(ipfsCid)) throw new Error("IPFS ObjectRef requires a CID");
  if (normalizedBackend === "filebase_rpc") {
    return { objectRef: `ipfs:${ipfsCid.toLowerCase()}`, placements: [{
      kind: "filebase_rpc", executor: "worker", provenance: "cividge_worker_rpc",
      locator: { cid: ipfsCid },
    }] };
  }
  const placements = [{
    kind: "filebase",
    executor: "browser",
    locator: {
      key: String(s3Key || "").trim(),
      cid: ipfsCid,
      ...(thumbnailKey ? { thumbnailKey } : {}),
    },
  }];
  return { objectRef: `ipfs:${ipfsCid.toLowerCase()}`, placements };
}

function objectRefForExisting(value, metadata = {}) {
  return objectRefForRegistration({
    backend: metadata.b || metadata.backend || (value === "r2" ? "r2" : "filebase"),
    cid: value,
    contentCid: metadata.c_cid || metadata.contentCid,
    s3Key: metadata.k_s3 || metadata.s3Key,
    thumbnailKey: metadata.th || metadata.thumbnailKey,
    kuboStatus: metadata.kuboStatus,
  });
}

function unpackMetadata(name, cid, meta = {}) {
  const flags = meta.f || 0;
  const isUnpinned = meta.unpinned !== undefined ? Boolean(meta.unpinned) : Boolean(flags & 1);
  const kuboStatus = meta.kuboStatus || (flags & 2 ? "pinned" : (flags & 4 ? "not_pinned" : null));
  const size = meta.s !== undefined ? meta.s : (meta.size || 0);
  const lastModified = meta.t !== undefined ? meta.t * 1000 : (meta.lastModified || Date.now());
  const expiresAt = meta.e !== undefined ? meta.e * 1000 : (meta.expiresAt || null);

  // hostname:filename の形式（別ドメイン用個別キー）かチェック
  const colonIdx = name.indexOf(":");
  let keyHost = null;
  let displayName = name;
  if (colonIdx > 0 && !name.startsWith("blob_")) {
    keyHost = name.substring(0, colonIdx);
    displayName = name.substring(colonIdx + 1);
  }

  const s3Key = meta.k_s3 || meta.s3Key || displayName;
  const thumbnailKey = meta.th || meta.thumbnailKey || null;
  const width = Number(meta.w ?? meta.width) || null;
  const height = Number(meta.h ?? meta.height) || null;
  const lastKuboPinAttempt = meta.k !== undefined ? meta.k * 1000 : (meta.lastKuboPinAttempt || null);
  const civitaiTemporary = meta.ct !== undefined ? Boolean(meta.ct) : Boolean(meta.civitaiTemporary);

  const allowedHost = keyHost || meta.d || meta.allowedHost || null;

  const contentCid = meta.c_cid || meta.contentCid || null;
  const backend = meta.b || meta.backend || null;

  return {
    ...meta,
    rawKey: name,
    displayName,
    cid: cid || meta.cid || meta.c || "",
    size,
    s: size,
    lastModified,
    t: Math.floor(lastModified / 1000),
    unpinned: isUnpinned,
    kuboStatus,
    s3Key,
    contentCid,
    backend,
    ...(thumbnailKey ? { thumbnailKey, th: thumbnailKey } : {}),
    ...(width && height ? { width, height, w: width, h: height } : {}),
    ...(allowedHost ? { allowedHost, d: allowedHost } : {}),
    ...(expiresAt ? { expiresAt, e: Math.floor(expiresAt / 1000) } : {}),
    ...(lastKuboPinAttempt ? { lastKuboPinAttempt } : {}),
    ...(civitaiTemporary ? { civitaiTemporary: true, ct: 1 } : {}),
  };
}

// 投稿・一覧・削除の管理者認証検証（KV相乗り防止・責任分離）
function verifyAdminAuth(request, env) {
  const adminToken = (env.ADMIN_API_TOKEN || env.API_TOKEN || "").trim();
  if (!adminToken) return false;

  let clientToken = "";
  const authHeader = (request.headers.get("Authorization") || "").trim();
  if (authHeader) {
    clientToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : authHeader;
  }
  return clientToken === adminToken;
}

async function isCurrentLinkProjection(env, key, metadata) {
  if (!parseCanonicalLinkKey(key)) return false;
  const { binding } = await callLinkBinding(env, { action: "inspect", linkKey: key });
  return binding?.status === "BOUND" && Number.isSafeInteger(Number(metadata?.g)) &&
    Number(metadata.g) === binding.generation;
}

// GET: 単一キーの照会、または全キーの一覧取得
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!env?.CIVIDGE_KV) {
    return new Response(JSON.stringify({ error: "CIVIDGE_KV binding not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // 配信処理はこの API を経由せず Worker 内で KV を参照する。
  // パスワード hash / salt / セッション情報を含む管理メタデータを公開しない。
  if (!verifyAdminAuth(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized: Admin token required" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // key パラメータがない場合は、KV に登録されている全キーの一覧を返却（管理者のみ）
  if (!key) {
    if (!verifyAdminAuth(request, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized: Admin token required for listing keys" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const kv = env.CIVIDGE_KV;

    try {
      // See: [INV-LEDGER-002] (KV 走査における全件網羅 / 1,000 件制限の克服)
      let cursor = undefined;
      const allRawKeys = [];
      do {
        const page = await kv.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
        if (page.keys && page.keys.length > 0) {
          allRawKeys.push(...page.keys);
        }
        cursor = page.list_complete === false ? page.cursor : undefined;
      } while (cursor);

      const candidates = allRawKeys.filter(k => !k.name.startsWith("blob_") && !k.name.startsWith("config:"));
      const items = [];
      // This is an admin control-plane list, not public GET. Check the Link
      // authority in bounded batches so eventually consistent KV listings
      // cannot resurrect a retired generation.
      for (let offset = 0; offset < candidates.length; offset += 16) {
        const batch = candidates.slice(offset, offset + 16);
        const current = await Promise.all(batch.map(k => isCurrentLinkProjection(env, k.name, k.metadata)));
        for (let index = 0; index < batch.length; index++) {
          if (current[index]) items.push({ name: batch[index].name,
            metadata: unpackMetadata(batch[index].name, "", batch[index].metadata) });
        }
      }

      return new Response(JSON.stringify({ success: true, files: items }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    } catch (err) {
      console.warn("KV list error:", err.message);
      return new Response(JSON.stringify({ error: "Authoritative Link list unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  }

  // 2. key パラメータがある場合は単一照会
  try {
    const value = await env.CIVIDGE_KV.getWithMetadata(key);
    if (!value || value.value === null || value.value === undefined ||
        !(await isCurrentLinkProjection(env, key, value.metadata))) {
      return new Response(JSON.stringify({ found: false, key }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response(JSON.stringify({
      found: true,
      key,
      cid: value.value,
      metadata: unpackMetadata(key, value.value, value.metadata),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

// POST: キーと CID の登録（メタデータ対応）
export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env?.CIVIDGE_KV) {
    return new Response(JSON.stringify({ error: "CIVIDGE_KV binding not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // 🛡️ 管理者認証チェック（KV相乗り防止）
  if (!verifyAdminAuth(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized: Admin token required for KV registration" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // サーバー側サイズガード: クライアント側チェックのすり抜け防止
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > 80_000_000) {
    return new Response(JSON.stringify({ error: "File too large (Max: 80 MB)" }), {
      status: 413,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const body = await request.json();
    let { key, cid, size, mime, lastModified, password, dataBase64, ttl, expiresAt, thumbnailKey, width, height, contentCid, backend } = body;
    if ((Number.isFinite(Number(size)) && Number(size) > 80_000_000) ||
        (typeof dataBase64 === "string" && Math.floor(dataBase64.length * 3 / 4) > 80_000_000)) {
      return new Response(JSON.stringify({ error: "File too large (Max: 80 MB)" }), {
        status: 413,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const link = parseCanonicalLinkKey(key);
    if (!link) {
      return new Response(JSON.stringify({ error: "Missing 'key' in request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    key = link.key;

    // 既存のレコード・メタデータを事前に取得（パスワード・kuboStatus・allowedHost等の継承用）
    const bindingAtStart = (await callLinkBinding(env, { action: "inspect", linkKey: key })).binding;
    let existingMetadata = null;
    let existingValue = "";
    try {
      const existing = await env.CIVIDGE_KV.getWithMetadata(key);
      if (existing && bindingAtStart?.status === "BOUND" &&
          Number(existing.metadata?.g) === bindingAtStart.generation) {
        existingValue = existing.value || "";
        if (existing.metadata) existingMetadata = existing.metadata;
      }
    } catch (e) {}

    const existingCid = existingValue || (existingMetadata && (existingMetadata.c || existingMetadata.cid)) || "";
    // 🛡️ CID衝突ガード:
    // 同一ファイル名が既に存在し、かつ中身（実体CID）が異なる場合は上書き破壊を防ぐため409 Conflictで弾く。
    // ※ "r2" というマーカー値は IPFS CID ではないため、R2 のメタデータ更新や CID 同期時には衝突とみなさない。
    const existingRealCid = isRealIpfsCid(existingMetadata?.contentCid || existingMetadata?.c_cid)
      ? (existingMetadata?.contentCid || existingMetadata?.c_cid)
      : (isRealIpfsCid(existingCid) ? existingCid : "");
    const newRealCid = isRealIpfsCid(contentCid) ? contentCid : (isRealIpfsCid(cid) ? cid : "");

    if (existingRealCid && newRealCid && existingRealCid !== newRealCid) {
      return new Response(JSON.stringify({
        error: "Conflict: A different file with the same name already exists.",
        code: "CID_CONFLICT",
        existingCid: existingRealCid,
        newCid: newRealCid,
      }), {
        status: 409,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const safeCid = cid || existingCid || "";

    // パスワードが指定されている場合は PBKDF2 でハッシュ化
    let passwordMeta = {};
    if (password && typeof password === "string" && password.trim().length > 0) {
      const cleanPwd = password.trim();
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(cleanPwd),
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
      const saltHex = Array.from(saltBytes)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
      passwordMeta = {
        passwordHash: hashHex,
        passwordSalt: saltHex,
      };
    } else if (existingMetadata && existingMetadata.passwordHash) {
      passwordMeta = {
        passwordHash: existingMetadata.passwordHash,
        passwordSalt: existingMetadata.passwordSalt,
      };
    }

    // 有効期限の計算と明示的な解除（ttl: 0 または expiresAt: 0 で無期限化）
    let calculatedExpiresAt = null;
    // 期限は KV のネイティブ TTL には渡さない。
    // TTL に任せるとレコードだけが無通知で消え、配信時に「この CID の
    // 最後の別名だったか」を判定して Filebase/Kubo の pin を解放できなくなる。
    // delivery.js が期限後の最初のアクセスで expiresAt を確認して削除する。
    // ttl: 0 は「明示的に無期限へ変更」のときだけ期限を外す。
    // Filebase → Kubo のような保存先状態の更新では、継続時間を持たず ttl: 0 が
    // 渡されることがあるため、正の expiresAt があればそちらを最優先で維持する。
    if (expiresAt === 0 || body.clearTtl || (ttl === 0 && (expiresAt === undefined || expiresAt === null))) {
      calculatedExpiresAt = null;
    } else if (expiresAt && Number(expiresAt) > 0) {
      calculatedExpiresAt = Number(expiresAt);
    } else if (ttl && Number(ttl) > 0) {
      calculatedExpiresAt = Date.now() + Number(ttl) * 1000;
    } else if (existingMetadata && (existingMetadata.e || existingMetadata.expiresAt)) {
      calculatedExpiresAt = existingMetadata.e ? existingMetadata.e * 1000 : existingMetadata.expiresAt;
    }

    // 既存の kuboStatus を引き継ぐ、または body から取得
    let existingKuboStatus = body.kuboStatus;
    let existingLastKuboPinAttempt = body.lastKuboPinAttempt;
    let existingFlags = existingMetadata ? (existingMetadata.f || 0) : 0;
    if (existingKuboStatus === undefined && existingMetadata) {
      existingKuboStatus = existingMetadata.kuboStatus || (existingFlags & 2 ? "pinned" : (existingFlags & 4 ? "not_pinned" : undefined));
      existingLastKuboPinAttempt = existingMetadata.lastKuboPinAttempt || (existingMetadata.k ? existingMetadata.k * 1000 : undefined);
    }

    // 🗜️ 台帳データ圧縮（スカスカ化）:
    // フラグビット: 1 = unpinned (Filebase解放済み), 2 = kuboStatus:pinned, 4 = kuboStatus:not_pinned
    let flags = 0;
    const isUnpinned = Boolean(body.unpinned) || Boolean(existingFlags & 1);
    if (isUnpinned) flags |= 1;

    let finalKuboStatus = existingKuboStatus || (existingFlags & 2 ? "pinned" : (existingFlags & 4 ? "not_pinned" : null));
    if (finalKuboStatus === "pinned") flags |= 2;
    else if (finalKuboStatus === "not_pinned") flags |= 4;

    // The canonical key owns the Link's sole host.  Metadata cannot add peers.
    const allowedHost = link.host;

    // 圧縮メタデータオブジェクト（1レコード数十バイトに極小化）
    // c: cid, s: size, t: lastModified(秒), f: flags(ビット), e: expiresAt(秒), k: lastKuboPinAttempt(秒), d: allowedHost, w/h: image dimensions
    const inheritedSize = Number(size) || (existingMetadata && (existingMetadata.s || existingMetadata.size)) || 0;
    const inheritedS3Key = body.backend === "filebase_rpc" ? "" :
      (body.s3Key || (existingMetadata && (existingMetadata.k_s3 || existingMetadata.s3Key)) || key);
    const inheritedThumbnailKey = thumbnailKey || (existingMetadata && (existingMetadata.th || existingMetadata.thumbnailKey)) || "";
    const inheritedWidth = Math.floor(Number(width)) || (existingMetadata && Math.floor(Number(existingMetadata.w ?? existingMetadata.width))) || 0;
    const inheritedHeight = Math.floor(Number(height)) || (existingMetadata && Math.floor(Number(existingMetadata.h ?? existingMetadata.height))) || 0;
    const inheritedContentCid = body.contentCid || body.c_cid || (existingMetadata && (existingMetadata.c_cid || existingMetadata.contentCid)) || "";
    const inheritedBackend = body.backend || body.b || (existingMetadata && (existingMetadata.b || existingMetadata.backend)) || "";
    const civitaiTemporary = body.civitaiTemporary === undefined
      ? Boolean(existingMetadata?.ct || existingMetadata?.civitaiTemporary)
      : Boolean(body.civitaiTemporary);
    const lifecycle = objectRefForRegistration({
      backend: inheritedBackend,
      cid: safeCid,
      contentCid: inheritedContentCid,
      s3Key: inheritedS3Key,
      thumbnailKey: inheritedThumbnailKey,
      kuboStatus: finalKuboStatus,
    });
    if (existingMetadata) {
      const existingObject = objectRefForExisting(existingValue, existingMetadata);
      if (existingObject.objectRef !== lifecycle.objectRef) {
        return new Response(JSON.stringify({ error: "A Link cannot be reassigned to a different ObjectRef; remove it and create a new Link instead.", code: "OBJECT_REF_CONFLICT" }), {
          status: 409,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }
    const compressedMeta = {
      ...(safeCid ? { c: safeCid } : {}),
      s: inheritedSize,
      t: Math.floor((lastModified || Date.now()) / 1000),
      ...(flags > 0 ? { f: flags } : {}),
      ...(allowedHost ? { d: allowedHost } : {}),
      ...(inheritedS3Key ? { k_s3: inheritedS3Key } : {}),
      ...(inheritedThumbnailKey ? { th: inheritedThumbnailKey } : {}),
      ...(inheritedWidth > 0 && inheritedHeight > 0 ? { w: inheritedWidth, h: inheritedHeight } : {}),
      ...(calculatedExpiresAt ? { e: Math.floor(Number(calculatedExpiresAt) / 1000) } : {}),
      ...(existingLastKuboPinAttempt ? { k: Math.floor(Number(existingLastKuboPinAttempt) / 1000) } : {}),
      ...(inheritedContentCid ? { c_cid: inheritedContentCid } : {}),
      ...(inheritedBackend ? { b: inheritedBackend } : {}),
      ...(civitaiTemporary ? { ct: 1 } : {}),
      ...passwordMeta,
    };

    if (!existingMetadata) {
      const knownObject = (await callLifecycle(env, { action: "inspect", objectRef: lifecycle.objectRef })).lifecycle;
      if (!knownObject || !Object.values(knownObject.placements || {}).some(p => p.state === "PRESENT")) {
        return new Response(JSON.stringify({ error: "Object has no confirmed Placement", code: "PLACEMENT_NOT_PRESENT" }), {
          status: 409,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      if (inheritedBackend === "filebase_rpc" &&
          (knownObject.placements?.filebase_rpc?.state !== "PRESENT" ||
           knownObject.placements.filebase_rpc.provenance !== "cividge_worker_rpc")) {
        return new Response(JSON.stringify({ error: "Worker RPC Placement has no confirmed provenance", code: "PLACEMENT_NOT_PRESENT" }), {
          status: 409, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // The canonical Link key has its own uniqueness authority. KV is a
    // projection and cannot serialize two different ObjectRefs racing for it.
    const bindingAttemptId = body.uploadAttemptId || `peer:${lifecycle.objectRef}`;
    let binding;
    try {
      binding = (await callLinkBinding(env, {
        action: "reserve", linkKey: key, objectRef: lifecycle.objectRef,
        attemptId: bindingAttemptId,
      })).binding;
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code || "RESERVATION_CONFLICT" }), {
        status: error.status || 409,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (existingMetadata && body.createOnly && binding.status === "BOUND" && !binding.attempt) {
      return new Response(JSON.stringify({ success: true, noOp: true, key, objectRef: lifecycle.objectRef }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Authorize the Link relation before publishing the delivery projection.
    // If KV publication fails afterwards, a harmless orphan membership remains;
    // the reverse ordering could make a live URL invisible to lifecycle authority.
    let lifecycleState;
    if (existingMetadata) {
      const inspected = await callLifecycle(env, { action: "inspect", objectRef: lifecycle.objectRef });
      lifecycleState = inspected.lifecycle;
      if (!lifecycleState?.links?.includes(key)) {
        throw new Error("Existing delivery projection is not owned by lifecycle authority");
      }
    } else {
      lifecycleState = (await callLifecycle(env, {
        action: "createLink",
        objectRef: lifecycle.objectRef,
        linkKey: key,
        // A Link publication cannot assert physical provenance. Acquisition
        // must already have been confirmed by the lifecycle authority.
        placements: [],
        // Only an explicit storage upload / verified duplicate may attest that
        // a physical Placement is PRESENT again. Alias-only createLink calls
        // intentionally cannot resurrect a released Object.
        confirmedPlacements: [],
      })).lifecycle;
    }
    finalKuboStatus = lifecycleState?.placements?.kubo?.state === "PRESENT" ? "pinned" : "not_pinned";
    flags = finalKuboStatus === "pinned" ? ((flags | 2) & ~4) : ((flags | 4) & ~2);
    compressedMeta.f = flags;
    compressedMeta.kuboStatus = finalKuboStatus;
    compressedMeta.g = binding.generation;

    // KV に登録。期限はメタデータ e だけで管理する。公開GETはこのprojectionを
    // canonical keyで一回だけ読み、DOやstorageを参照しない。
    const putOptions = { metadata: compressedMeta };
    await env.CIVIDGE_KV.put(key, safeCid, putOptions);
    await callLinkBinding(env, { action: "commit", linkKey: key, attemptId: bindingAttemptId,
      generation: binding.attempt?.generation });

    // クライアント側へは旧形式互換のオブジェクトも含めて返却
    const returnedMeta = {
      cid: safeCid,
      size: compressedMeta.s,
      mime: mime || "",
      lastModified: compressedMeta.t * 1000,
      s3Key: body.s3Key || key,
      unpinned: Boolean(flags & 1),
      kuboStatus: finalKuboStatus,
      allowedHost: allowedHost || null,
      contentCid: inheritedContentCid || null,
      backend: inheritedBackend || null,
      ...(compressedMeta.w && compressedMeta.h ? { width: compressedMeta.w, height: compressedMeta.h } : {}),
      ...(calculatedExpiresAt ? { expiresAt: calculatedExpiresAt } : {}),
      ...(civitaiTemporary ? { civitaiTemporary: true, ct: 1 } : {}),
      ...compressedMeta,
    };

    // 🚀 URL再利用・即時反映: 直前までの404エッジキャッシュを即時パージ
    context.waitUntil?.(purgeHybridCache(request, env, key)) || purgeHybridCache(request, env, key);

    return new Response(JSON.stringify({ success: true, key, cid: safeCid, objectRef: lifecycle.objectRef, metadata: returnedMeta }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

// DELETE removes a Link projection only. It never authorizes physical cleanup.
export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!env?.CIVIDGE_KV) {
    return new Response(JSON.stringify({ error: "CIVIDGE_KV binding not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // 🛡️ 管理者認証チェック（KV相乗り防止）
  if (!verifyAdminAuth(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized: Admin token required for KV deletion" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  if (!key) {
    return new Response(JSON.stringify({ error: "Missing 'key' query parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const canonical = parseCanonicalLinkKey(key);
    if (!canonical) {
      return new Response(JSON.stringify({ error: "Invalid canonical Link key" }), {
        status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    const binding = (await callLinkBinding(env, { action: "inspect", linkKey: canonical.key })).binding;
    const expectedGeneration = url.searchParams.get("generation");
    if (expectedGeneration !== null && Number(expectedGeneration) !== binding?.generation) {
      return new Response(JSON.stringify({ error: "Link generation changed", code: "LINK_GENERATION_CONFLICT" }), {
        status: 409, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (!binding || binding.status === "RETIRED") {
      // A delayed KV view is not authority. Do not issue another KV delete:
      // a new explicit rebind may begin immediately after this observation.
      return new Response(JSON.stringify({ success: true, deletedKey: canonical.key, alreadyAbsent: true }), {
        status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (binding.status !== "BOUND" && binding.status !== "RETIRING") {
      return new Response(JSON.stringify({ error: "Link mutation is in progress", code: "LIFECYCLE_CONFLICT" }), {
        status: 409, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    const lifecycle = { objectRef: binding.objectRef };

    await callLinkBinding(env, { action: "beginRemove", linkKey: canonical.key });

    // The authority first marks the Link as retiring. It still counts as a
    // reference until KV deletion succeeds, so a partial failure cannot make
    // a publicly reachable Object eligible for physical release.
    await callLifecycle(env, { action: "beginRemoveLink", objectRef: lifecycle.objectRef, linkKey: canonical.key });
    try {
      await env.CIVIDGE_KV.delete(canonical.key);
    } catch (error) {
      return new Response(JSON.stringify({
        error: error.message,
        retryable: true,
        objectRef: lifecycle.objectRef,
        linkKey: canonical.key,
      }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    try {
      await callLifecycle(env, { action: "completeRemoveLink", objectRef: lifecycle.objectRef, linkKey: canonical.key });
    } catch (error) {
      // The delivery projection is already gone, but the authoritative Link
      // still counts as a reference until this transition succeeds. Return
      // enough canonical identity for an idempotent retry; never guess from
      // browser/local state.
      return new Response(JSON.stringify({
        error: error.message,
        retryable: true,
        projectionDeleted: true,
        objectRef: lifecycle.objectRef,
        linkKey: canonical.key,
      }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    await callLinkBinding(env, { action: "completeRemove", linkKey: canonical.key });

    // 🚀 リンク抹消: エッジに残っている画像キャッシュを即座に消滅させる
    context.waitUntil?.(purgeHybridCache(request, env, canonical.key)) || purgeHybridCache(request, env, canonical.key);

    return new Response(JSON.stringify({ success: true, deletedKey: canonical.key, objectRef: lifecycle.objectRef }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

// 🌐 ハイブリッド Cache Purge ヘルパー
// プランA (独自ドメイン設定時): REST Purge API で世界300箇所の全エッジから即時抹消
// プランB (pages.dev無料運用時): Cache API (caches.default) でローカルPoPから即時抹消
// Zone API の対象はcanonical Link hostと明示設定のrelayだけに限定する。
async function purgeHybridCache(request, env, key) {
  if (!key) return;
  const colonIdx = key.indexOf(":");
  const pureFilename = colonIdx > 0 ? key.substring(colonIdx + 1) : key;
  const keyHost = colonIdx > 0 ? key.substring(0, colonIdx) : null;

  const targetPath = `/${encodeURIComponent(pureFilename)}`;
  
  const targetDomains = new Set();
  if (keyHost) {
    targetDomains.add(`https://${keyHost}`);
  }
  
  const urlsToPurge = Array.from(targetDomains).map(origin => `${origin}${targetPath}`);

  // 静的 Pages 公開入口は /<file> -> 独自ゾーンの /r/<file> へ送る。
  // Zone Purge API へは、そのゾーンに属する実配信 URL だけを渡す。
  const backendRelayOrigins = String(env.STATIC_RELAY_BACKEND_HOSTS || "")
    .split(",")
    .map(host => host.trim())
    .filter(Boolean)
    .map(host => host.startsWith("http") ? host : `https://${host}`)
    .map(host => {
      try { return new URL(host).origin; } catch (e) { return null; }
    })
    .filter(Boolean);
  const relayHosts = String(env.STATIC_RELAY_PUBLIC_HOSTS || "")
    .split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  const encodedFile = encodeURIComponent(pureFilename);
  const relayTargetPaths = keyHost && relayHosts.includes(keyHost)
    ? [
        `/r/${keyHost.split(".")[0]}/${encodedFile}`,
        `/r/${keyHost}/${encodedFile}`,
      ]
    : [];
  const globalUrlsToPurge = backendRelayOrigins.flatMap(origin =>
    relayTargetPaths.map(path => `${origin}${path}`)
  );

  // Cache API でも実配信 URL を削除する。これは現在の PoP 限定の補助策。
  urlsToPurge.push(...globalUrlsToPurge);

  // 1. プランA: REST Purge API (独自ドメインの Zone ID & API Token がある場合)
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  const purgeToken = env.CLOUDFLARE_PURGE_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (zoneId && purgeToken) {
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${purgeToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: globalUrlsToPurge }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.success !== true) {
        console.warn(`REST Purge API failed (${response.status}):`, result || "invalid JSON response");
      }
    } catch (apiErr) {
      console.warn("REST Purge API error:", apiErr);
    }
  }

  // 2. プランB: Cache API (caches.default.delete) - pages.dev 環境でも動作
  try {
    if (typeof caches !== "undefined" && caches.default) {
      for (const u of urlsToPurge) {
        await caches.default.delete(u).catch(() => {});
      }
    }
  } catch (cacheErr) {
    console.warn("Cache API delete error:", cacheErr);
  }
}
