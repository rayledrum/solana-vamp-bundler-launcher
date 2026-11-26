const { createStore } = require('./store');
const { fetchPumpCoin, fetchCreatedCoins } = require('../pumpApi');

const STOP = new Set(['coin', 'token', 'sol', 'solana', 'pump', 'fun', 'inu', 'the', 'official']);

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function normalizeLabel(value) {
  const text = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!text || STOP.has(text)) return '';
  return text;
}

function nearLabel(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length < 4 || right.length < 4) return false;
  const short = left.length < right.length ? left : right;
  const long = left.length < right.length ? right : left;
  if (long.includes(short) && short.length / long.length >= 0.8) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let misses = 0;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    if (left[i] !== right[i]) misses += 1;
    if (misses > 1) return false;
  }
  return true;
}

function imageKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const cid = text.match(/(Qm[1-9A-HJ-NP-Za-km-z]{44,}|ba[fy]y[a-z2-7]{20,})/i);
  if (cid) return `ipfs:${cid[1]}`;
  return `url:${text.replace(/\/+$/, '').toLowerCase()}`;
}

function handleOf(value, kind) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (kind === 'website') {
    try {
      return new URL(/^https?:\/\//.test(text) ? text : `https://${text}`).host.replace(/^www\./, '');
    } catch (err) {
      return '';
    }
  }
  const match = text.match(/(?:twitter\.com|x\.com|t\.me)\/@?([a-z0-9_]+)/i);
  if (match) return match[1];
  return text.replace(/^@/, '');
}

function matchReasons(subject, other) {
  const reasons = [];
  const name = normalizeLabel(subject.name);
  const otherName = normalizeLabel(other.name);
  if (nearLabel(name, otherName)) reasons.push('name');
  const symbol = normalizeLabel(subject.symbol);
  const otherSymbol = normalizeLabel(other.symbol);
  if (symbol && otherSymbol && symbol.length >= 2 && symbol === otherSymbol) reasons.push('ticker');
  const image = imageKey(subject.image);
  const otherImage = imageKey(other.image);
  if ((image && image === otherImage) || (subject.imageHash && subject.imageHash === other.imageHash)) reasons.push('image');
  ['twitter', 'telegram', 'website'].forEach(kind => {
    const left = handleOf(subject[kind], kind);
    const right = handleOf(other[kind], kind);
    if (left && left === right) reasons.push(kind);
  });
  return reasons;
}

function formatDelta(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 120) return `${minutes}m later`;
  const hours = ms / 3600000;
  if (hours < 48) return `${hours.toFixed(1)}h later`;
  return `${(hours / 24).toFixed(1)}d later`;
}

function ogDevIsBuying(creator, trades) {
  if (!creator) return null;
  if (!Array.isArray(trades)) return null;
  return trades.some(row => row && row.side === 'buy' && row.wallet === creator);
}

function classifyOrigin(subject, candidates) {
  if (!subject || !subject.mint) return { status: 'unknown', reason: 'Coin identity was not read' };
  if (!Array.isArray(candidates)) return { status: 'unknown', reason: 'Lookalike search was not read' };
  const matches = [];
  candidates.forEach(other => {
    if (!other || !other.mint || other.mint === subject.mint) return;
    const why = matchReasons(subject, other);
    if (why.length) matches.push({ ...other, match: why });
  });
  if (!matches.length) {
    return {
      status: 'og',
      label: 'OG',
      vamps: 0,
      ogDevBuying: null,
      reason: 'No other coin shares this name, ticker, image, or socials'
    };
  }
  const group = [subject, ...matches];
  if (group.some(row => finite(row.createdAt) == null)) {
    return { status: 'unknown', reason: 'Lookalikes were found but creation time is missing' };
  }
  const ordered = group.slice().sort((a, b) => a.createdAt - b.createdAt);
  const og = ordered[0];
  const clones = ordered.slice(1);
  if (og.mint === subject.mint) {
    return {
      status: 'og',
      label: `OG (${clones.length} vamp${clones.length === 1 ? '' : 's'})`,
      vamps: clones.length,
      og: { mint: og.mint, name: og.name || null, createdAt: og.createdAt, graduated: og.graduated == null ? null : og.graduated, peakMcapUsd: finite(og.peakMcapUsd) },
      ogDevBuying: null,
      reason: `Earliest of ${ordered.length} matching coins`
    };
  }
  const vampIndex = clones.findIndex(row => row.mint === subject.mint) + 1;
  const delta = formatDelta(subject.createdAt - og.createdAt);
  const graduated = og.graduated == null ? 'graduation unknown' : (og.graduated ? 'OG graduated' : 'OG has not graduated');
  const peak = finite(og.peakMcapUsd);
  const buying = ogDevIsBuying(og.creator, subject.trades);
  const ogName = og.name || og.symbol || `${og.mint.slice(0, 4)}…`;
  return {
    status: 'vamp',
    label: `VAMP of ${ogName} (#${vampIndex} of ${clones.length})`,
    vamps: clones.length,
    og: {
      mint: og.mint,
      name: og.name || null,
      createdAt: og.createdAt,
      graduated: og.graduated == null ? null : og.graduated,
      peakMcapUsd: peak,
      creator: og.creator || null
    },
    delta,
    ogDevBuying: buying,
    reason: `${delta || 'Created later'} than ${og.mint}. ${graduated}. ${peak == null ? 'OG peak unknown' : `OG peak $${Math.round(peak)}`}`
  };
}

