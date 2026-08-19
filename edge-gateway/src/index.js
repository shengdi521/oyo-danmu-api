const SERVICE_NAME = "oyo-danmu-api";

const PUBLIC_ROUTES = [
  { methods: new Set(["GET"]), pattern: /^\/api\/v2\/search\/(?:anime|episodes)\/?$/i },
  { methods: new Set(["POST"]), pattern: /^\/api\/v2\/match\/?$/i },
  { methods: new Set(["GET"]), pattern: /^\/api\/v2\/bangumi\/[^/]+\/?$/i },
  { methods: new Set(["GET"]), pattern: /^\/api\/v2\/(?:comment|extcomment)(?:\/[^/]+)?\/?$/i },
  { methods: new Set(["POST"]), pattern: /^\/api\/v2\/segmentcomment\/?$/i },
  { methods: new Set(["GET", "POST"]), pattern: /^\/api\/v2\/fongmi\/danmaku\/?$/i },
  { methods: new Set(["GET", "POST"]), pattern: /^\/danmaku\/?$/i },
  { methods: new Set(["GET", "POST"]), pattern: /^\/danmaku\/api\/v2\/fongmi\/danmaku\/?$/i },
];

function isPublicRoute(pathname, method) {
  return PUBLIC_ROUTES.some((route) => route.methods.has(method) && route.pattern.test(pathname));
}

async function timingSafeSecretEqual(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
  }
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function isManagementRoute(pathname, env) {
  const firstSegment = pathname.split("/")[1] || "";
  return timingSafeSecretEqual(firstSegment, env.ADMIN_PATH_TOKEN);
}

const MEDIA_HOST_SUFFIXES = [
  "360kan.com", "acfun.cn", "animeko.org", "ani.rip", "bangumi.lol", "bgm.tv",
  "bilibili.com", "bilivideo.com", "douban.com", "doubanio.com", "douyin.com",
  "gamer.com.tw", "hiyun.tv", "hunantv.com", "iq.com", "iqiyi.com", "ixigua.com",
  "le.com", "letv.com", "mddcloud.com.cn", "mgtv.com", "migu.cn", "miguvideo.com",
  "myani.org", "nimg.jp", "nicovideo.jp", "qq.com", "rrsp.com.cn", "snssdk.com", "sohu.com", "tv.sohu.com",
  "xiawen.tv", "yfsp.tv", "ykimg.com", "youku.com", "zmdcq.com",
];

const SAFE_SEGMENT_TYPES = new Set([
  "acfun", "aiyifan", "animeko", "bahamut", "bilibili1", "custom", "dandan", "hanjutv",
  "hongguo", "imgo", "leshi", "maiduidui", "migu", "niconico", "other_server", "qiyi", "qq",
  "renren", "sohu", "xigua", "youku",
]);

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function canonicalUrl(url, hostname = "cache.invalid") {
  const canonical = new URL(`https://${hostname}`);
  canonical.pathname = url.pathname;
  const entries = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
  );
  for (const [key, value] of entries) canonical.searchParams.append(key, value);
  return canonical;
}

function staleCacheKey(url) {
  return new Request(canonicalUrl(url, "stale.cache.invalid"), { method: "GET" });
}

function cacheStorageResponse(response, ttl) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", `public, max-age=0, s-maxage=${ttl}`);
  headers.delete("x-edge-cache");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function putCachedPair(cacheKey, backupKey, response, ttl) {
  const fresh = cacheStorageResponse(response.clone(), ttl);
  const backup = cacheStorageResponse(response.clone(), 86400);
  await Promise.all([
    caches.default.put(cacheKey, fresh),
    caches.default.put(backupKey, backup),
  ]);
}

function cacheTtl(pathname, method) {
  if (method !== "GET") return 0;
  if (/\/api\/v2\/(?:comment|extcomment|segmentcomment)(?:\/|$)/i.test(pathname)) return 1800;
  if (/\/api\/v2\/bangumi(?:\/|$)/i.test(pathname)) return 900;
  if (/\/api\/v2\/(?:search\/anime|search\/episodes|fongmi\/danmaku)(?:\/|$)/i.test(pathname)) return 180;
  return 0;
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "unknown";
}

