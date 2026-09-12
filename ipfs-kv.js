// functions/api/ipfs-kv.js
// Cloudflare Pages Function: ファイル名と IPFS CID の KV 登録・照会・削除・一覧 API

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
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
  if (colonIdx > 0 && !name.startsWith("tombstone_") && !name.startsWith("blob_")) {
    keyHost = name.substring(0, colonIdx);
    displayName = name.substring(colonIdx + 1);
  }

  const s3Key = meta.k_s3 || meta.s3Key || displayName;
  const lastKuboPinAttempt = meta.k !== undefined ? meta.k * 1000 : (meta.lastKuboPinAttempt || null);

  const allowedHost = keyHost || meta.d || meta.allowedHost || null;

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
    ...(allowedHost ? { allowedHost, d: allowedHost } : {}),
    ...(expiresAt ? { expiresAt, e: Math.floor(expiresAt / 1000) } : {}),
    ...(lastKuboPinAttempt ? { lastKuboPinAttempt } : {}),
  };
}

// 投稿・一覧・削除の管理者認証検証（KV相乗り防止・責任分離）
function verifyAdminAuth(request, env) {
  const adminToken = (env.ADMIN_API_TOKEN || env.API_TOKEN || "").trim();
  if (!adminToken) return true; // 環境変数未設定の場合はローカル/オープン動作

  let clientToken = "";
  const authHeader = (request.headers.get("Authorization") || "").trim();
  if (authHeader) {
    clientToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : authHeader;
  }
  if (!clientToken) {
    const url = new URL(request.url);
    clientToken = (url.searchParams.get("admin_token") || url.searchParams.get("token") || "").trim();
  }
  return clientToken === adminToken;
}

