/**
 * EAFC Grinder Server
 * Node.js Server - 卡价查询后端
 *
 * 主数据源：futnext（启动时全量缓存 + 定时刷新）
 * 兜底数据源：futbin（缓存未命中时使用）
 * 启动时阻塞请求直到首次缓存构建完成
 */

const { fetch } = require('undici');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ========== 配置 ==========
const FUTBIN_YEAR = 26;
const FUTBIN_BASE = 'https://www.futbin.org/futbin/api/' + FUTBIN_YEAR;
const PORT = process.env.PORT || 8787;
const CACHE_TTL = 30 * 60 * 1000;       // 30 分钟（futbin 成功缓存）
const FAIL_CACHE_TTL = 5 * 60 * 1000;   // 5 分钟（futbin 失败缓存）
const MAPPING_FILE = path.join(__dirname, '..', 'mapping.json');
const FUTBIN_CONCURRENCY = 20;          // 同时向 futbin 发出的最大请求数
const FUTNEXT_CONCURRENCY = 2;          // futnext 全量加载并发数
const FUTNEXT_REFRESH_INTERVAL = 10 * 60 * 1000;  // 10 分钟刷新间隔
const FUTNEXT_BASE_URL = 'https://www.futnext.com/player';
const FUTNEXT_CURL_ARGS = [
  '-s',
  '-4',
  '--connect-timeout', '10',
  '-H', 'accept: */*',
  '-H', 'accept-language: zh-CN,zh;q=0.9,en;q=0.8',
  '-H', 'rsc: 1',
  '-H', 'next-router-state-tree: %5B%22%22%2C%7B%22children%22%3A%5B%22(main)%22%2C%7B%22children%22%3A%5B%22player%22%2C%7B%22children%22%3A%5B%22__PAGE__%3F%7B%5C%22page%5C%22%3A%5C%221%5C%22%7D%22%2C%7B%7D%2C%22%2Fplayer%3Fpage%3D1%22%2C%22refresh%22%5D%7D%5D%7D%5D%7D%2Cnull%2C%22refetch%22%5D',
  '-H', 'referer: https://www.futnext.com/player',
  '-H', 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
  '-H', 'sec-ch-ua: "Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  '-H', 'sec-ch-ua-mobile: ?0',
  '-H', 'sec-ch-ua-platform: "Windows"',
  '-H', 'sec-fetch-dest: empty',
  '-H', 'sec-fetch-mode: cors',
  '-H', 'sec-fetch-site: same-origin',
];

async function fetchFutnextPage(page, retries = 1) {
  const targetUrl = `${FUTNEXT_BASE_URL}?page=${page}&_rsc=19q82`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile('curl', [targetUrl, ...FUTNEXT_CURL_ARGS], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
          if (error) return reject(error);
          if (!stdout) return reject(new Error(`empty response for page ${page}`));
          resolve(stdout);
        });
      });
      return stdout;
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500));
      } else {
        throw err;
      }
    }
  }
}
const futbinQueue = [];
let futbinActive = 0;

function futbinEnqueue(fn) {
  return new Promise((resolve, reject) => {
    futbinQueue.push({ fn, resolve, reject });
    futbinDrain();
  });
}

function futbinDrain() {
  while (futbinActive < FUTBIN_CONCURRENCY && futbinQueue.length > 0) {
    const { fn, resolve, reject } = futbinQueue.shift();
    futbinActive++;
    fn().then(resolve, reject).finally(() => {
      futbinActive--;
      futbinDrain();
    });
  }
}

// ========== 数据存储 ==========
// futnext 全量缓存: definitionId -> { cheapestPrice, averagePrice, timestamp }
let futnextCache = new Map();
let cacheReady = false;

// 映射表: definitionId -> futbinId (平台通用)
let idMapping = {};

// futbin 价格缓存: platform -> definitionId -> { price, timestamp, error? }
const priceCache = {};  // { pc: Map, ps: Map }