function hostnameAllowed(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") ||
      normalized.endsWith(".local") || normalized.endsWith(".internal") ||
      normalized === "danmu-origin.oyo131.xyz") return false;

  if (normalized.includes(":")) {
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
        normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return false;
    const mapped = normalized.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return mapped ? hostnameAllowed(mapped[1]) : true;
  }

  if (!/^\d+(?:\.\d+){3}$/.test(normalized)) {
    return MEDIA_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
  }
  const octets = normalized.split(".").map(Number);
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113));
}

function validateMediaUrl(rawUrl) {
  if (!rawUrl) return true;
  try {
    const parsed = new URL(rawUrl);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && hostnameAllowed(parsed.hostname);
  } catch {
    return false;
  }
}

function validateSegmentTarget(type, rawUrl) {
  if (!SAFE_SEGMENT_TYPES.has(String(type || "")) || typeof rawUrl !== "string" ||
      rawUrl.length === 0 || rawUrl.length > 8192 || /[\u0000-\u001f\u007f]/.test(rawUrl)) return false;
  if (/^https?:\/\//i.test(rawUrl)) return validateMediaUrl(rawUrl);
  return !/^(?:file|ftp|gopher|data|javascript|ws|wss):/i.test(rawUrl);
}

async function validateUrlInputs(request, url) {
  const queryUrl = url.searchParams.get("url");
  if (queryUrl && !validateMediaUrl(queryUrl)) {
    return { ok: false, response: json({ success: false, errorMessage: "Unsupported media URL" }, 400) };
  }
  if (request.method !== "POST" || !/\/api\/v2\/segmentcomment(?:\/|$)/i.test(url.pathname)) {
    return { ok: true, request };
  }
  const length = Number.parseInt(request.headers.get("content-length") || "0", 10);
  if (Number.isFinite(length) && length > 262144) {
    return { ok: false, response: json({ success: false, errorMessage: "Request body too large" }, 413) };
  }
  let body;
  try {
    body = await request.text();
    const parsed = JSON.parse(body);
    if (!validateSegmentTarget(parsed?.type, parsed?.url)) throw new Error("unsupported URL");
  } catch {
    return { ok: false, response: json({ success: false, errorMessage: "Invalid segment request" }, 400) };
  }
  return { ok: true, request: new Request(request, { body }) };
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, User-Agent",
      "access-control-max-age": "86400",
    },
  });
}