// GET: 単一キーの照会、または全キーの一覧取得
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!env || !env.IPFS_KV) {
    return new Response(JSON.stringify({ error: "IPFS_KV binding not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // 0. tombstones パラメータがある場合は未回収の墓標（アンピン予約）一覧を返却（管理者のみ）
  if (url.searchParams.get("tombstones") === "1") {
    if (!verifyAdminAuth(request, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized: Admin token required" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    try {
      const list = await env.IPFS_KV.list({ prefix: "tombstone_", limit: 1000 });
      const tombstones = (list.keys || []).map(k => k.name.replace(/^tombstone_/, ""));
      return new Response(JSON.stringify({ success: true, tombstones }), {
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

  // 1. key パラメータがない場合は、KV に登録されている全キーの一覧を返却（管理者のみ）
  if (!key) {
    if (!verifyAdminAuth(request, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized: Admin token required for listing keys" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    try {
      const list = await env.IPFS_KV.list({ limit: 1000 });
      const items = (list.keys || [])
        .filter(k => !k.name.startsWith("tombstone_") && !k.name.startsWith("blob_"))
        .map(k => ({
          name: k.name,
          metadata: unpackMetadata(k.name, "", k.metadata),
        }));
      return new Response(JSON.stringify({ success: true, files: items }), {
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

  // 2. key パラメータがある場合は単一照会
  try {
    const value = await env.IPFS_KV.getWithMetadata(key);
    if (!value || !value.value) {
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

  if (!env || !env.IPFS_KV) {
    return new Response(JSON.stringify({ error: "IPFS_KV binding not configured" }), {
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
  if (contentLength && parseInt(contentLength, 10) > 80 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: "File too large (Max: 80MB)" }), {
      status: 413,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const body = await request.json();
    const { key, cid, size, mime, lastModified, password, dataBase64, ttl, expiresAt } = body;

    if (!key) {
      return new Response(JSON.stringify({ error: "Missing 'key' in request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 既存のレコード・メタデータを事前に取得（パスワード・kuboStatus・allowedHost等の継承用）
    let existingMetadata = null;
    let existingValue = "";
    try {
      const existing = await env.IPFS_KV.getWithMetadata(key);
      if (existing) {
        existingValue = existing.value || "";
        if (existing.metadata) existingMetadata = existing.metadata;
      }
    } catch (e) {}

    const existingCid = existingValue || (existingMetadata && (existingMetadata.c || existingMetadata.cid)) || "";

    // 🛡️ CID衝突ガード:
    // 同一ファイル名が既に存在し、かつ中身（CID）が異なる場合は上書き破壊を防ぐため409 Conflictで弾く
    if (existingCid && cid && existingCid !== cid) {
      return new Response(JSON.stringify({
        error: "Conflict: A different file with the same name already exists.",
        code: "CID_CONFLICT",
        existingCid,
        newCid: cid,
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
      const sessionSecret = "sec_" + Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

      passwordMeta = {
        passwordHash: hashHex,
        passwordSalt: saltHex,
        sessionSecret,
      };
    } else if (existingMetadata && existingMetadata.passwordHash) {
      passwordMeta = {
        passwordHash: existingMetadata.passwordHash,
        passwordSalt: existingMetadata.passwordSalt,
        sessionSecret: existingMetadata.sessionSecret,
      };
    }

    // 有効期限の計算と明示的な解除（ttl: 0 または expiresAt: 0 で無期限化）
    let calculatedExpiresAt = null;
    let putExpirationTtl = undefined;
    if (expiresAt === 0 || ttl === 0 || expiresAt === null && body.clearTtl) {
      calculatedExpiresAt = null;
    } else if (expiresAt && Number(expiresAt) > 0) {
      calculatedExpiresAt = Number(expiresAt);
      const remainingSec = Math.floor((calculatedExpiresAt - Date.now()) / 1000);
      if (remainingSec > 60) putExpirationTtl = remainingSec;
    } else if (ttl && Number(ttl) > 0) {
      calculatedExpiresAt = Date.now() + Number(ttl) * 1000;
      putExpirationTtl = Math.max(60, Number(ttl));
    } else if (existingMetadata && (existingMetadata.e || existingMetadata.expiresAt)) {
      calculatedExpiresAt = existingMetadata.e ? existingMetadata.e * 1000 : existingMetadata.expiresAt;
      const remainingSec = Math.floor((calculatedExpiresAt - Date.now()) / 1000);
      if (remainingSec > 60) putExpirationTtl = remainingSec;
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

    const finalKuboStatus = existingKuboStatus || (existingFlags & 2 ? "pinned" : (existingFlags & 4 ? "not_pinned" : null));
    if (finalKuboStatus === "pinned") flags |= 2;
    else if (finalKuboStatus === "not_pinned") flags |= 4;

    // 🌐 配信ドメイン制限 (allowedHost / domain):
    // カンマ区切りの複数ドメイン対応（同一CIDであれば複数ドメインでの配信を統合許可）
    const normalizeDomainList = (val) => {
      if (!val) return [];
      const arr = Array.isArray(val) ? val : String(val).split(",");
      return arr.map(h => String(h).trim().toLowerCase().replace(/^https?:\/\//, "").split('/')[0].split(':')[0]).filter(Boolean);
    };

    let allowedHost = null;
    const incomingDomains = normalizeDomainList(body.allowedHost || body.domain || body.d);
    const existingDomains = normalizeDomainList(existingMetadata && (existingMetadata.d || existingMetadata.allowedHost));

    if (incomingDomains.length > 0) {
      if (body.overwriteAllowedHost) {
        // プルダウンでの切り替えなど、明示的なドメイン上書き指定の場合
        allowedHost = incomingDomains.join(",");
      } else {
        // 既存のドメインと新規ドメインを統合（同一CIDなら同一ファイル名のまま複数ドメインからの配信を許容）
        const mergedDomains = [...new Set([...existingDomains, ...incomingDomains])];
        allowedHost = mergedDomains.join(",");
      }
    } else if (existingDomains.length > 0) {
      allowedHost = existingDomains.join(",");
    }

    // 圧縮メタデータオブジェクト（1レコード数十バイトに極小化）
    // c: cid, s: size, t: lastModified(秒), f: flags(ビット), e: expiresAt(秒), k: lastKuboPinAttempt(秒), d: allowedHost
    const inheritedSize = Number(size) || (existingMetadata && (existingMetadata.s || existingMetadata.size)) || 0;
    const inheritedS3Key = body.s3Key || (existingMetadata && (existingMetadata.k_s3 || existingMetadata.s3Key)) || key;
    const compressedMeta = {
      ...(safeCid ? { c: safeCid } : {}),
      s: inheritedSize,
      t: Math.floor((lastModified || Date.now()) / 1000),
      ...(flags > 0 ? { f: flags } : {}),
      ...(allowedHost ? { d: allowedHost } : {}),
      ...(inheritedS3Key && inheritedS3Key !== key ? { k_s3: inheritedS3Key } : {}),
      ...(calculatedExpiresAt ? { e: Math.floor(Number(calculatedExpiresAt) / 1000) } : {}),
      ...(existingLastKuboPinAttempt ? { k: Math.floor(Number(existingLastKuboPinAttempt) / 1000) } : {}),
      ...passwordMeta,
    };

    // KV に登録 (value: safeCid, metadata, expirationTtl)
    const putOptions = { metadata: compressedMeta };
    if (putExpirationTtl && putExpirationTtl > 0) {
      putOptions.expirationTtl = putExpirationTtl;
    }
    await env.IPFS_KV.put(key, safeCid, putOptions);

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
      ...(calculatedExpiresAt ? { expiresAt: calculatedExpiresAt } : {}),
      ...compressedMeta,
    };

    // 🚀 URL再利用・即時反映: 直前までの404エッジキャッシュを即時パージ
    const extraDomainsToPurge = allowedHost ? allowedHost.split(",") : [];
    context.waitUntil?.(purgeHybridCache(request, env, key, extraDomainsToPurge)) || purgeHybridCache(request, env, key, extraDomainsToPurge);

    return new Response(JSON.stringify({ success: true, key, cid: safeCid, metadata: returnedMeta }), {
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

// DELETE: キーの削除（リンク抹消 / 遮断）および 墓標（アンピン予約）の回収
export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const tombstoneCid = url.searchParams.get("tombstone");

  if (!env || !env.IPFS_KV) {
    return new Response(JSON.stringify({ error: "IPFS_KV binding not configured" }), {
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

  // 1. 墓標の回収完了（KuboでのUnpin完了通知）
  if (tombstoneCid) {
    try {
      await env.IPFS_KV.delete("tombstone_" + tombstoneCid);
      return new Response(JSON.stringify({ success: true, clearedTombstone: tombstoneCid }), {
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

  if (!key) {
    return new Response(JSON.stringify({ error: "Missing 'key' or 'tombstone' query parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const existing = await env.IPFS_KV.getWithMetadata(key);
    const existingCid = existing?.value || "";

    if (existing?.metadata?.blobKey) {
      await env.IPFS_KV.delete(existing.metadata.blobKey).catch(() => {});
    } else {
      await env.IPFS_KV.delete("blob_" + key).catch(() => {});
    }
    await env.IPFS_KV.delete(key);

    // 🪦 墓標（Tombstone / Unpin予約）の発行判定:
    // CID が存在する場合、他のキーが同じ CID を参照していなければ、将来 Kubo 起動時にアンピンできるよう墓標を登録
    if (existingCid) {
      const allKeys = await env.IPFS_KV.list({ limit: 1000 });
      const isCidShared = (allKeys.keys || []).some(k => {
        if (k.name === key || k.name.startsWith("tombstone_") || k.name.startsWith("blob_")) return false;
        // metadata に CID (cid または c) が入っているか、あるいは同一実体キーか判定
        const itemCid = k.metadata?.cid || k.metadata?.c;
        return itemCid === existingCid;
      });

      if (!isCidShared) {
        // 30日間のTTLを設定して墓標を保存
        await env.IPFS_KV.put("tombstone_" + existingCid, "1", {
          expirationTtl: 86400 * 30,
        }).catch(() => {});
      }
    }

    // 🚀 リンク抹消: エッジに残っている画像キャッシュを即座に消滅させる
    const deleteExtraDomains = existing?.metadata?.d || existing?.metadata?.allowedHost ? (existing.metadata.d || existing.metadata.allowedHost).split(",") : [];
    context.waitUntil?.(purgeHybridCache(request, env, key, deleteExtraDomains)) || purgeHybridCache(request, env, key, deleteExtraDomains);

    return new Response(JSON.stringify({ success: true, deletedKey: key }), {
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
// ※ 開発者や特定ドメインを特別扱いせず、Request Origin / Referer / allowedHost から100%動的に解決
async function purgeHybridCache(request, env, key, extraDomains = []) {
  if (!key) return;
  const colonIdx = key.indexOf(":");
  const pureFilename = (colonIdx > 0 && !key.startsWith("tombstone_") && !key.startsWith("blob_")) ? key.substring(colonIdx + 1) : key;
  const keyHost = (colonIdx > 0 && !key.startsWith("tombstone_") && !key.startsWith("blob_")) ? key.substring(0, colonIdx) : null;

  const reqUrl = new URL(request.url);
  const targetPath = `/${encodeURIComponent(pureFilename)}`;
  
  const targetDomains = new Set();
  if (keyHost) {
    targetDomains.add(`https://${keyHost}`);
  }
  
  // 1. リクエスト自体のオリジン
  if (reqUrl.origin) {
    targetDomains.add(reqUrl.origin);
  }
  
  // 2. クライアント側の Origin / Referer ヘッダー（フロントエンドのドメイン）
  const originHeader = request.headers.get("origin");
  if (originHeader) {
    try { targetDomains.add(new URL(originHeader).origin); } catch (e) {}
  }
  const refererHeader = request.headers.get("referer");
  if (refererHeader) {
    try { targetDomains.add(new URL(refererHeader).origin); } catch (e) {}
  }
  
  // 3. 引数で渡されたドメイン（allowedHost や body からの指定）
  for (const d of extraDomains) {
    if (!d) continue;
    const clean = String(d).trim().toLowerCase();
    const withProto = clean.startsWith("http") ? clean : `https://${clean}`;
    try { targetDomains.add(new URL(withProto).origin); } catch (e) {}
  }

  // 4. 環境変数でパージ対象ドメインが指定されている場合（PURGE_DOMAINS=domain1.com,domain2.pages.dev）
  if (env.PURGE_DOMAINS) {
    const customList = String(env.PURGE_DOMAINS).split(",").map(s => s.trim()).filter(Boolean);
    for (const d of customList) {
      const withProto = d.startsWith("http") ? d : `https://${d}`;
      try { targetDomains.add(new URL(withProto).origin); } catch (e) {}
    }
  }

  const urlsToPurge = Array.from(targetDomains).map(origin => `${origin}${targetPath}`);

  // 1. プランA: REST Purge API (独自ドメインの Zone ID & API Token がある場合)
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  const purgeToken = env.CLOUDFLARE_PURGE_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (zoneId && purgeToken) {
    try {
      await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${purgeToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: urlsToPurge }),
      });
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