// 正在进行的请求: `${platform}:${definitionId}` -> Promise
const pendingRequests = new Map();

// ========== 初始化 ==========
loadMapping();
ensureCacheMaps();

// ========== Futnext 全量加载 ==========
let isLoading = false;

async function loadFutnextCache() {
  if (isLoading) {
    console.log(`[Futnext] Load already in progress, skipping`);
    return;
  }
  isLoading = true;
  const start = Date.now();
  console.log(`[Futnext] Starting full cache load...`);

  // 第1页获取 totalPages
  const firstPageRaw = await fetchFutnextPage(1);
  const totalPages = parseFutnextTotalPages(firstPageRaw);
  if (!totalPages) {
    console.error(`[Futnext] Failed to get totalPages, aborting load`);
    isLoading = false;
    return;
  }
  console.log(`[Futnext] totalPages: ${totalPages}`);

  // 解析第1页并写入临时缓存
  const newCache = new Map();
  mergePageIntoCache(newCache, firstPageRaw);

  // 并发加载剩余页面（2..totalPages），2并发
  const pages = [];
  for (let i = 2; i <= totalPages; i++) pages.push(i);

  for (let i = 0; i < pages.length; i += FUTNEXT_CONCURRENCY) {
    const batch = pages.slice(i, i + FUTNEXT_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(page => fetchFutnextPage(page))
    );

    let successCount = 0;
    let failCount = 0;
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const page = batch[j];
      if (r.status === 'fulfilled') {
        try {
          mergePageIntoCache(newCache, r.value);
          console.log(`[Futnext] Page ${page}/${totalPages} OK, cache: ${newCache.size}`);
        } catch (e) {
          console.error(`[Futnext] Page ${page}/${totalPages} parse error: ${e.message}`);
        }
      } else {
        console.error(`[Futnext] Page ${page}/${totalPages} fetch error: ${r.reason?.message}`);
      }
    }
  }

  // 原子替换
  futnextCache = newCache;
  const elapsed = Date.now() - start;
  console.log(`[Futnext] Cache load complete: ${newCache.size} players in ${elapsed}ms`);

  isLoading = false;
}

function mergePageIntoCache(cache, raw) {
  const players = parseFutnextRSC(raw);
  for (const p of players) {
    if (p.id == null) continue;
    // id 是每张卡的唯一标识，直接缓存
    // null 价格当作 0 缓存
    cache.set(p.id, {
      cheapestPrice: p.cheapestPrice ?? 0,
      averagePrice: p.averagePrice ?? 0,
    });
  }
}

// ========== HTTP Server ==========
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 健康检查
  if (url.pathname === '/hello') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // 统计信息
  if (url.pathname === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cacheReady,
      futnextCacheSize: futnextCache.size,
      mappingCount: Object.keys(idMapping).length,
      cacheSize: {
        pc: priceCache.pc?.size || 0,
        ps: priceCache.ps?.size || 0,
      },
      pending: pendingRequests.size,
    }));
    return;
  }

  // 全量价格查询
  if (req.method === 'GET' && url.pathname === '/api/all-prices') {
    if (!cacheReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server is warming up, please retry later' }));
      return;
    }
    const platform = url.searchParams.get('platform');
    const allPrices = {};
    for (const [id, data] of futnextCache) {
      if (data.cheapestPrice != null) {
        allPrices[id] = data.cheapestPrice;
      }
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ platform: platform || 'all', count: Object.keys(allPrices).length, prices: allPrices }));
    return;
  }

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // 价格查询接口: POST /api/prices
  if (req.method === 'POST' && url.pathname === '/api/prices') {
    if (!cacheReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server is warming up, please retry later' }));
      return;
    }
    handlePriceQuery(req, res);
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// ========== 请求处理 ==========
function handlePriceQuery(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const parsedBody = parseJsonBody(body);
      if (!parsedBody) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      console.log('[Request]', parsedBody.definitionIds.length, 'ids:', parsedBody.definitionIds.join(', '));

      const validation = validateRequest(parsedBody);
      if (!validation.valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: validation.error }));
        return;
      }

      const { definitionIds, platform, players } = parsedBody;
      const uniqueIds = [...new Set(definitionIds)];
      const prices = await batchGetPrices(uniqueIds, platform, players || {});

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ prices }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
    }
  });
}