function pairToCoin(pair) {
  if (!pair || !pair.baseToken || !pair.baseToken.address) return null;
  const info = pair.info || {};
  const socials = Array.isArray(info.socials) ? info.socials : [];
  const find = (test) => {
    const row = socials.find(item => test(`${item.type || ''} ${item.url || ''}`));
    return row && row.url || '';
  };
  const website = Array.isArray(info.websites) && info.websites.length
    ? (info.websites[0].url || info.websites[0])
    : '';
  return {
    mint: pair.baseToken.address,
    name: pair.baseToken.name || null,
    symbol: pair.baseToken.symbol || null,
    image: info.imageUrl || null,
    twitter: find(text => /twitter|x\.com/i.test(text)),
    telegram: find(text => /telegram|t\.me/i.test(text)),
    website: website || '',
    createdAt: finite(pair.pairCreatedAt),
    graduated: pair.dexId === 'pumpswap' ? true : pair.dexId === 'pumpfun' ? false : null,
    peakMcapUsd: finite(pair.peakMcapUsd != null ? pair.peakMcapUsd : pair.athMarketCap),
    creator: pair.creator || null
  };
}

function coinFromPump(coin, mint) {
  if (!coin || typeof coin !== 'object') return null;
  const address = coin.mint || mint;
  if (!address) return null;
  return {
    mint: address,
    name: coin.name || null,
    symbol: coin.symbol || null,
    image: coin.image_uri || coin.image || null,
    twitter: coin.twitter || '',
    telegram: coin.telegram || '',
    website: coin.website || '',
    createdAt: finite(coin.created_timestamp),
    graduated: coin.complete == null ? null : Boolean(coin.complete),
    peakMcapUsd: finite(coin.ath_market_cap != null ? coin.ath_market_cap : coin.peak_market_cap),
    creator: coin.creator || null
  };
}

function createOriginLookup({ fetchJson, ttlMs = 60_000, readTrades } = {}) {
  const cache = new Map();
  const fetchImpl = fetchJson || (async (url) => {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      let host = url;
      try { host = new URL(url).host; } catch (err) { host = url; }
      throw new Error(`HTTP ${response.status} from ${host}`);
    }
    return response.json();
  });
  const tradesFor = readTrades || ((mint) => {
    try {
      const tape = createStore().readJsonl('tapes.jsonl').filter(row => row && row.mint === mint).pop();
      return tape && Array.isArray(tape.trades) ? tape.trades : null;
    } catch (err) {
      return null;
    }
  });

  async function search(query) {
    const body = await fetchImpl(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
    return Array.isArray(body && body.pairs) ? body.pairs.map(pairToCoin).filter(Boolean) : [];
  }

  async function pumpCoin(mint) {
    const response = async (url) => {
      try {
        const body = await fetchImpl(url);
        return { ok: true, status: 200, json: async () => body };
      } catch (err) {
        const matched = /HTTP (\d+)/.exec(err && err.message || '');
        return { ok: false, status: matched ? Number(matched[1]) : 500, json: async () => ({}) };
      }
    };
    try {
      return coinFromPump(await fetchPumpCoin(mint, { fetch: response }), mint);
    } catch (err) {
      return null;
    }
  }

  async function get(mint) {
    const key = String(mint || '').trim();
    if (!key) return { status: 'unknown', reason: 'A mint is required' };
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < ttlMs) return cached.result;
    let result;
    try {
      let subject = null;
      try {
        const body = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(key)}`);
        const pairs = Array.isArray(body && body.pairs) ? body.pairs.map(pairToCoin).filter(row => row && row.mint === key) : [];
        if (pairs.length) subject = pairs.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
      } catch (err) {
        subject = null;
      }
      if (!subject) subject = await pumpCoin(key);
      if (!subject || (!subject.name && !subject.symbol && !subject.image && !subject.twitter && !subject.telegram && !subject.website)) {
        result = { status: 'unknown', reason: 'Coin name, image, and socials were not read' };
      } else {
        subject.trades = tradesFor(key);
        const query = subject.symbol || subject.name;
        let candidates = null;
        if (query) {
          try { candidates = await search(query); } catch (err) { candidates = null; }
        }
        if (subject.creator && candidates) {
          try {
            const created = await fetchCreatedCoins(subject.creator, 0, {
              fetch: async (url) => {
                const body = await fetchImpl(url);
                return { ok: true, status: 200, json: async () => body };
              }
            });
            const extra = (created && created.coins ? created.coins : Array.isArray(created) ? created : []).map(row => coinFromPump(row));
            candidates = candidates.concat(extra);
          } catch (err) {
            // A creator list that fails does not erase a search that succeeded.
          }
        }
        result = classifyOrigin(subject, candidates);
        if (result.status === 'vamp' && result.og && result.og.mint && !result.og.creator) {
          try {
            const rug = await fetchImpl(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(result.og.mint)}/report`);
            result.og.creator = rug && (rug.creator || rug.creatorAddress) || null;
            result.ogDevBuying = ogDevIsBuying(result.og.creator, subject.trades);
          } catch (err) {
            result.ogDevBuying = result.ogDevBuying == null ? null : result.ogDevBuying;
          }
        }
      }
    } catch (err) {
      result = { status: 'unknown', reason: `Lookalike search failed: ${err.message}` };
    }
    cache.set(key, { at: Date.now(), result });
    return result;
  }

  return { get, cache };
}

const originLookup = createOriginLookup({});

module.exports = {
  classifyOrigin,
  normalizeLabel,
  imageKey,
  createOriginLookup,
  pairToCoin,
  originLookup
};
