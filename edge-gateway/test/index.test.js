import assert from "node:assert/strict";
import test from "node:test";
import worker, { internals } from "../src/index.js";

function context() {
  const promises = [];
  return { promises, waitUntil(promise) { promises.push(promise); } };
}

function environment(overrides = {}) {
  return {
    ADMIN_PATH_TOKEN: "test-admin-token",
    ORIGIN_SHARED_SECRET: "test-origin-secret",
    SERVICE_VERSION: "test",
    ORIGIN: { fetch: (...args) => globalThis.fetch(...args) },
    API_RATE_LIMITER: { async limit() { return { success: true }; } },
    ...overrides,
  };
}

test("cache TTLs cover stable reads and validated segment POSTs", () => {
  assert.equal(internals.cacheTtl("/api/v2/comment/1", "GET"), 1800);
  assert.equal(internals.cacheTtl("/api/v2/search/anime", "GET"), 600);
  assert.equal(internals.cacheTtl("/api/v2/segmentcomment", "POST"), 1800);
  assert.equal(internals.cacheTtl("/api/v2/match", "POST"), 0);
});

test("canonical cache key sorts query parameters", () => {
  const result = internals.canonicalUrl(new URL("https://danmu.oyo131.xyz/api/v2/search/anime?z=2&a=1"));
  assert.equal(result.href, "https://cache.invalid/api/v2/search/anime?a=1&z=2");
  assert.equal(
    internals.staleCacheKey(new URL("https://danmu.oyo131.xyz/api/v2/search/anime?z=2&a=1")).url,
    "https://stale.cache.invalid/api/v2/search/anime?a=1&z=2",
  );
});

test("segment POST cache keys hash the validated body without exposing it", async () => {
  const url = new URL("https://danmu.oyo131.xyz/api/v2/segmentcomment?format=json");
  const firstBody = JSON.stringify({ type: "qq", url: "https://dm.video.qq.com/barrage/a" });
  const secondBody = JSON.stringify({ type: "qq", url: "https://dm.video.qq.com/barrage/b" });
  const first = await internals.requestCacheKey(url, "POST", firstBody);
  const same = await internals.requestCacheKey(url, "POST", firstBody);
  const second = await internals.requestCacheKey(url, "POST", secondBody);

  assert.equal(first.url, same.url);
  assert.notEqual(first.url, second.url);
  assert.equal(first.method, "GET");
  assert.match(first.url, /__edge_cache_version=2/);
  assert.match(first.url, /__request_body_sha256=[a-f0-9]{64}/);
  assert.equal(first.url.includes(encodeURIComponent(firstBody)), false);
});

test("media URL validation permits known services and blocks private origins", () => {
  assert.equal(internals.validateMediaUrl("https://v.qq.com/x/cover/test.html"), true);
  assert.equal(internals.validateMediaUrl("https://www.bilibili.com/video/BV1xx"), true);
  assert.equal(internals.validateMediaUrl("https://www.nicovideo.jp/watch/sm9"), true);
  assert.equal(internals.validateMediaUrl("https://api5-normal-sinfonlinea.fqnovel.com/video/1"), false);
  assert.equal(internals.validateMediaUrl("https://attacker.example/proxy"), false);
  assert.equal(internals.validateMediaUrl("http://127.0.0.1:9321/private"), false);
  assert.equal(internals.validateMediaUrl("http://169.254.169.254/latest/meta-data"), false);
});

test("segment validation accepts supported opaque IDs but rejects proxy schemes", () => {
  assert.equal(internals.validateSegmentTarget("acfun", "acfun:38400001:0:60000"), true);
  assert.equal(internals.validateSegmentTarget("hongguo", "hongguo:v1:123:456:90#segment=0"), true);
  assert.equal(internals.validateSegmentTarget("dandan", "12345"), true);
  assert.equal(internals.validateSegmentTarget("niconico", "niconico:sm9"), true);
  assert.equal(internals.validateSegmentTarget("qq", "https://dm.video.qq.com/barrage/test"), true);
  assert.equal(internals.validateSegmentTarget("qq", "http://127.0.0.1/private"), false);
  assert.equal(internals.validateSegmentTarget("unknown", "https://v.qq.com/video"), false);
  assert.equal(internals.validateSegmentTarget("custom", "file:///etc/passwd"), false);
});

test("root is an edge-local status response", async () => {
  const response = await worker.fetch(new Request("https://danmu.oyo131.xyz/"), environment(), context());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, "oyo-danmu-api");
});

