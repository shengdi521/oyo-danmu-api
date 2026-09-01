import { sha256, bytesToBase64 } from './codec-util.js';
import { log } from './log-util.js';
import { httpGet } from './http-util.js';
import { globals } from '../configs/globals.js';

// 由部署者在运行时注入的弹弹play开放平台凭证生成 X-Signature。
// 源码、构建产物与测试只使用虚构值，不包含可恢复的真实凭证。
export function generateNipaplaySignature(appId, timestamp, apiPath, appSecret) {
  return bytesToBase64(sha256(`${appId}${timestamp}${apiPath}${appSecret}`));
}

// 返回纯请求数据，便于在不联网、不接触真实密钥的单元测试中验证签名与请求契约。
export function buildNipaplayRequest(episodeId, options = {}) {
  const appId = String(options.appId ?? globals.nipaplayAppId ?? '').trim();
  const appSecret = String(options.appSecret ?? globals.nipaplayAppSecret ?? '').trim();
  const normalizedEpisodeId = String(episodeId ?? '').trim();
  if (!appId || !appSecret || !/^\d+$/.test(normalizedEpisodeId)) return null;

  const timestamp = Number.isFinite(options.timestamp)
    ? Math.trunc(options.timestamp)
    : Math.round(Date.now() / 1000);
  const apiPath = `/api/v2/comment/${normalizedEpisodeId}`;
  return {
    url: `https://api.dandanplay.net${apiPath}?withRelated=true&chConvert=0`,
    options: {
      headers: {
        'Accept': 'application/json',
        'User-Agent': `LogVar Danmu API/${globals.version}`,
        'X-AppId': appId,
        'X-Timestamp': String(timestamp),
        'X-Signature': generateNipaplaySignature(appId, timestamp, apiPath, appSecret),
      },
      allow_redirects: false,
      validStatusCodes: [302],
      retries: 1,
    },
  };
}

// 域名到内部源标识的映射，覆盖 dandanplay 允许绑定的平台。
const RELATED_PLATFORM_BY_HOST = {
  'bilibili.com': 'bilibili',
  'b23.tv': 'bilibili',
  'gamer.com.tw': 'bahamut',
  'iqiyi.com': 'iqiyi',
  'youku.com': 'youku',
  'qq.com': 'tencent',
  'mgtv.com': 'imgo',
};

// 从 302 Location 解析 urls（| 分隔）与 shift（, 分隔），平台由主机名推导。
export function parseNipaplayRelatedLinks(location) {
  const result = { bilibili: [], bahamut: [], iqiyi: [], youku: [], tencent: [], imgo: [] };
  if (!location || typeof location !== 'string') return result;
  let parsed;
  try {
    parsed = new URL(location);
  } catch {
    return result;
  }
  const urlsParam = parsed.searchParams.get('urls');
  if (!urlsParam) return result;
  const urls = urlsParam.split('|').map((entry) => entry.trim()).filter(Boolean);
  const shifts = (parsed.searchParams.get('shift') || '')
    .split(',').map((value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; });
  for (let i = 0; i < urls.length; i++) {
    let host = '';
    try { host = new URL(urls[i]).host; } catch { host = ''; }
    const hostKey = Object.keys(RELATED_PLATFORM_BY_HOST)
      .find((key) => host.endsWith(key)) || null;
    if (!hostKey) {
      log('info', `[nipaplay] 弹弹302关联链接含未支持平台，跳过: ${urls[i]}`);
      continue;
    }
    const platform = RELATED_PLATFORM_BY_HOST[hostKey];
    const shift = shifts[i] || 0;
    if (platform === 'bilibili') {
      const bMatch = urls[i].match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i);
      const pMatch = urls[i].match(/[?&]p=(\d+)/);
      const clean = bMatch
        ? `https://www.bilibili.com/video/${bMatch[1]}` + (pMatch ? `?p=${pMatch[1]}` : '')
        : urls[i];
      result.bilibili.push({ url: clean, shift });
      continue;
    }
    result[platform].push({ url: urls[i], shift });
  }
  return result;
}

// 发起带签名的 302 关联请求并截获重定向；无合法运行时凭证时安全跳过。
export async function fetchNipaplayRelatedLinks(episodeId) {
  const request = buildNipaplayRequest(episodeId);
  if (!request) {
    log('info', '[nipaplay] 运行时凭证未配置或 episodeId 非法，跳过弹弹302关联兜底');
    return null;
  }
  try {
    const resp = await httpGet(request.url, request.options);
    if (resp.status !== 302 || !resp.headers.location) {
      log('info', `[nipaplay] 弹弹302关联链接未返回 302 (status=${resp.status})`);
      return null;
    }
    return parseNipaplayRelatedLinks(resp.headers.location);
  } catch (error) {
    log('error', `[nipaplay] 弹弹302关联链接请求失败: ${error.message}`);
    return null;
  }
}

// 解析关联链接为 {source, realId}；bahamut 使用 sn，其余平台保留完整 URL。
export function resolveNipaplayLink(url) {
  let host = '';
  try { host = new URL(url).host; } catch { host = ''; }
  const hostKey = Object.keys(RELATED_PLATFORM_BY_HOST)
    .find((key) => host.endsWith(key)) || null;
  const platform = hostKey ? RELATED_PLATFORM_BY_HOST[hostKey] : null;
  if (platform === 'bahamut') {
    const snMatch = url.match(/sn=(\d+)/);
    return { source: 'bahamut', realId: snMatch ? snMatch[1] : url };
  }
  if (!platform) return { source: null, realId: url };
  return { source: platform, realId: url };
}

// 对已格式化弹幕应用关联链接附带的时间偏移，不修改原对象。
export function applyShiftToDanmu(danmu, shift = 0) {
  if (!danmu || typeof danmu !== 'object') return danmu;
  const next = { ...danmu };
  if (typeof next.p === 'string') {
    const parts = next.p.split(',');
    const time = parseFloat(parts[0]);
    if (!isNaN(time)) parts[0] = (time + shift).toFixed(2);
    next.p = parts.join(',');
  }
  if (typeof next.t === 'number') next.t += shift;
  next.isRealTimePulled = true;
  return next;
}
