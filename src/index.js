/**
 * EAFC Card Price Server
 * Node.js Server - 卡价查询后端 (部署到 Render)
 */

const { fetch } = require('undici');
const http = require('http');

// 内存缓存：definitionId -> { price, timestamp }
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟
const priceCache = new Map();

// 正在进行的请求（去重用）：definitionId -> Promise
const pendingRequests = new Map();

// futbin.org API 端点
const FUTBIN_API = {
  STC_CHEAPEST: 'https://www.futbin.org/futbin/api/26/getSTCCheapest',
};

const PORT = process.env.PORT || 8787;

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 测试端点
  if (url.pathname === '/test') {
    const futbinUrl = 'https://www.futbin.org/futbin/api/26/getSTCCheapest?definitionId=239653';
    try {
      const resp = await fetch(futbinUrl);
      const body = await resp.text();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: resp.status,
        statusText: resp.statusText,
        body: body.substring(0, 500),
      }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 简单测试端点
  if (url.pathname === '/hello') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello World');
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

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  // 处理 POST 请求
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      let parsedBody;
      try {
        parsedBody = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body must be an object' }));
        return;
      }

      if (!('definitionIds' in parsedBody)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: definitionIds' }));
        return;
      }

      const { definitionIds } = parsedBody;

      if (!Array.isArray(definitionIds)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'definitionIds must be an array' }));
        return;
      }

      if (definitionIds.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'definitionIds must not be empty' }));
        return;
      }

      if (definitionIds.length > 20) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many definitionIds, max 20 per request' }));
        return;
      }

      for (let i = 0; i < definitionIds.length; i++) {
        const id = definitionIds[i];
        if (typeof id !== 'number' || !Number.isInteger(id) || id < 1000 || id > 200000000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid definitionId at index ${i}: must be an integer between 1000 and 200000000` }));
          return;
        }
      }

      const uniqueIds = [...new Set(definitionIds)];
      const prices = await batchGetPrices(uniqueIds);

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
});

async function batchGetPrices(definitionIds) {
  const result = {};
  for (const id of definitionIds) {
    result[id] = await getPrice(id);
  }
  return result;
}

async function getPrice(definitionId) {
  // 检查缓存
  if (priceCache.has(definitionId)) {
    const cached = priceCache.get(definitionId);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached;
    }
    priceCache.delete(definitionId);
  }

  // 检查是否有正在进行的请求（去重用）
  if (pendingRequests.has(definitionId)) {
    return pendingRequests.get(definitionId);
  }

  // 创建新请求
  const request = fetchPrice(definitionId).finally(() => {
    pendingRequests.delete(definitionId);
  });

  pendingRequests.set(definitionId, request);
  return request;
}

async function fetchPrice(definitionId) {
  try {
    const url = `${FUTBIN_API.STC_CHEAPEST}?definitionId=${definitionId}`;
    const response = await fetch(url, {
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
    });

    if (!response.ok) {
      throw new Error(`Futbin API returned ${response.status}`);
    }

    const data = await response.json();
    const price = parsePrice(data);
    priceCache.set(definitionId, { price, timestamp: Date.now() });
    return { price };
  } catch (err) {
    console.error(`Failed to fetch price for ${definitionId}:`, err.message);
    return { price: null, error: err.message };
  }
}

function parsePrice(data) {
  if (!data || !data.data || !data.data.players) return null;
  
  const players = data.data.players;
  for (const key of Object.keys(players)) {
    const playerData = players[key];
    if (playerData.data && playerData.data.players && playerData.data.players.length > 0) {
      return playerData.data.players[0].LCPrice ?? null;
    }
  }
  
  return null;
}

server.listen(PORT, () => {
  console.log(`EAFC Price Server running on http://localhost:${PORT}`);
});
