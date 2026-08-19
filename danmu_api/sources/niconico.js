import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from '../utils/log-util.js';
import { httpGet, httpPost } from '../utils/http-util.js';
import { addAnime, removeEarliestAnime } from '../utils/cache-util.js';
import { convertToAsciiSum } from '../utils/codec-util.js';
import { generateValidStartDate } from '../utils/time-util.js';
import { SegmentListResponse } from '../models/dandan-model.js';

const SNAPSHOT_SEARCH_URL = 'https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search';
const NVAPI_BASE_URL = 'https://nvapi.nicovideo.jp';
const WATCH_BASE_URL = 'https://www.nicovideo.jp/watch';
const MAX_SEARCH_RESULTS = 8;
const MAX_SERIES_EPISODES = 100;
const WATCH_CACHE_TTL_MS = 30_000;
const MAX_WATCH_CACHE_ENTRIES = 64;

const NICO_COLOR_MAP = {
  white: 0xffffff,
  red: 0xff0000,
  pink: 0xff8080,
  orange: 0xffcc00,
  yellow: 0xffff00,
  green: 0x00ff00,
  cyan: 0x00ffff,
  blue: 0x0000ff,
  purple: 0xc000ff,
  black: 0x000000,
  white2: 0xcccc99,
  red2: 0xcc0033,
  pink2: 0xff33cc,
  orange2: 0xff6600,
  yellow2: 0x999900,
  green2: 0x00cc66,
  cyan2: 0x00cccc,
  blue2: 0x3399ff,
  purple2: 0x6633cc,
  black2: 0x666666,
};

function normalizeVideoId(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:nicovideo\.jp\/watch\/)?((?:sm|so|nm)\d+)/i);
  return match ? match[1].toLowerCase() : '';
}

function unwrapWatchResponse(payload) {
  let response = payload?.data?.response ?? payload?.data ?? payload;
  if (response?.data && typeof response.data === 'object') response = response.data;
  return response && typeof response === 'object' ? response : null;
}

function thumbnailUrl(video) {
  return video?.thumbnailUrl
    || video?.thumbnail?.nHdUrl
    || video?.thumbnail?.largeUrl
    || video?.thumbnail?.listingUrl
    || video?.thumbnail?.url
    || '';
}

function nicoHeaders() {
  return {
    Accept: 'application/json',
    'User-Agent': `LogVar Danmu API/${globals.version}`,
    'X-Frontend-Id': '6',
    'X-Frontend-Version': '0',
  };
}

export default class NiconicoSource extends BaseSource {
  constructor() {
    super();
    this.watchCache = new Map();
  }

