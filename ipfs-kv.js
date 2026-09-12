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
  const s3Key = meta.k_s3 || meta.s3Key || name;
  const lastKuboPinAttempt = meta.k !== undefined ? meta.k * 1000 : (meta.lastKuboPinAttempt || null);

  return {
    ...meta,
    cid: cid || meta.cid || meta.c || "",
    size,
    s: size,
    lastModified,
    t: Math.floor(lastModified / 1000),
    unpinned: isUnpinned,
    kuboStatus,
    s3Key,
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

    const safeCid = cid || "";

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
    } else {
      // パスワードが未指定の場合、既存レコードのパスワード設定を維持する
      try {
        const existing = await env.IPFS_KV.getWithMetadata(key);
        if (existing && existing.metadata && existing.metadata.passwordHash) {
          passwordMeta = {
            passwordHash: existing.metadata.passwordHash,
            passwordSalt: existing.metadata.passwordSalt,
            sessionSecret: existing.metadata.sessionSecret,
          };
        }
      } catch (e) {}
    }

    const calculatedExpiresAt = expiresAt || (ttl && Number(ttl) > 0 ? Date.now() + Number(ttl) * 1000 : null);

    // 既存の kuboStatus を引き継ぐ、または body から取得
    let existingKuboStatus = body.kuboStatus;
    let existingLastKuboPinAttempt = body.lastKuboPinAttempt;
    let existingFlags = 0;
    if (existingKuboStatus === undefined) {
      try {
        const existing = await env.IPFS_KV.getWithMetadata(key);
        if (existing && existing.metadata) {
          const m = existing.metadata;
          existingKuboStatus = m.kuboStatus || (m.f & 2 ? "pinned" : (m.f & 4 ? "not_pinned" : undefined));
          existingLastKuboPinAttempt = m.lastKuboPinAttempt || (m.k ? m.k * 1000 : undefined);
          existingFlags = m.f || 0;
        }
      } catch (e) {}
    }

    // 🗜️ 台帳データ圧縮（スカスカ化）:
    // フラグビット: 1 = unpinned (Filebase解放済み), 2 = kuboStatus:pinned, 4 = kuboStatus:not_pinned
    let flags = 0;
    const isUnpinned = Boolean(body.unpinned) || Boolean(existingFlags & 1);
    if (isUnpinned) flags |= 1;

    const finalKuboStatus = existingKuboStatus || (existingFlags & 2 ? "pinned" : (existingFlags & 4 ? "not_pinned" : null));
    if (finalKuboStatus === "pinned") flags |= 2;
    else if (finalKuboStatus === "not_pinned") flags |= 4;

    // 圧縮メタデータオブジェクト（1レコード数十バイトに極小化）
    // c: cid, s: size, t: lastModified(秒), f: flags(ビット), e: expiresAt(秒), k: lastKuboPinAttempt(秒)
    const compressedMeta = {
      ...(safeCid ? { c: safeCid } : {}),
      s: Number(size) || 0,
      t: Math.floor((lastModified || Date.now()) / 1000),
      ...(flags > 0 ? { f: flags } : {}),
      ...(body.s3Key && body.s3Key !== key ? { k_s3: body.s3Key } : {}),
      ...(calculatedExpiresAt ? { e: Math.floor(Number(calculatedExpiresAt) / 1000) } : {}),
      ...(existingLastKuboPinAttempt ? { k: Math.floor(Number(existingLastKuboPinAttempt) / 1000) } : {}),
      ...passwordMeta,
    };

    // KV に登録 (value: safeCid, metadata, expirationTtl)
    const putOptions = { metadata: compressedMeta };
    if (ttl && Number(ttl) > 0) {
      putOptions.expirationTtl = Math.max(60, Number(ttl));
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
      ...(calculatedExpiresAt ? { expiresAt: calculatedExpiresAt } : {}),
      ...compressedMeta,
    };

    // 🚀 URL再利用・即時反映: 直前までの404エッジキャッシュを即時パージ
    context.waitUntil?.(purgeHybridCache(request, env, key)) || purgeHybridCache(request, env, key);

    return new Response(JSON.stringify({ success: true, key, cid: safeCid, metadata }), {
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
    context.waitUntil?.(purgeHybridCache(request, env, key)) || purgeHybridCache(request, env, key);

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
async function purgeHybridCache(request, env, key) {
  if (!key) return;
  const reqUrl = new URL(request.url);
  const targetPath = `/${encodeURIComponent(key)}`;
  const targetUrl = `${reqUrl.origin}${targetPath}`;

  // content-relay および content-cache ドメインのURLも対象に含める
  const urlsToPurge = [targetUrl];
  if (!reqUrl.hostname.includes("content-relay")) {
    urlsToPurge.push(`https://content-relay.pages.dev${targetPath}`);
  }
  if (!reqUrl.hostname.includes("content-cache")) {
    urlsToPurge.push(`https://content-cache.pages.dev${targetPath}`);
  }

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
