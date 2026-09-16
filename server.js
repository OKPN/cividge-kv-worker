import * as ipfsKv from "./ipfs-kv.js";
import * as uploadApi from "./upload.js";
import { onRequest as onDelivery } from "./delivery.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS, HEAD",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, If-Range, X-Upload-Password, X-Upload-Filename, X-Custom-Domain, X-Delivery-Domain, X-Storage-Backend",
          "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, X-Image-Width, X-Image-Height",
        },
      });
    }

    if (pathname === "/api/upload" || pathname.startsWith("/api/upload?")) {
      const context = { request, env, waitUntil: (p) => ctx.waitUntil(p), next: () => new Response("404", { status: 404 }) };
      let res;
      if (request.method === "POST") res = await uploadApi.onRequestPost(context);
      else if (request.method === "OPTIONS") res = await uploadApi.onRequestOptions();
      else res = new Response("Method Not Allowed", { status: 405 });

      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(res.body, { status: res.status, headers });
    }

    if (pathname === "/api/ipfs-kv" || pathname.startsWith("/api/ipfs-kv?")) {
      const context = { request, env, waitUntil: (p) => ctx.waitUntil(p), next: () => new Response("404", { status: 404 }) };
      let res;
      if (request.method === "GET") res = await ipfsKv.onRequestGet(context);
      else if (request.method === "POST") res = await ipfsKv.onRequestPost(context);
      else if (request.method === "DELETE") res = await ipfsKv.onRequestDelete(context);
      else res = new Response("Method Not Allowed", { status: 405 });

      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(res.body, { status: res.status, headers });
    }

    const deliveryContext = { request, env, waitUntil: (p) => ctx.waitUntil(p), next: () => new Response("404 Not Found - Cividge KV Worker", { status: 404 }) };
    return await onDelivery(deliveryContext);
  }
};

