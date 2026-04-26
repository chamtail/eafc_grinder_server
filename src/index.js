/**
 * EAFC Grinder Server
 * Node.js Server - 卡价查询后端
 *
 * 客户端传 definitionIds + platform 查价格
 * - 如果服务端有 definitionId -> futbinId 映射，用 fetchPlayerInformationMinimal 查
 * - 如果没有映射，用 getFilteredPlayers 查（需要客户端传球员属性）
 * - 映射持久化到 mapping.json
 */

const { fetch } = require('undici');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const FUTBIN_YEAR = 26;
const FUTBIN_BASE = 'https://www.futbin.org/futbin/api/' + FUTBIN_YEAR;
const PORT = process.env.PORT || 8787;
const CACHE_TTL = 30 * 60 * 1000;       // 30 分钟（成功缓存）
const FAIL_CACHE_TTL = 5 * 60 * 1000;   // 5 分钟（失败缓存）
const MAPPING_FILE = path.join(__dirname, '..', 'mapping.json');
const FUTBIN_CONCURRENCY = 20;          // 同时向 futbin 发出的最大请求数

// ========== Futbin 全局并发控制 ==========
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
// 映射表: definitionId -> futbinId (平台通用)
let idMapping = {};

// 价格缓存: platform -> definitionId -> { price, timestamp, error? }
const priceCache = {};  // { pc: Map, ps: Map }

// 正在进行的请求: `${platform}:${definitionId}` -> Promise
const pendingRequests = new Map();

// ========== 初始化 ==========
loadMapping();
ensureCacheMaps();

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
      mappingCount: Object.keys(idMapping).length,
      cacheSize: {
        pc: priceCache.pc?.size || 0,
        ps: priceCache.ps?.size || 0,
      },
      pending: pendingRequests.size,
    }));
    return;
  }

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // 价格查询接口: POST /api/prices
  if (req.method === 'POST' && url.pathname === '/api/prices') {
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

// ========== 请求处理 ==========
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
  // 并行请求所有 ID
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
  const cacheKey = `${platform}:${definitionId}`;

  // 检查缓存
  const cacheMap = priceCache[platform];
  if (cacheMap.has(definitionId)) {
    const cached = cacheMap.get(definitionId);
    const ttl = cached.error ? FAIL_CACHE_TTL : CACHE_TTL;
    if (Date.now() - cached.timestamp < ttl) {
      console.log(`[Cache HIT] ${definitionId}`);
      return cached;
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
    // 有映射，用 fetchPlayerInformationMinimal
    return await fetchPriceByFutbinId(definitionId, futbinId, platform);
  }

  // 没有映射，需要球员属性
  if (!playerInfo) {
    return { price: null, error: 'No mapping found and no player info provided' };
  }

  // 用 getFilteredPlayers 查，同时建立映射
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

    // 建立并保存映射
    if (match.ID && !idMapping[definitionId]) {
      idMapping[definitionId] = match.ID;
      saveMapping();
      console.log(`[Mapping] definitionId=${definitionId} -> futbinId=${match.ID}`);
    }

    // 同时缓存其他返回的球员映射和价格
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
    // 验证 definitionId 一致性
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

// ========== 日志文件 ==========
const logFile = path.join(__dirname, '..', 'server.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
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
});