test("management endpoints never reach the origin", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("origin should not be called"); };
  try {
    const response = await worker.fetch(new Request("https://danmu.oyo131.xyz/api/logs"), environment(), context());
    assert.equal(response.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the secret management path proxies the UI without cache or cross-origin access", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let captured;
  let cacheTouched = false;
  globalThis.caches = { default: {
    async match() { cacheTouched = true; throw new Error("management cache lookup should not run"); },
    async put() { cacheTouched = true; throw new Error("management cache write should not run"); },
  } };
  globalThis.fetch = async (request) => {
    captured = request;
    return new Response("<!doctype html><title>LogVar弹幕API</title>", {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "access-control-allow-origin": "*",
        "set-cookie": "admin=should-not-leave-origin",
      },
    });
  };
  try {
    const response = await worker.fetch(
      new Request("https://danmu.oyo131.xyz/test-admin-token"),
      environment(),
      context(),
    );
    assert.equal(captured.url, "http://danmu.internal/test-admin-token");
    assert.match(await response.text(), /LogVar弹幕API/);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(response.headers.get("x-edge-cache"), "BYPASS");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(cacheTouched, false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("nested management APIs proxy only below the secret path", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const captured = [];
  globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
  globalThis.fetch = async (request) => {
    captured.push(request.url);
    return Response.json({ success: true });
  };
  try {
    const allowed = await worker.fetch(
      new Request("https://danmu.oyo131.xyz/test-admin-token/api/config"),
      environment(),
      context(),
    );
    const denied = await worker.fetch(
      new Request("https://danmu.oyo131.xyz/wrong-admin-token/api/config"),
      environment(),
      context(),
    );
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("x-edge-cache"), "BYPASS");
    assert.equal(denied.status, 404);
    assert.deepEqual(captured, ["http://danmu.internal/test-admin-token/api/config"]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("the public route allow-list covers clients without exposing UI or management APIs", () => {
  assert.equal(internals.isPublicRoute("/api/v2/search/anime", "GET"), true);
  assert.equal(internals.isPublicRoute("/api/v2/comment/123", "GET"), true);
  assert.equal(internals.isPublicRoute("/api/v2/segmentcomment", "POST"), true);
  assert.equal(internals.isPublicRoute("/api/v2/fongmi/danmaku", "POST"), true);
  assert.equal(internals.isPublicRoute("/danmaku", "GET"), true);
  assert.equal(internals.isPublicRoute("/danmaku/api/v2/fongmi/danmaku", "GET"), true);
  assert.equal(internals.isPublicRoute("/api/v2/favorite/list", "GET"), false);
  assert.equal(internals.isPublicRoute("/ui/js/main.js", "GET"), false);
  assert.equal(internals.isPublicRoute("/api/v2/search/anime", "POST"), false);
});

test("proxy authenticates to the fixed origin and preserves the client IP", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let captured;
  globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
  globalThis.fetch = async (request) => {
    captured = request;
    return new Response(JSON.stringify({ comments: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const ctx = context();
    const response = await worker.fetch(new Request("https://danmu.oyo131.xyz/api/v2/comment/1", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), environment(), ctx);
    await Promise.all(ctx.promises);
    assert.equal(captured.url, "http://danmu.internal/api/v2/comment/1");
    assert.equal(captured.headers.get("x-danmu-origin-auth"), "test-origin-secret");
    assert.equal(captured.headers.get("x-forwarded-host"), "danmu.oyo131.xyz");
    assert.equal(captured.headers.get("x-real-ip"), "203.0.113.10");
    assert.equal(response.headers.get("x-edge-cache"), "MISS");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("a cached read avoids both rate limiting and origin traffic", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let limited = false;
  globalThis.caches = { default: { async match() { return new Response('{"cached":true}', { headers: { "content-type": "application/json" } }); }, async put() {} } };
  globalThis.fetch = async () => { throw new Error("origin should not be called"); };
  try {
    const response = await worker.fetch(
      new Request("https://danmu.oyo131.xyz/api/v2/search/anime?keyword=test"),
      environment({ API_RATE_LIMITER: { async limit() { limited = true; return { success: true }; } } }),
      context(),
    );
    assert.equal(response.headers.get("x-edge-cache"), "HIT");
    assert.equal(limited, false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("a cached segment POST avoids origin traffic and isolates requests by body", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const seenKeys = [];
  globalThis.caches = { default: {
    async match(request) {
      seenKeys.push(request.url);
      return Response.json({ success: true, comments: [{ m: "cached segment" }] });
    },
    async put() {},
  } };
  globalThis.fetch = async () => { throw new Error("origin should not be called"); };
  try {
    const makeRequest = (url) => new Request("https://danmu.oyo131.xyz/api/v2/segmentcomment?format=json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "qq", url }),
    });
    const first = await worker.fetch(makeRequest("https://dm.video.qq.com/barrage/a"), environment(), context());
    const second = await worker.fetch(makeRequest("https://dm.video.qq.com/barrage/b"), environment(), context());

    assert.equal(first.headers.get("x-edge-cache"), "HIT");
    assert.equal(second.headers.get("x-edge-cache"), "HIT");
    assert.equal(seenKeys.length, 2);
    assert.notEqual(seenKeys[0], seenKeys[1]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("segment POST body limits apply even when content-length is absent", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: {
    async match() { throw new Error("cache should not be called"); },
    async put() { throw new Error("cache should not be called"); },
  } };
  globalThis.fetch = async () => { throw new Error("origin should not be called"); };
  try {
    const request = new Request("https://danmu.oyo131.xyz/api/v2/segmentcomment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "qq",
        url: "https://dm.video.qq.com/barrage/a",
        padding: "x".repeat(262144),
      }),
    });
    assert.equal(request.headers.has("content-length"), false);
    const response = await worker.fetch(request, environment(), context());
    assert.equal(response.status, 413);
    assert.equal((await response.json()).errorMessage, "Request body too large");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("cache admission rejects empty search and segment results", async () => {
  assert.equal(await internals.responseIsCacheable(
    Response.json({ errorCode: 0, success: true, animes: [] }),
    "/api/v2/search/anime",
    "GET",
  ), false);
  assert.equal(await internals.responseIsCacheable(
    Response.json({ errorCode: 0, success: true, animes: [{ animeId: 1 }] }),
    "/api/v2/search/anime",
    "GET",
  ), true);
  assert.equal(await internals.responseIsCacheable(
    Response.json({ errorCode: 0, success: true, comments: [] }),
    "/api/v2/segmentcomment",
    "POST",
  ), false);
  assert.equal(await internals.responseIsCacheable(
    Response.json({ errorCode: 0, success: true, comments: [{ m: "ok" }] }),
    "/api/v2/segmentcomment",
    "POST",
  ), true);
});

test("cache admission rejects oversized semantic JSON without content-length", async () => {
  const payload = JSON.stringify({
    errorCode: 0,
    success: true,
    animes: [{ animeId: 1, padding: "x".repeat(2097152) }],
  });
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  }), { headers: { "content-type": "application/json" } });

  assert.equal(response.headers.has("content-length"), false);
  assert.equal(await internals.responseIsCacheable(response, "/api/v2/search/anime", "GET"), false);
});

test("empty search responses never replace the cache", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let writes = 0;
  globalThis.caches = { default: {
    async match() { return undefined; },
    async put() { writes += 1; },
  } };
  globalThis.fetch = async () => Response.json({ errorCode: 0, success: true, animes: [] });
  try {
    const ctx = context();
    const response = await worker.fetch(
      new Request("https://danmu.oyo131.xyz/api/v2/search/anime?keyword=empty"),
      environment(),
      ctx,
    );
    assert.equal(response.status, 200);
    await Promise.all(ctx.promises);
    assert.equal(writes, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("cache writes use a detached response after the client stream is locked", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let streamController;
  let writes = 0;
  globalThis.caches = { default: {
    async match() { return undefined; },
    async put() { writes += 1; },
  } };
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { streamController = controller; },
  }), { headers: { "content-type": "application/json" } });
  try {
    const ctx = context();
    const response = await worker.fetch(
      new Request("https://danmu.oyo131.xyz/api/v2/search/anime?keyword=stream-lock"),
      environment(),
      ctx,
    );
    const clientReader = response.body.getReader();
    streamController.enqueue(new TextEncoder().encode(JSON.stringify({
      errorCode: 0,
      success: true,
      animes: [{ animeId: 1 }],
    })));
    streamController.close();
    await Promise.all(ctx.promises);

    assert.equal(writes, 2);
    await clientReader.cancel();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("an expired fresh entry serves the long-lived backup and refreshes in the background", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const writes = [];
  let originCalls = 0;
  let releasePromotion;
  let promotionCompleted = false;
  const promotionGate = new Promise((resolve) => { releasePromotion = resolve; });
  globalThis.caches = { default: {
    async match(request) {
      if (new URL(request.url).hostname === "stale.cache.invalid") {
        return Response.json({ source: "backup" });
      }
      return undefined;
    },
    async put(request, response) {
      writes.push({ url: request.url, cacheControl: response.headers.get("cache-control") });
      if (writes.length === 1) {
        await promotionGate;
        promotionCompleted = true;
      }
    },
  } };
  globalThis.fetch = async () => {
    originCalls += 1;
    return Response.json({ success: true, animes: [{ source: "refreshed" }] });
  };
  try {
    const ctx = context();
    const response = await worker.fetch(
      new Request("https://danmu.oyo131.xyz/api/v2/search/anime?keyword=test"),
      environment(),
      ctx,
    );
    assert.equal(response.headers.get("x-edge-cache"), "STALE");
    assert.deepEqual(await response.json(), { source: "backup" });
    assert(writes.length >= 1, "backup promotion starts in the background");
    assert.match(writes[0].cacheControl, /s-maxage=15/);
    assert.equal(promotionCompleted, false, "stale response does not wait for a slow cache write");
    assert.equal(originCalls, 0, "refresh waits behind the short promotion without delaying the client");

    releasePromotion();
    await Promise.all(ctx.promises);
    assert.equal(originCalls, 1);
    assert.equal(writes.length, 3, "background refresh updates fresh and backup entries");
    assert(writes.some((entry) => entry.url.startsWith("https://stale.cache.invalid/")));
    assert(writes.some((entry) => /s-maxage=86400/.test(entry.cacheControl)));
  } finally {
    releasePromotion();
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});
