import * as cividgeKv from "./cividge-kv.js";
import * as lifecycleApi from "./lifecycle-api.js";
import * as uploadApi from "./upload.js";
import { onRequest as onDelivery } from "./delivery.js";
import { handleGatewayConfig } from "./gateway-config-api.js";
import * as linkBindingApi from "./link-binding-api.js";
export { ObjectLifecycle } from "./lifecycle.js";
export { LinkBinding } from "./link-binding.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, If-Range, X-Upload-Password, X-Upload-Filename, X-Custom-Domain, X-Delivery-Domain, X-Storage-Backend",
          "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, X-Image-Width, X-Image-Height",
        },
      });
    }

    if (pathname === "/api/upload" || pathname.startsWith("/api/upload?")) {
      const context = { request, env, waitUntil: (p) => ctx.waitUntil(p), next: () => new Response("404", { status: 404 }) };
      let res;
      if (request.method === "POST") res = await uploadApi.onRequestPost(context);
      else if (request.method === "GET") res = await uploadApi.onRequestGet(context);
      else if (request.method === "OPTIONS") res = await uploadApi.onRequestOptions();
      else res = new Response("Method Not Allowed", { status: 405 });

      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      // Workers Cache を有効にしても、管理・投稿 API の応答は絶対に共有
      // キャッシュへ保存しない。
      headers.set("Cache-Control", "no-store");
      return new Response(res.body, { status: res.status, headers });
    }

    if (pathname === "/api/gateway-config") return handleGatewayConfig(request, env);

    if (pathname === "/api/link-binding" && request.method === "POST") {
      return linkBindingApi.onRequestPost({ request, env });
    }

    if (pathname === "/api/lifecycle") {
      const res = request.method === "POST"
        ? await lifecycleApi.onRequestPost({ request, env })
        : new Response("Method Not Allowed", { status: 405 });
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "no-store");
      return new Response(res.body, { status: res.status, headers });
    }

    // Canonical control-plane endpoint for delivery projection mutations.
    const isKvApi = pathname === "/api/cividge-kv" || pathname.startsWith("/api/cividge-kv?");
    if (isKvApi) {
      const context = { request, env, waitUntil: (p) => ctx.waitUntil(p), next: () => new Response("404", { status: 404 }) };
      let res;
      if (request.method === "GET") res = await cividgeKv.onRequestGet(context);
      else if (request.method === "POST") res = await cividgeKv.onRequestPost(context);
      else if (request.method === "DELETE") res = await cividgeKv.onRequestDelete(context);
      else res = new Response("Method Not Allowed", { status: 405 });

      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "no-store");
      return new Response(res.body, { status: res.status, headers });
    }

    const deliveryContext = { request, env, waitUntil: (p) => ctx.waitUntil(p), next: () => new Response("404 Not Found - Cividge KV Worker", { status: 404 }) };
    return await onDelivery(deliveryContext);
  }
};

