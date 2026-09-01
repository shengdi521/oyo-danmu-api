const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function jsonData(data, status = 200) {
  return { data, status, headers: { 'content-type': 'application/json' } };
}

test('production bundle completes the Forward danmu chain using Widget.http without fetch', async () => {
  const bundlePath = path.resolve(__dirname, '..', 'dist', 'logvar-danmu.js');
  assert.equal(fs.existsSync(bundlePath), true, 'run npm run build-forward-widget first');

  const calls = [];
  const storage = new Map();
  const Widget = {
    http: {
      async get(url, options = {}) {
        const requestUrl = String(url);
        calls.push({ method: 'GET', url: requestUrl, accept: options.headers?.Accept || '' });
        if (requestUrl.includes('snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search')) {
          return jsonData({
            meta: { status: 200, totalCount: 1 },
            data: [{
              contentId: 'sm9001',
              title: 'Niconico测试动画 第1话',
              thumbnailUrl: 'https://example.com/niconico.jpg',
              startTime: '2026-01-01T00:00:00+09:00',
              commentCounter: 100,
            }],
          });
        }
        if (requestUrl.includes('www.nicovideo.jp/watch/sm9001')) {
          return jsonData({
            meta: { status: 200, code: 'HTTP_200' },
            data: { response: {
              video: {
                id: 'sm9001', title: 'Niconico测试动画 第1话', duration: 1440,
                registeredAt: '2026-01-01T00:00:00+09:00',
                thumbnail: { url: 'https://example.com/niconico.jpg' },
              },
              series: { id: 42, title: 'Niconico测试动画' },
              comment: { nvComment: {
                threadKey: 'bundle-thread-key',
                server: 'https://public.nvcomment.nicovideo.jp',
                params: { targets: [{ id: '100', fork: 'main' }], language: 'ja-jp' },
              } },
            } },
          });
        }
        if (requestUrl.includes('nvapi.nicovideo.jp/v1/series/42')) {
          return jsonData({
            meta: { status: 200 },
            data: { items: [
              { video: { id: 'sm9001', title: 'Niconico测试动画 第1话', duration: 1440, isPaymentRequired: false } },
            ] },
          });
        }
        throw new Error(`Unexpected GET: ${requestUrl}`);
      },
      async post(url, body) {
        const requestUrl = String(url);
        calls.push({ method: 'POST', url: requestUrl });
        assert.equal(requestUrl, 'https://public.nvcomment.nicovideo.jp/v1/threads');
        assert.equal(JSON.parse(String(body)).threadKey, 'bundle-thread-key');
        return jsonData({
          meta: { status: 200 },
          data: { threads: [{ comments: [{
            id: 'bundle-comment-1', vposMs: 12345, body: 'Bundle时间轴弹幕',
            commands: ['ue', 'red'], nicoruCount: 7,
          }] }] },
        });
      },
    },
    storage: {
      get(key) { return storage.get(key); },
      set(key, value) { storage.set(key, value); },
      remove(key) { storage.delete(key); },
    },
  };

  const sandbox = {
    Widget,
    WidgetMetadata: undefined,
    URL,
    Request,
    Response,
    Headers,
    TextEncoder,
    TextDecoder,
    AbortController,
    DOMException,
    Blob,
    DecompressionStream,
    structuredClone,
    crypto,
    atob,
    btoa,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(bundlePath, 'utf8'), { filename: bundlePath }).runInContext(sandbox, { timeout: 3000 });
  assert.equal(typeof sandbox.fetch, 'undefined');

  const params = {
    title: 'Niconico测试动画', type: 'tv', tmdbId: 'bundle-test', season: 1, episode: 1,
    sourceOrder: 'niconico', otherServer: '', customSourceApiUrl: '', vodServers: '',
    vodReturnMode: 'fastest', vodRequestTimeout: 5000, bilibiliCookie: '', doubanCookie: '',
    platformOrder: [], enableAnimeEpisodeFilter: 'false', strictTitleMatch: 'false',
    animeTitleSimplified: 'false', blockedWords: '', groupMinute: 1, danmuLimit: 0,
    danmuSimplifiedTraditional: 'false', danmuOffset: '', convertTopBottomToScroll: 'false',
    convertColor: 'default', colorPool: '16777215', likeSwitch: 'false', proxyUrl: '',
    tmdbApiKey: '', hongguoMergeAllEpisodes: 'false',
  };

  const searchResult = await sandbox.searchDanmu(params);
  assert.equal(searchResult.animes.length, 1);
  const episodes = await sandbox.getDetailById({ ...params, animeId: searchResult.animes[0].animeId });
  assert.equal(episodes.length, 1);
  const segments = await sandbox.getCommentsById({ ...params, commentId: episodes[0].episodeId });
  assert.equal(segments.length, 1);
  const comments = await sandbox.getDanmuWithSegmentTime({ ...params, segmentTime: 12.5 });
  assert.equal(comments.count, 1);
  assert.equal(comments.comments[0].m, 'Bundle时间轴弹幕');
  assert(calls.filter((call) => call.url.includes('/watch/sm9001')).every((call) => call.accept === '*/*'));
});
