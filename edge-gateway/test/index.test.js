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

test("cache TTLs only cover stable read APIs", () => {
  assert.equal(internals.cacheTtl("/api/v2/comment/1", "GET"), 1800);
  assert.equal(internals.cacheTtl("/api/v2/search/anime", "GET"), 180);
  assert.equal(internals.cacheTtl("/api/v2/match", "POST"), 0);
});

test("canonical cache key sorts query parameters", () => {
  const result = internals.canonicalUrl(new URL("https://danmu.oyo131.xyz/api/v2/search/anime?z=2&a=1"));
  assert.equal(result.href, "https://cache.invalid/api/v2/search/anime?a=1&z=2");
});

test("media URL validation permits known services and blocks private origins", () => {
  assert.equal(internals.validateMediaUrl("https://v.qq.com/x/cover/test.html"), true);
  assert.equal(internals.validateMediaUrl("https://www.bilibili.com/video/BV1xx"), true);
  assert.equal(internals.validateMediaUrl("https://api5-normal-sinfonlinea.fqnovel.com/video/1"), false);
  assert.equal(internals.validateMediaUrl("https://attacker.example/proxy"), false);
  assert.equal(internals.validateMediaUrl("http://127.0.0.1:9321/private"), false);
  assert.equal(internals.validateMediaUrl("http://169.254.169.254/latest/meta-data"), false);
});

test("segment validation accepts supported opaque IDs but rejects proxy schemes", () => {
  assert.equal(internals.validateSegmentTarget("acfun", "acfun:38400001:0:60000"), true);
  assert.equal(internals.validateSegmentTarget("hongguo", "hongguo:v1:123:456:90#segment=0"), true);
  assert.equal(internals.validateSegmentTarget("dandan", "12345"), true);
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