function parseJsonBody(body) {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

function isPositiveInteger(val) {
  return typeof val === 'number' && Number.isInteger(val) && val > 0;
}

function isValidDefinitionId(val) {
  return typeof val === 'number' && Number.isInteger(val) && val >= 1000 && val <= 200000000;
}

function validateRequest(body) {
  if (!('definitionIds' in body)) {
    return { valid: false, error: 'Missing required field: definitionIds' };
  }
  if (!Array.isArray(body.definitionIds)) {
    return { valid: false, error: 'definitionIds must be an array' };
  }
  if (body.definitionIds.length === 0) {
    return { valid: false, error: 'definitionIds must not be empty' };
  }
  if (body.definitionIds.length > 50) {
    return { valid: false, error: 'Too many definitionIds, max 50 per request' };
  }
  if (!body.platform || !['pc', 'ps'].includes(body.platform)) {
    return { valid: false, error: 'platform must be "pc" or "ps"' };
  }
  for (let i = 0; i < body.definitionIds.length; i++) {
    const id = body.definitionIds[i];
    if (!isValidDefinitionId(id)) {
      return { valid: false, error: `Invalid definitionId at index ${i}: must be an integer between 1000 and 200000000` };
    }
  }
  if (body.players) {
    if (typeof body.players !== 'object' || Array.isArray(body.players)) {
      return { valid: false, error: 'players must be an object keyed by definitionId' };
    }
    const required = ['nationId', 'leagueId', 'teamId', 'rating'];
    for (const [key, p] of Object.entries(body.players)) {
      if (!p || typeof p !== 'object') {
        return { valid: false, error: `Invalid player data for definitionId ${key}` };
      }
      for (const field of required) {
        if (!isPositiveInteger(p[field])) {
          return { valid: false, error: `Player ${key} must have a positive integer for: ${field}` };
        }
      }
    }
  }
  return { valid: true };
}

// ========== 价格查询 ==========
async function batchGetPrices(definitionIds, platform, players) {
  const start = Date.now();
  const results = await Promise.all(
    definitionIds.map(id => getPrice(id, platform, players[id] || null))
  );
  const result = {};
  let hitCount = 0;
  definitionIds.forEach((id, i) => {
    result[id] = results[i];
    if (results[i].price != null) hitCount++;
  });
  console.log(`[Batch] ${definitionIds.length} ids, ${hitCount} prices, ${Date.now() - start}ms`);
  return result;
}

async function getPrice(definitionId, platform, playerInfo) {
  definitionId = Number(definitionId);

  // 1. 先查 futnextCache（pc/ps 共用）
  const cached = futnextCache.get(definitionId);
  if (cached) {
    return { price: cached.cheapestPrice };
  }

  // 2. 缓存未命中，走 futbin 兜底
  const cacheKey = `${platform}:${definitionId}`;

  // 检查 futbin 缓存
  const cacheMap = priceCache[platform];
  if (cacheMap.has(definitionId)) {
    const futbinCached = cacheMap.get(definitionId);
    const ttl = futbinCached.error ? FAIL_CACHE_TTL : CACHE_TTL;
    if (Date.now() - futbinCached.timestamp < ttl) {
      console.log(`[Futbin Cache HIT] ${definitionId}`);
      return futbinCached;
    }
    cacheMap.delete(definitionId);
  }

  // 检查是否有正在进行的请求（去重用）
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  // 创建新请求
  const request = doFetchPrice(definitionId, platform, playerInfo).finally(() => {
    pendingRequests.delete(cacheKey);
  });

  pendingRequests.set(cacheKey, request);
  return request;
}

async function doFetchPrice(definitionId, platform, playerInfo) {
  const futbinId = idMapping[definitionId];

  if (futbinId) {
    return await fetchPriceByFutbinId(definitionId, futbinId, platform);
  }

  if (!playerInfo) {
    return { price: null, error: 'No mapping found and no player info provided' };
  }

  return await fetchPriceByFilter(definitionId, playerInfo, platform);
}

async function fetchPriceByFutbinId(definitionId, futbinId, platform) {
  try {
    const platformParam = platform === 'pc' ? 'PC' : 'PS';
    const url = `${FUTBIN_BASE}/fetchPlayerInformationMinimal?ID=${futbinId}&platform=${platformParam}`;
    const response = await fetchWithHeaders(url);

    if (!response.ok) {
      throw new Error(`Futbin API returned ${response.status}`);
    }

    const data = await response.json();
    const price = parsePriceFromMinimal(data, definitionId, platform);

    priceCache[platform].set(definitionId, { price: price || 0, timestamp: Date.now() });
    return { price: price || 0 };
  } catch (err) {
    console.error(`Failed to fetch price for ${definitionId} (futbinId=${futbinId}):`, err.message);
    return { price: null, error: err.message };
  }
}

async function fetchPriceByFilter(definitionId, playerInfo, platform) {
  try {
    const platformParam = platform === 'pc' ? 'PC' : 'PS';
    const url = `${FUTBIN_BASE}/getFilteredPlayers?platform=${platformParam}` +
      `&nation=${playerInfo.nationId}` +
      `&league=${playerInfo.leagueId}` +
      `&rating=${playerInfo.rating}-${playerInfo.rating}` +
      `&club=${playerInfo.teamId}` +
      `&sort=rating&order=desc&page=1`;

    const response = await fetchWithHeaders(url);

    if (!response.ok) {
      throw new Error(`Futbin API returned ${response.status}`);
    }

    const data = await response.json();
    const priceKey = platform === 'pc' ? 'pc_LCPrice' : 'ps_LCPrice';

    if (!data.data || !Array.isArray(data.data)) {
      return { price: null, error: 'Invalid response from Futbin' };
    }

    const match = data.data.find(item => item.resource_id === definitionId);
    if (!match) {
      return { price: null, error: 'Player not found in filtered results' };
    }

    if (match.ID && !idMapping[definitionId]) {
      idMapping[definitionId] = match.ID;
      saveMapping();
      console.log(`[Mapping] definitionId=${definitionId} -> futbinId=${match.ID}`);
    }

    const now = Date.now();
    for (const item of data.data) {
      const rid = Number(item.resource_id);
      if (rid && item.ID && !idMapping[rid]) {
        idMapping[rid] = item.ID;
      }
      if (rid) {
        const itemPrice = item[priceKey] || 0;
        if (itemPrice > 0 && !priceCache[platform].has(rid)) {
          priceCache[platform].set(rid, { price: itemPrice, timestamp: now });
        }
      }
    }
    saveMapping();

    const price = match[priceKey] || 0;
    priceCache[platform].set(definitionId, { price, timestamp: Date.now() });
    return { price };
  } catch (err) {
    console.error(`Failed to fetch price for ${definitionId} (filter):`, err.message);
    return { price: null, error: err.message };
  }
}

// ========== Futbin API 解析 ==========
function parsePriceFromMinimal(data, definitionId, platform) {
  if (!data.data || !Array.isArray(data.data)) return null;

  const priceKey = platform === 'pc' ? 'pc_LCPrice' : 'ps_LCPrice';

  for (const item of data.data) {
    if (item.Player_Resource === definitionId || item.resource_id === definitionId) {
      const price = item.LCPrice || item[priceKey] || item.price || 0;
      return price;
    }
  }

  return null;
}

// ========== 通用请求（受全局并发控制） ==========
function fetchWithHeaders(url) {
  return futbinEnqueue(() => fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    },
  }));
}

