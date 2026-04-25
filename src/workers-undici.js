/**
 * EAFC Card Price Server - Cloudflare Workers with nodejs_compat
 */

let fetchImpl;
let fetchType = 'unknown';
try {
  const undici = await import('undici');
  if (undici.fetch && typeof undici.fetch === 'function') {
    fetchImpl = undici.fetch;
    fetchType = 'undici';
  } else {
    throw new Error('undici.fetch is not a function');
  }
} catch (e) {
  fetchImpl = globalThis.fetch;
  fetchType = 'global (fallback)';
}

const CACHE_TTL = 30 * 60 * 1000;
const priceCache = new Map();
const pendingRequests = new Map();

const FUTBIN_API = {
  STC_CHEAPEST: 'https://www.futbin.org/futbin/api/26/getSTCCheapest',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (url.pathname === '/test') {
      return new Response(JSON.stringify({
        fetchType: fetchType,
        test: 'calling futbin...',
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    
    if (url.pathname === '/test-futbin') {
      try {
        const resp = await fetchImpl('https://www.futbin.org/futbin/api/26/getSTCCheapest?definitionId=239653');
        const body = await resp.text();
        return new Response(JSON.stringify({
          fetchType: fetchType,
          status: resp.status,
          body: body.substring(0, 500),
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({
          fetchType: fetchType,
          error: e.message,
        }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const body = await request.json();
      if (!body || !Array.isArray(body.definitionIds)) {
        return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      const { definitionIds } = body;
      if (definitionIds.length === 0 || definitionIds.length > 20) {
        return new Response(JSON.stringify({ error: 'definitionIds must have 1-20 items' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      const uniqueIds = [...new Set(definitionIds)];
      const prices = await batchGetPrices(uniqueIds);

      return new Response(JSON.stringify({ prices }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }
};

async function batchGetPrices(definitionIds) {
  const result = {};
  for (const id of definitionIds) {
    result[id] = await getPrice(id);
  }
  return result;
}

async function getPrice(definitionId) {
  if (priceCache.has(definitionId)) {
    const cached = priceCache.get(definitionId);
    if (Date.now() - cached.timestamp < CACHE_TTL) return cached;
    priceCache.delete(definitionId);
  }

  if (pendingRequests.has(definitionId)) {
    return pendingRequests.get(definitionId);
  }

  const request = fetchPrice(definitionId).finally(() => {
    pendingRequests.delete(definitionId);
  });

  pendingRequests.set(definitionId, request);
  return request;
}

async function fetchPrice(definitionId) {
  try {
    const url = `${FUTBIN_API.STC_CHEAPEST}?definitionId=${definitionId}`;
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
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