  async search(keyword) {
    const query = String(keyword || '').trim();
    if (!query) return [];

    const url = new URL(SNAPSHOT_SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('targets', 'title,tags');
    url.searchParams.set('fields', 'contentId,title,thumbnailUrl,startTime,lengthSeconds,viewCounter,commentCounter');
    url.searchParams.set('_sort', '-commentCounter');
    url.searchParams.set('_offset', '0');
    url.searchParams.set('_limit', String(MAX_SEARCH_RESULTS));
    url.searchParams.set('_context', 'oyo-danmu-api');

    try {
      const response = await httpGet(globals.makeProxyUrl(url.toString()), {
        headers: nicoHeaders(),
        timeout: 3500,
        retries: 1,
      });
      const results = Array.isArray(response?.data?.data) ? response.data.data : [];
      log('info', `[niconico] 搜索找到 ${results.length} 个候选视频`);
      return results;
    } catch (error) {
      log('error', `[niconico] 搜索失败: ${error.message}`);
      return [];
    }
  }

  async _getWatchData(value) {
    const videoId = normalizeVideoId(value);
    if (!videoId) return null;

    const now = Date.now();
    const cached = this.watchCache.get(videoId);
    if (cached?.expiresAt > now) return cached.promise;
    if (cached) this.watchCache.delete(videoId);

    const promise = (async () => {
      try {
        const response = await httpGet(globals.makeProxyUrl(`${WATCH_BASE_URL}/${videoId}?responseType=json`), {
          headers: { ...nicoHeaders(), Accept: '*/*' },
          timeout: 4000,
          retries: 1,
        });
        return unwrapWatchResponse(response?.data);
      } catch (error) {
        log('warn', `[niconico] 视频 ${videoId} 元数据获取失败: ${error.message}`);
        this.watchCache.delete(videoId);
        return null;
      }
    })();

    this.watchCache.set(videoId, { expiresAt: now + WATCH_CACHE_TTL_MS, promise });
    if (this.watchCache.size > MAX_WATCH_CACHE_ENTRIES) {
      const oldestVideoId = this.watchCache.keys().next().value;
      if (oldestVideoId !== undefined) this.watchCache.delete(oldestVideoId);
    }
    return promise;
  }

  async getEpisodes(seriesId) {
    const normalizedId = String(seriesId || '').trim();
    if (!/^\d+$/.test(normalizedId)) return [];
    const url = `${NVAPI_BASE_URL}/v1/series/${normalizedId}?pageSize=${MAX_SERIES_EPISODES}&page=1`;
    try {
      const response = await httpGet(globals.makeProxyUrl(url), {
        headers: nicoHeaders(),
        timeout: 4000,
        retries: 1,
      });
      return Array.isArray(response?.data?.data?.items)
        ? response.data.data.items.map((item) => item?.video).filter(Boolean)
        : [];
    } catch (error) {
      log('warn', `[niconico] 系列 ${normalizedId} 分集获取失败: ${error.message}`);
      return [];
    }
  }

  async handleAnimes(sourceAnimes, _queryTitle, curAnimes, detailStore = null) {
    if (!Array.isArray(sourceAnimes) || sourceAnimes.length === 0) return [];

    // 只保留能取得公开 nvComment threadKey 的视频；付费、地域限制或需登录条目不进入结果。
    const candidates = sourceAnimes.slice(0, MAX_SEARCH_RESULTS);
    const watchResults = await Promise.allSettled(candidates.map((video) => this._getWatchData(video?.contentId)));
    const available = [];
    for (let index = 0; index < watchResults.length; index += 1) {
      const watchData = watchResults[index].status === 'fulfilled' ? watchResults[index].value : null;
      const nvComment = watchData?.comment?.nvComment;
      if (!watchData?.video?.id || typeof nvComment?.threadKey !== 'string' || !nvComment.threadKey || !nvComment?.params?.targets?.length) continue;
      available.push({ search: candidates[index], watch: watchData });
    }

    const grouped = new Map();
    for (const item of available) {
      const seriesId = String(item.watch?.series?.id || '');
      const key = seriesId ? `series:${seriesId}` : `video:${item.watch.video.id}`;
      if (!grouped.has(key)) grouped.set(key, item);
    }

    const groupsWithEpisodes = await Promise.all(Array.from(grouped, async ([groupKey, item]) => {
      const seriesId = groupKey.startsWith('series:') ? groupKey.slice(7) : '';
      let episodes = seriesId ? await this.getEpisodes(seriesId) : [];
      if (episodes.length === 0) episodes = [item.watch.video];
      episodes = episodes.filter((video) => normalizeVideoId(video?.id) && video?.isPaymentRequired !== true);
      return { item, seriesId, episodes };
    }));

    const transformed = [];
    for (const { item, seriesId, episodes } of groupsWithEpisodes) {
      if (episodes.length === 0) continue;

      const links = episodes.map((video, index) => ({
        name: String(video?.title || `第${index + 1}集`),
        url: `${WATCH_BASE_URL}/${normalizeVideoId(video.id)}`,
        title: `【niconico】 ${video?.title || `第${index + 1}集`}`,
      }));
      const registeredAt = item.watch?.video?.registeredAt || item.search?.startTime || '';
      const year = Number(String(registeredAt).slice(0, 4)) || 0;
      const title = String(item.watch?.series?.title || item.watch?.video?.title || item.search?.title || '').trim();
      const stableId = seriesId || normalizeVideoId(item.watch.video.id);
      const animeId = convertToAsciiSum(`niconico:${seriesId ? 'series' : 'video'}:${stableId}`);
      const transformedAnime = {
        animeId,
        bangumiId: stableId,
        animeTitle: `${title}(${year || 'N/A'})【动漫】from niconico`,
        type: '动漫',
        typeDescription: '动漫',
        imageUrl: item.watch?.series?.thumbnailUrl || thumbnailUrl(item.watch?.video) || thumbnailUrl(item.search),
        startDate: generateValidStartDate(year || ''),
        episodeCount: links.length,
        rating: 0,
        isFavorited: true,
        source: 'niconico',
      };

      transformed.push(transformedAnime);
      addAnime({ ...transformedAnime, links }, detailStore);
      if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
    }

    this.sortAndPushAnimesByYear(transformed, curAnimes);
    return transformed;
  }

  async getEpisodeDanmu(value) {
    const videoId = normalizeVideoId(value);
    if (!videoId) return [];
    const watchData = await this._getWatchData(videoId);
    const nvComment = watchData?.comment?.nvComment;
    if (typeof nvComment?.threadKey !== 'string' || !nvComment.threadKey || !nvComment?.server || !nvComment?.params?.targets?.length) {
      log('info', `[niconico] 视频 ${videoId} 无公开评论凭证，可能受地域、付费或登录限制`);
      return [];
    }

    try {
      const response = await httpPost(globals.makeProxyUrl(`${nvComment.server}/v1/threads`), JSON.stringify({
        params: nvComment.params,
        threadKey: nvComment.threadKey,
      }), {
        headers: {
          ...nicoHeaders(),
          'Content-Type': 'application/json',
        },
        timeout: 6000,
        retries: 1,
      });
      const threads = Array.isArray(response?.data?.data?.threads) ? response.data.data.threads : [];
      const seen = new Set();
      return threads.flatMap((thread) => Array.isArray(thread?.comments) ? thread.comments : [])
        .filter((comment) => {
          const key = `${comment?.id || ''}:${comment?.vposMs || 0}:${comment?.body || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    } catch (error) {
      log('error', `[niconico] 视频 ${videoId} 弹幕获取失败: ${error.message}`);
      return [];
    }
  }

  async getEpisodeDanmuSegments(value) {
    const videoId = normalizeVideoId(value);
    if (!videoId) return new SegmentListResponse({ type: 'niconico', segmentList: [], duration: 0 });
    const watchData = await this._getWatchData(videoId);
    const duration = Number(watchData?.video?.duration || 0);
    return new SegmentListResponse({
      type: 'niconico',
      duration: duration > 0 ? duration : 0,
      segmentList: [{
        type: 'niconico',
        segment_start: 0,
        segment_end: duration > 0 ? duration : 0,
        url: `niconico:${videoId}`,
      }],
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    const match = String(segment?.url || '').match(/^niconico:((?:sm|so|nm)\d+)$/i);
    return match ? this.getEpisodeDanmu(match[1]) : [];
  }

  formatComments(comments) {
    if (!Array.isArray(comments)) return [];
    return comments.flatMap((comment) => {
      const message = String(comment?.body || '').trim();
      const time = Number(comment?.vposMs || 0) / 1000;
      if (!message || !Number.isFinite(time)) return [];
      const commands = Array.isArray(comment?.commands) ? comment.commands.map((value) => String(value).toLowerCase()) : [];
      const mode = commands.includes('ue') ? 5 : commands.includes('shita') ? 4 : 1;
      const explicitColor = commands.find((value) => /^#[0-9a-f]{6}$/i.test(value));
      const namedColor = commands.find((value) => NICO_COLOR_MAP[value] !== undefined);
      const color = explicitColor ? Number.parseInt(explicitColor.slice(1), 16) : NICO_COLOR_MAP[namedColor] ?? 0xffffff;
      return [{
        cid: comment?.id || 0,
        p: `${time},${mode},${color},[niconico]`,
        m: message,
        t: time,
        like: Number(comment?.nicoruCount || 0),
      }];
    });
  }
}