function decorate(response, cacheState, ttl = 0, management = false) {
  const headers = new Headers(response.headers);
  headers.delete("server");
  headers.delete("set-cookie");
  headers.delete("x-powered-by");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-service", SERVICE_NAME);
  if (management) {
    headers.delete("access-control-allow-origin");
    headers.delete("access-control-allow-credentials");
    headers.delete("access-control-expose-headers");
    headers.set("cache-control", "private, no-store, max-age=0");
    headers.set("pragma", "no-cache");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-frame-options", "DENY");
    headers.set("x-edge-cache", "BYPASS");
  } else if (ttl > 0 && response.ok) {
    headers.set("access-control-allow-origin", "*");
    headers.set("x-edge-cache", cacheState);
    headers.set("cache-control", `public, max-age=60, s-maxage=${ttl}, stale-while-revalidate=60`);
  } else {
    headers.set("access-control-allow-origin", "*");
    headers.set("x-edge-cache", cacheState);
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function checkRateLimit(env, key) {
  if (!env.API_RATE_LIMITER?.limit) return true;
  return (await env.API_RATE_LIMITER.limit({ key })).success;
}

async function proxy(request, env, ctx, { management = false } = {}) {
  const incomingUrl = new URL(request.url);
  const validated = await validateUrlInputs(request, incomingUrl);
  if (!validated.ok) return validated.response;
  request = validated.request;
  const ttl = management ? 0 : cacheTtl(incomingUrl.pathname, request.method);
  const cacheKey = ttl > 0 ? new Request(canonicalUrl(incomingUrl), { method: "GET" }) : null;
  const backupKey = ttl > 0 ? staleCacheKey(incomingUrl) : null;
  if (cacheKey) {
    const cached = await caches.default.match(cacheKey);
    if (cached) return decorate(cached, "HIT", ttl);
  }
  const ip = clientIp(request);

  const fetchFromOrigin = async () => {
    const originUrl = new URL(request.url);
    originUrl.protocol = "http:";
    originUrl.hostname = "danmu.internal";
    originUrl.port = "";
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("x-danmu-origin-auth");
    headers.set("x-danmu-origin-auth", env.ORIGIN_SHARED_SECRET);
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-host", incomingUrl.host);
    headers.set("x-real-ip", ip);
    headers.set("x-forwarded-for", ip);
    const upstreamRequest = new Request(originUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
    try {
      const upstream = await env.ORIGIN.fetch(upstreamRequest, { cache: "no-store" });
      return decorate(upstream, "MISS", ttl, management);
    } catch (error) {
      console.error(JSON.stringify({ event: "origin_fetch_failed", message: String(error) }));
      return json({ success: false, errorMessage: "Origin temporarily unavailable" }, 503, { "retry-after": "5" });
    }
  };

  if (backupKey) {
    const backup = await caches.default.match(backupKey);
    if (backup) {
      const promoted = cacheStorageResponse(backup.clone(), 15);
      const response = decorate(backup, "STALE", ttl);
      // Promote the backup briefly before returning so concurrent misses do not
      // stampede the 512 MB origin while one background refresh is running.
      await caches.default.put(cacheKey, promoted);
      ctx.waitUntil((async () => {
        if (!(await checkRateLimit(env, `${ip}:REFRESH`))) return;
        const refreshed = await fetchFromOrigin();
        if (refreshed.ok) await putCachedPair(cacheKey, backupKey, refreshed, ttl);
      })().catch((error) => {
        console.error(JSON.stringify({ event: "stale_refresh_failed", message: String(error) }));
      }));
      return response;
    }
  }

  if (!(await checkRateLimit(env, `${ip}:${request.method}`))) {
    return json({ success: false, errorMessage: "Too many requests; retry shortly" }, 429, { "retry-after": "60" });
  }
  const response = await fetchFromOrigin();
  if (cacheKey && response.ok) {
    ctx.waitUntil(putCachedPair(cacheKey, backupKey, response, ttl).catch((error) => {
      console.error(JSON.stringify({ event: "cache_put_failed", message: String(error) }));
    }));
  }
  return response;
}

async function health(request, env) {
  const originUrl = new URL("http://danmu.internal/favicon.ico");
  const startedAt = Date.now();
  let originStatus = 0;
  try {
    const response = await env.ORIGIN.fetch(originUrl, {
      method: "GET",
      headers: { "x-danmu-origin-auth": env.ORIGIN_SHARED_SECRET },
      cache: "no-store",
    });
    originStatus = response.status;
    await response.body?.cancel();
  } catch {
    originStatus = 0;
  }
  const healthy = originStatus >= 200 && originStatus < 400;
  return json({
    ok: healthy,
    service: SERVICE_NAME,
    edge: request.cf?.colo || "local",
    originStatus,
    originLatencyMs: Date.now() - startedAt,
    version: env.SERVICE_VERSION || "development",
  }, healthy ? 200 : 503);
}

export const internals = { cacheTtl, canonicalUrl, hostnameAllowed, isPublicRoute, staleCacheKey, validateMediaUrl, validateSegmentTarget };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return corsPreflight();
    if (url.pathname === "/" && request.method === "GET") {
      return json({ ok: true, service: SERVICE_NAME, api: "https://danmu.oyo131.xyz", health: "/_edge/health", upstream: "huangxd-/danmu_api" }, 200, { "cache-control": "public, max-age=300" });
    }
    if (url.pathname === "/_edge/health" && request.method === "GET") return health(request, env);
    if (url.pathname.startsWith("/_edge/")) return json({ success: false, errorMessage: "Not found" }, 404);
    if (!new Set(["GET", "HEAD", "POST"]).has(request.method)) {
      return json({ success: false, errorMessage: "Method not allowed" }, 405, { allow: "GET, HEAD, POST, OPTIONS" });
    }
    if (isPublicRoute(url.pathname, request.method)) return proxy(request, env, ctx);
    if (await isManagementRoute(url.pathname, env)) return proxy(request, env, ctx, { management: true });
    return json({ success: false, errorMessage: "Not found" }, 404);
  },
};