// ========== 映射持久化 ==========
function loadMapping() {
  try {
    if (fs.existsSync(MAPPING_FILE)) {
      const data = fs.readFileSync(MAPPING_FILE, 'utf8');
      idMapping = JSON.parse(data);
      console.log(`[Mapping] Loaded ${Object.keys(idMapping).length} entries from ${MAPPING_FILE}`);
    }
  } catch (err) {
    console.error(`[Mapping] Failed to load mapping:`, err.message);
    idMapping = {};
  }
}

function saveMapping() {
  try {
    fs.writeFileSync(MAPPING_FILE, JSON.stringify(idMapping, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Mapping] Failed to save mapping:`, err.message);
  }
}

function ensureCacheMaps() {
  priceCache.pc = new Map();
  priceCache.ps = new Map();
}

// ========== Futnext RSC 解析 ==========
function parseFutnextTotalPages(raw) {
  const lines = raw.trim().split('\n');
  const lastLine = lines[lines.length - 1];
  const after = lastLine.replace(/^12:/, '');
  const match = after.match(/"totalPages":(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseFutnextRSC(raw) {
  const lines = raw.trim().split('\n');
  const lastLine = lines[lines.length - 1];
  const after = lastLine.replace(/^12:/, '');

  const resultsIdx = after.indexOf('{"results":');
  if (resultsIdx < 0) throw new Error('results not found in RSC payload');

  let depth = 0;
  let started = false;
  let endIdx = resultsIdx;
  for (let i = resultsIdx; i < after.length; i++) {
    if (after[i] === '{') { depth++; started = true; }
    if (after[i] === '}') { depth--; }
    if (started && depth === 0) { endIdx = i; break; }
  }

  const resultsJson = after.substring(resultsIdx, endIdx + 1);
  const data = JSON.parse(resultsJson);
  const r = data.results;

  return r.players.map(p => ({
    id: p.id || null,
    name: ((p.definition?.firstName || '') + ' ' + (p.definition?.lastName || '')).trim(),
    rating: p.rating || null,
    cheapestPrice: p.price?.cheapestPrice ?? null,
    averagePrice: p.price?.averagePrice ?? null,
    rarity: p.rarity ? { id: p.rarity.id, name: p.rarity.name } : null,
    nation: p.nation ? { id: p.nation.id, name: p.nation.name } : null,
    league: p.league ? { id: p.league.id, name: p.league.name } : null,
    club: p.club ? { id: p.club.id, name: p.club.name } : null,
  }));
}

// ========== 日志文件 ==========
const logFile = path.join(__dirname, '..', 'server.log');
const logStream = fs.createWriteStream(logFile, { flags: 'w' });
const _log = console.log;
const _error = console.error;
const _warn = console.warn;
console.log = function (...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  logStream.write(line + '\n');
  _log(line);
};
console.error = function (...args) {
  const line = `[${new Date().toISOString()}] ERROR: ${args.join(' ')}`;
  logStream.write(line + '\n');
  _error(line);
};
console.warn = function (...args) {
  const line = `[${new Date().toISOString()}] WARN: ${args.join(' ')}`;
  logStream.write(line + '\n');
  _warn(line);
};

// ========== 启动 ==========
server.listen(PORT, () => {
  console.log(`EAFC Grinder Server running on http://localhost:${PORT}`);

  // 启动时全量加载
  (async () => {
    try {
      await loadFutnextCache();
      cacheReady = true;
      console.log(`[Futnext] Cache ready, accepting requests`);
    } catch (err) {
      console.error(`[Futnext] Initial load failed: ${err.message}`);
      // 即使失败也标记 ready，允许 futbin 兜底
      cacheReady = true;
      console.warn(`[Futnext] Falling back to futbin-only mode`);
    }
  })();

  // 定时刷新
  setInterval(async () => {
    try {
      await loadFutnextCache();
    } catch (err) {
      console.error(`[Futnext] Refresh failed: ${err.message}`);
    }
  }, FUTNEXT_REFRESH_INTERVAL);
});
