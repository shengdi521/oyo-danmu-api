import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from '../utils/log-util.js';
import { httpGet, httpPost } from '../utils/http-util.js';
import { addAnime, removeEarliestAnime } from '../utils/cache-util.js';
import { convertToAsciiSum } from '../utils/codec-util.js';
import { generateValidStartDate } from '../utils/time-util.js';
import { titleMatches, getExplicitSeasonNumber, extractSeasonNumberFromAnimeTitle } from '../utils/common-util.js';
import { SegmentListResponse } from '../models/dandan-model.js';

const ACFUN_BASE_URL = 'https://www.acfun.cn';
const ACFUN_DANMU_LIST_URL = `${ACFUN_BASE_URL}/rest/pc-direct/new-danmaku/list`;
const ACFUN_DANMU_POSITION_URL = `${ACFUN_BASE_URL}/rest/pc-direct/new-danmaku/pollByPosition`;
const SEGMENT_DURATION_MS = 60 * 1000;
const MAX_DANMU_PAGES = 100;

function toFormBody(values) {
  return Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

export default class AcfunSource extends BaseSource {
  get headers() {
    return {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36',
      Referer: `${ACFUN_BASE_URL}/`,
    };
  }

  async search(keyword) {
    try {
      const targetUrl = `${ACFUN_BASE_URL}/rest/pc-direct/search/bgm?keyword=${encodeURIComponent(keyword)}`;
      const response = await httpGet(globals.makeProxyUrl(targetUrl), {
        headers: this.headers,
        timeout: 3000,
        retries: 1,
      });
      const data = response?.data;
      const results = Array.isArray(data?.bgmList) ? data.bgmList : [];
      log('info', `[acfun] 搜索找到 ${results.length} 个有效结果`);
      return results;
    } catch (error) {
      log('error', `[acfun] 搜索失败: ${error.message}`);
      return [];
    }
  }

  async getEpisodes(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.videoList)) return value.videoList;
    return [];
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null, querySeason = null) {
    if (!Array.isArray(sourceAnimes)) {
      log('error', '[acfun] sourceAnimes is not a valid array');
      return [];
    }

    let filteredAnimes = sourceAnimes.filter((anime) =>
      titleMatches(anime?.bgmTitle || anime?.title || '', queryTitle, querySeason)
    );
    const resolvedQuerySeason = querySeason !== null ? querySeason : getExplicitSeasonNumber(queryTitle);

    if (resolvedQuerySeason !== null) {
      const seasonFiltered = filteredAnimes.filter((anime) => {
        const title = anime?.bgmTitle || anime?.title || '';
        const season = extractSeasonNumberFromAnimeTitle(title).season;
        return season === resolvedQuerySeason || (resolvedQuerySeason === 1 && season === null);
      });
      if (seasonFiltered.length > 0) filteredAnimes = seasonFiltered;
    }

    const transformed = [];
    for (const anime of filteredAnimes) {
      const episodes = await this.getEpisodes(anime);
      const bgmId = Number(anime?.bgmId || anime?.id || 0);
      if (!bgmId || episodes.length === 0) continue;

      const links = episodes.flatMap((episode, index) => {
        const videoId = Number(episode?.id || 0);
        const itemId = Number(episode?.itemId || 0);
        if (!videoId || !itemId) return [];
        const episodeTitle = episode?.episodeName || episode?.title || `第${index + 1}集`;
        return [{
          name: String(episodeTitle),
          url: `${ACFUN_BASE_URL}/bangumi/aa${bgmId}_36188_${itemId}?oyo_acfun_vid=${videoId}`,
          title: `【acfun】 ${episodeTitle}`,
        }];
      });
      if (links.length === 0) continue;

      const year = Number(anime?.year || 0);
      const title = String(anime?.bgmTitle || anime?.title || '').trim();
      const animeId = convertToAsciiSum(`acfun:${bgmId}`);
      const transformedAnime = {
        animeId,
        bangumiId: String(bgmId),
        animeTitle: `${title}(${year || 'N/A'})【动漫】from acfun`,
        type: '动漫',
        typeDescription: '动漫',
        imageUrl: anime?.coverImageV || anime?.coverImageH || '',
        startDate: generateValidStartDate(year || ''),
        episodeCount: links.length,
        rating: 0,
        isFavorited: true,
        source: 'acfun',
      };

      transformed.push(transformedAnime);
      addAnime({ ...transformedAnime, links }, detailStore);
      if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
    }

    this.sortAndPushAnimesByYear(transformed, curAnimes);
    return transformed;
  }

  async _resolveVideoContext(value, includeDuration = false) {
    const rawValue = String(value || '').trim();
    let videoId = rawValue.match(/[?&]oyo_acfun_vid=(\d+)/)?.[1]
      || rawValue.match(/^acfun(?:-full)?:([0-9]+)/)?.[1]
      || (/^\d+$/.test(rawValue) ? rawValue : '');
    let duration = 0;

    if ((!videoId || includeDuration) && /^https?:\/\/(?:www\.)?acfun\.cn\//i.test(rawValue)) {
      try {
        const pageUrl = rawValue.replace(/#.*$/, '');
        const response = await httpGet(globals.makeProxyUrl(pageUrl), {
          headers: this.headers,
          timeout: 6000,
          retries: 1,
        });
        const html = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data || '');
        if (!videoId) videoId = html.match(/"videoId":(\d+)/)?.[1] || '';
        const durationMillis = Number(html.match(/"durationMillis":(\d+)/)?.[1] || 0);
        if (durationMillis > 0) duration = durationMillis / 1000;
      } catch (error) {
        log('warn', `[acfun] 页面信息解析失败，使用已知视频ID降级: ${error.message}`);
      }
    }

    return { videoId, duration };
  }

  async getEpisodeDanmu(value) {
    const { videoId } = await this._resolveVideoContext(value);
    if (!videoId) return [];

    const comments = [];
    const seenCursors = new Set();
    let cursor = '1';

    for (let page = 0; page < MAX_DANMU_PAGES && cursor && cursor !== 'no_more'; page += 1) {
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);

      try {
        const response = await httpPost(globals.makeProxyUrl(ACFUN_DANMU_LIST_URL), toFormBody({
          resourceId: videoId,
          pcursor: cursor,
          resourceType: 9,
          count: 200,
        }), {
          headers: {
            ...this.headers,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 6000,
          retries: 1,
        });
        const data = response?.data || {};
        if (Array.isArray(data.danmakus)) comments.push(...data.danmakus);
        cursor = data.pcursor;
      } catch (error) {
        log('error', `[acfun] 第 ${page + 1} 页弹幕获取失败: ${error.message}`);
        break;
      }
    }

    if (cursor && cursor !== 'no_more') {
      log('warn', `[acfun] 弹幕分页达到安全上限 ${MAX_DANMU_PAGES}`);
    }
    return comments;
  }

  async getEpisodeDanmuSegments(value) {
    const { videoId, duration } = await this._resolveVideoContext(value, true);
    if (!videoId) return new SegmentListResponse({ type: 'acfun', segmentList: [], duration: 0 });

    if (!(duration > 0)) {
      return new SegmentListResponse({
        type: 'acfun',
        duration: 0,
        segmentList: [{
          type: 'acfun',
          segment_start: 0,
          segment_end: 30000,
          url: `acfun-full:${videoId}`,
        }],
      });
    }

    const durationMs = Math.ceil(duration * 1000);
    const segmentList = [];
    for (let start = 0; start < durationMs; start += SEGMENT_DURATION_MS) {
      const end = Math.min(start + SEGMENT_DURATION_MS, durationMs);
      segmentList.push({
        type: 'acfun',
        segment_start: start / 1000,
        segment_end: end / 1000,
        url: `acfun:${videoId}:${start}:${end}`,
      });
    }

    return new SegmentListResponse({ type: 'acfun', segmentList, duration });
  }

  async getEpisodeSegmentDanmu(segment) {
    const fullMatch = String(segment?.url || '').match(/^acfun-full:(\d+)$/);
    if (fullMatch) return this.getEpisodeDanmu(fullMatch[1]);

    const match = String(segment?.url || '').match(/^acfun:(\d+):(\d+):(\d+)$/);
    if (!match) return [];
    const [, videoId, positionFromInclude, positionToExclude] = match;

    try {
      const response = await httpPost(globals.makeProxyUrl(ACFUN_DANMU_POSITION_URL), toFormBody({
        resourceId: videoId,
        positionFromInclude,
        positionToExclude,
        enableAdvanced: false,
      }), {
        headers: {
          ...this.headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 6000,
        retries: 1,
      });
      return Array.isArray(response?.data?.danmakus) ? response.data.danmakus : [];
    } catch (error) {
      log('error', `[acfun] 分片弹幕获取失败: ${error.message}`);
      return [];
    }
  }

  formatComments(comments) {
    if (!Array.isArray(comments)) return [];
    return comments.flatMap((comment) => {
      const message = String(comment?.body || '').trim();
      const position = Number(comment?.position || 0) / 1000;
      if (!message || !Number.isFinite(position)) return [];
      const rawMode = Number(comment?.mode || 1);
      const mode = [1, 4, 5].includes(rawMode) ? rawMode : 1;
      const color = Number(comment?.color || 16777215);
      return [{
        cid: Number(comment?.danmakuId || 0),
        p: `${position},${mode},${color},[acfun]`,
        m: message,
        t: position,
        like: Number(comment?.likeCount || 0),
      }];
    });
  }
}
