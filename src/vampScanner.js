const axios = require('axios');
const config = require('./config');

const SOURCE_TIMEOUT_MS = 6000;
const SOURCE_CACHE_MS = 60 * 1000;
const SOL = 'So11111111111111111111111111111111111111112';
const PUMP_DESC_PAGES = [
  { offset: 0, low: 5100000, high: Infinity },
  { offset: 50, low: 1700000, high: 5100000 },
  { offset: 150, low: 640000, high: 1000000 },
  { offset: 200, low: 440000, high: 650000 },
  { offset: 250, low: 340000, high: 450000 },
  { offset: 300, low: 260000, high: 350000 },
  { offset: 400, low: 160000, high: 220000 },
  { offset: 500, low: 100000, high: 160000 }
];

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function positiveOrNull(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function timeMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && value.includes('-')) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount < 1e12 ? amount * 1000 : amount;
}

function pumpCoinsUrl({ offset = 0, sort = 'market_cap', order = 'DESC', complete = null } = {}) {
  let url = `https://frontend-api-v3.pump.fun/coins?offset=${offset}&limit=50&sort=${sort}&order=${order}&includeNsfw=false`;
  if (complete === false) url += '&complete=false';
  return url;
}

class VampScanner {
  constructor() {
    this.sourceCache = new Map();
  }

  clearSourceCache() {
    this.sourceCache.clear();
  }

  async cachedGet(url) {
    const hit = this.sourceCache.get(url);
    if (hit && Date.now() - hit.at < SOURCE_CACHE_MS) return hit.data;
    const res = await axios.get(url, {
      timeout: SOURCE_TIMEOUT_MS,
      headers: { Accept: 'application/json' }
    });
    this.sourceCache.set(url, { at: Date.now(), data: res.data });
    return res.data;
  }

  tokensFromGecko(data, dexId) {
    const included = {};
    for (const item of (data && data.included) || []) {
      included[item.id] = item.attributes || {};
    }
    const tokens = [];
    for (const pool of (data && data.data) || []) {
      const rel = pool.relationships || {};
      const base = included[rel.base_token?.data?.id] || {};
      const quote = included[rel.quote_token?.data?.id] || {};
      if (!base.address) continue;
      if (quote.address && quote.address !== SOL) continue;
      const attrs = pool.attributes || {};
      const change = attrs.price_change_percentage || {};
      tokens.push({
        tokenAddress: base.address,
        name: base.name || attrs.name || base.address.slice(0, 6),
        symbol: base.symbol || 'PUMP',
        description: `${base.name || 'Pump.fun coin'} · ${dexId}`,
        icon: base.image_url || '',
        socials: {},
        twitter: '',
        telegram: '',
        website: '',
        links: [],
        metrics: {
          priceUsd: attrs.base_token_price_usd ?? null,
          priceNative: attrs.base_token_price_native_currency ?? null,
          mcap: finiteOrNull(attrs.market_cap_usd != null ? attrs.market_cap_usd : attrs.fdv_usd),
          volume24h: finiteOrNull(attrs.volume_usd && attrs.volume_usd.h24),
          liquidityUsd: finiteOrNull(attrs.reserve_in_usd),
          createdAt: timeMs(attrs.pool_created_at),
          priceChange24h: finiteOrNull(change.h24),
          dexId
        }
      });
    }
    return tokens;
  }

  tokenFromPumpCoin(coin) {
    const mcap = finiteOrNull(coin.usd_market_cap != null ? coin.usd_market_cap : coin.market_cap);
    return {
      tokenAddress: coin.mint,
      name: coin.name || coin.symbol || coin.mint.slice(0, 6),
      symbol: coin.symbol || 'PUMP',
      description: coin.description || '',
      icon: coin.image_uri || '',
      socials: { twitter: coin.twitter || '', telegram: '', website: coin.website || '' },
      twitter: coin.twitter || '',
      telegram: '',
      website: coin.website || '',
      links: [],
      metrics: {
        priceUsd: null,
        mcap,
        volume24h: finiteOrNull(coin.volume_24h != null ? coin.volume_24h : coin.volume),
        liquidityUsd: finiteOrNull(coin.canonical_pool_liquidity_usd != null ? coin.canonical_pool_liquidity_usd : coin.liquidity),
        createdAt: timeMs(coin.created_timestamp),
        priceChange24h: null,
        dexId: coin.complete ? 'pump-graduated' : 'pump'
      }
    };
  }

  // Descending market-cap pages are included only when the requested max still
  // reaches that page. The first page is multi-million coins, so a $1M max skips it.
  pumpDescOffsets({ minMcap = 0, maxMcap = 0 } = {}) {
    const min = positiveOrNull(minMcap) || 0;
    const max = positiveOrNull(maxMcap) || Infinity;
    return PUMP_DESC_PAGES.filter(page => page.low <= max && page.high >= min).map(page => page.offset);
  }

  async fetchPumpCoins(url) {
    try {
      const data = await this.cachedGet(url);
      const tokens = [];
      for (const coin of Array.isArray(data) ? data : []) {
        if (coin && coin.mint) tokens.push(this.tokenFromPumpCoin(coin));
      }
      return tokens;
    } catch (err) {
      console.warn('[VampScanner] Pump feed failed:', err.message);
      return [];
    }
  }

  // Newest coins and the bonding-curve list, plus descending pages that overlap the range.
  async getPumpMarketCapCoins(options = {}) {
    const opts = options === true ? { minMcap: 1 } : (options || {});
    const urls = [
      pumpCoinsUrl({ sort: 'created_timestamp', order: 'DESC' }),
      pumpCoinsUrl({ sort: 'market_cap', order: 'ASC', complete: false })
    ];
    if (positiveOrNull(opts.minMcap) || positiveOrNull(opts.maxMcap)) {
      for (const offset of this.pumpDescOffsets(opts)) {
        urls.push(pumpCoinsUrl({ offset, sort: 'market_cap', order: 'DESC' }));
      }
    }
    const tokens = [];
    for (const url of urls) tokens.push(...await this.fetchPumpCoins(url));
    return tokens;
  }

  async getGeckoPools(slug, pages, dexId) {
    const tokens = [];
    for (const page of pages) {
      const url = `https://api.geckoterminal.com/api/v2/networks/solana/dexes/${slug}/pools?page=${page}&include=base_token,quote_token`;
      try {
        const data = await this.cachedGet(url);
        tokens.push(...this.tokensFromGecko(data, dexId));
      } catch (err) {
        console.warn(`[VampScanner] ${dexId} page ${page} failed:`, err.message);
      }
    }
    return tokens;
  }

  async getGeckoTrendingPools() {
    const url = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1&include=base_token,quote_token';
    try {
      const data = await this.cachedGet(url);
      return this.tokensFromGecko(data, 'trending');
    } catch (err) {
      console.warn('[VampScanner] Gecko trending pools failed:', err.message);
      return [];
    }
  }

  tokenFromDexProfile(item, market) {
    const pair = market && market.pair;
    const info = (pair && pair.info) || {};
    const linkOf = (kind) => (info.socials || []).find(s => (s.type || '').toLowerCase().includes(kind) || (s.url || '').includes(kind))?.url
      || (item.links || []).find(l => (l.type || '').toLowerCase().includes(kind) || (l.url || '').includes(kind))?.url
      || '';
    const website = (info.websites || [])[0]?.url || (typeof (info.websites || [])[0] === 'string' ? (info.websites || [])[0] : '') || linkOf('website');
    const metrics = pair ? {
      priceUsd: pair.priceUsd,
      mcap: finiteOrNull(pair.marketCap),
      volume24h: finiteOrNull(pair.volume && pair.volume.h24),
      liquidityUsd: finiteOrNull(pair.liquidity && pair.liquidity.usd),
      createdAt: timeMs(pair.pairCreatedAt),
      priceChange24h: finiteOrNull(pair.priceChange && pair.priceChange.h24),
      dexId: pair.dexId
    } : null;
    return {
      tokenAddress: item.tokenAddress,
      name: (pair && pair.baseToken && pair.baseToken.name) || item.name || item.tokenAddress.slice(0, 6),
      symbol: (pair && pair.baseToken && pair.baseToken.symbol) || item.symbol || 'MEME',
      description: item.description || info.description || '',
      icon: item.icon || info.imageUrl || '',
      header: item.header || info.header || '',
      socials: { twitter: linkOf('twitter') || linkOf('x.com'), telegram: linkOf('telegram') || linkOf('t.me'), website },
      twitter: linkOf('twitter') || linkOf('x.com'),
      telegram: linkOf('telegram') || linkOf('t.me'),
      website,
      links: item.links || [],
      metrics
    };
  }

  async resolveDexMarkets(mints) {
    const unique = [...new Set((mints || []).filter(Boolean))];
    const byMint = new Map();
    for (let i = 0; i < unique.length; i += 30) {
      const slice = unique.slice(i, i + 30);
      const url = `${config.DEXSCREENER_API}/tokens/${slice.join(',')}`;
      try {
        const data = await this.cachedGet(url);
        for (const pair of (data && data.pairs) || []) {
          const addr = pair.baseToken && pair.baseToken.address;
          if (!addr) continue;
          const mcap = finiteOrNull(pair.marketCap);
          const prev = byMint.get(addr);
          if (!prev || (mcap != null && (prev.mcap == null || mcap > prev.mcap))) {
            byMint.set(addr, { pair, mcap });
          }
        }
      } catch (err) {
        console.warn('[VampScanner] DexScreener market batch failed:', err.message);
      }
    }
    return byMint;
  }

  async getDexScreenerCandidates() {
    const lists = [
      'https://api.dexscreener.com/token-boosts/latest/v1',
      'https://api.dexscreener.com/token-boosts/top/v1',
      'https://api.dexscreener.com/token-profiles/latest/v1'
    ];
    const profiles = [];
    for (const url of lists) {
      try {
        const data = await this.cachedGet(url);
        for (const item of Array.isArray(data) ? data : []) {
          if (item && item.chainId === 'solana' && item.tokenAddress) profiles.push(item);
        }
      } catch (err) {
        console.warn('[VampScanner] DexScreener list failed:', err.message);
      }
    }
    let markets = new Map();
    try {
      markets = await this.resolveDexMarkets(profiles.map(item => item.tokenAddress));
    } catch (err) {
      console.warn('[VampScanner] DexScreener markets failed:', err.message);
    }
    return profiles.map(item => this.tokenFromDexProfile(item, markets.get(item.tokenAddress)));
  }

  // Page 1 of the Pump.fun and PumpSwap pool lists. Deeper pages are separate so a
  // caller can still ask for a small mover sample.
  async getPumpFunMovers(limit = 20) {
    const feeds = [
      { dexId: 'pumpfun', slug: 'pump-fun' },
      { dexId: 'pumpswap', slug: 'pumpswap' }
    ];
    const tokens = [];
    for (const feed of feeds) {
      const parsed = await this.getGeckoPools(feed.slug, [1], feed.dexId);
      tokens.push(...parsed.slice(0, limit));
    }
    return tokens;
  }

  preferToken(current, incoming) {
    const a = finiteOrNull(current && current.metrics && current.metrics.mcap);
    const b = finiteOrNull(incoming && incoming.metrics && incoming.metrics.mcap);
    let winner = current;
    let other = incoming;
    if ((a == null && b != null) || (a != null && b != null && b > a)) {
      winner = incoming;
      other = current;
    }
    const metrics = { ...(other.metrics || {}), ...(winner.metrics || {}) };
    for (const key of ['volume24h', 'liquidityUsd', 'createdAt', 'priceUsd', 'priceChange24h']) {
      const fromWinner = finiteOrNull(winner.metrics && winner.metrics[key]);
      const fromOther = finiteOrNull(other.metrics && other.metrics[key]);
      metrics[key] = fromWinner != null ? fromWinner : fromOther;
    }
    if (a != null || b != null) metrics.mcap = a == null ? b : (b == null ? a : Math.max(a, b));
    return {
      ...other,
      ...winner,
      name: winner.name || other.name,
      symbol: winner.symbol || other.symbol,
      icon: winner.icon || other.icon,
      description: winner.description || other.description,
      twitter: winner.twitter || other.twitter || '',
      telegram: winner.telegram || other.telegram || '',
      website: winner.website || other.website || '',
      metrics
    };
  }

  dedupeTokens(tokens) {
    const byMint = new Map();
    for (const token of tokens || []) {
      const key = token && token.tokenAddress;
      if (!key) continue;
      const prev = byMint.get(key);
      byMint.set(key, prev ? this.preferToken(prev, token) : token);
    }
    return [...byMint.values()];
  }

  filterByMinMcap(tokens, options = {}) {
    return this.filterCandidates(tokens, {
      minMcap: options.minMcap,
      showUnknown: options.showUnknown,
      now: options.now
    });
  }

  filterCandidates(tokens, options = {}) {
    const min = positiveOrNull(options.minMcap) || 0;
    const max = positiveOrNull(options.maxMcap);
    const minAge = positiveOrNull(options.minAgeMs);
    const maxAge = positiveOrNull(options.maxAgeMs);
    const minVolume = positiveOrNull(options.minVolume);
    const minLiquidity = positiveOrNull(options.minLiquidity);
    const showUnknown = Boolean(options.showUnknown);
    const now = positiveOrNull(options.now) || Date.now();
    const active = min > 0 || max || minAge || maxAge || minVolume || minLiquidity;
    if (!active) return { tokens: tokens || [], hidden: 0, unknown: 0 };
    const kept = [];
    let hidden = 0;
    let unknown = 0;
    for (const token of tokens || []) {
      const metrics = (token && token.metrics) || {};
      const verdicts = [];
      if (min > 0 || max) verdicts.push(this.rangeVerdict(finiteOrNull(metrics.mcap), min > 0 ? min : null, max));
      if (minAge || maxAge) {
        const created = finiteOrNull(metrics.createdAt);
        const age = created == null ? null : now - created;
        verdicts.push(this.rangeVerdict(age, minAge, maxAge));
      }
      if (minVolume) verdicts.push(this.rangeVerdict(finiteOrNull(metrics.volume24h), minVolume, null));
      if (minLiquidity) verdicts.push(this.rangeVerdict(finiteOrNull(metrics.liquidityUsd), minLiquidity, null));
      if (verdicts.includes('low') || verdicts.includes('high')) {
        hidden += 1;
      } else if (verdicts.includes('unknown')) {
        unknown += 1;
        if (showUnknown) kept.push({ ...token, mcapUnknown: finiteOrNull(metrics.mcap) == null });
        else hidden += 1;
      } else {
        kept.push(token);
      }
    }
    return { tokens: kept, hidden, unknown };
  }

  rangeVerdict(value, min, max) {
    if (value == null) return 'unknown';
    if (min != null && value < min) return 'low';
    if (max != null && value > max) return 'high';
    return 'ok';
  }

  sortCandidates(tokens, mode) {
    const list = (tokens || []).map((token, index) => ({ token, index }));
    const metric = (token, key) => finiteOrNull(token && token.metrics && token.metrics[key]);
    const direction = mode === 'closest' ? 'asc' : 'desc';
    const key = mode === 'newest' ? 'createdAt' : 'mcap';
    if (mode !== 'closest' && mode !== 'newest' && mode !== 'biggest') return (tokens || []).slice();
    list.sort((a, b) => {
      const av = metric(a.token, key);
      const bv = metric(b.token, key);
      if (av == null && bv == null) return a.index - b.index;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return a.index - b.index;
      return direction === 'asc' ? av - bv : bv - av;
    });
    return list.map(row => row.token);
  }

  mergeTrendingTokens(pumpTokens, dexTokens, limit) {
    const seen = new Set();
    const merged = [];
    const push = (token) => {
      const key = token?.tokenAddress;
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(token);
    };
    const max = Math.max(pumpTokens.length, dexTokens.length);
    for (let i = 0; i < max && merged.length < limit; i++) {
      if (pumpTokens[i]) push(pumpTokens[i]);
      if (dexTokens[i] && merged.length < limit) push(dexTokens[i]);
    }
    return merged;
  }

  async getTrendingSolanaTokens(limit = 15, options = {}) {
    const opts = options || {};
    const minMcap = positiveOrNull(opts.minMcap) || 0;
    const maxMcap = positiveOrNull(opts.maxMcap);
    const minAgeMs = positiveOrNull(opts.minAgeMs);
    const maxAgeMs = positiveOrNull(opts.maxAgeMs);
    const minVolume = positiveOrNull(opts.minVolume);
    const minLiquidity = positiveOrNull(opts.minLiquidity);
    const filtering = minMcap > 0 || maxMcap || minAgeMs || maxAgeMs || minVolume || minLiquidity;
    const requested = Number(limit);
    const safeLimit = Number.isFinite(requested) && requested > 0 ? requested : 15;
    const scan = filtering ? Math.max(safeLimit, 50) : safeLimit;
    const show = filtering ? 50 : safeLimit;
    const sort = ['closest', 'newest', 'biggest'].includes(opts.sort)
      ? opts.sort
      : ((minMcap > 0 || maxMcap) ? 'closest' : 'newest');
    const jobs = [
      ['Pump coins', () => this.getPumpMarketCapCoins({ minMcap, maxMcap })],
      ['Gecko movers', () => this.getPumpFunMovers(scan)],
      ['Gecko trending', () => this.getGeckoTrendingPools()],
      ['DexScreener', () => this.getDexScreenerCandidates()]
    ];
    if (filtering) {
      jobs.push(
        ['Gecko pump-fun pages', () => this.getGeckoPools('pump-fun', [2, 3], 'pumpfun')],
        ['Gecko pumpswap pages', () => this.getGeckoPools('pumpswap', [2, 3], 'pumpswap')]
      );
    }
    const buckets = await Promise.all(jobs.map(async ([name, load]) => {
      try {
        const tokens = await load();
        return { ok: true, tokens: Array.isArray(tokens) ? tokens : [] };
      } catch (err) {
        console.warn(`[VampScanner] ${name} failed:`, err.message);
        return { ok: false, tokens: [] };
      }
    }));
    const merged = this.dedupeTokens(buckets.flatMap(bucket => bucket.tokens));
    const sources = buckets.filter(bucket => bucket.ok).length;
    const filtered = filtering
      ? this.filterCandidates(merged, { minMcap, maxMcap, minAgeMs, maxAgeMs, minVolume, minLiquidity, showUnknown: Boolean(opts.showUnknown) })
      : { tokens: merged, hidden: 0, unknown: 0 };
    const ordered = sort === 'newest' && !filtering
      ? this.sortCandidates(filtered.tokens, 'newest')
      : this.sortCandidates(filtered.tokens, sort);
    const list = ordered.slice(0, show);
    list.hidden = filtered.hidden;
    list.unknown = filtered.unknown;
    list.scanned = merged.length;
    list.sources = sources;
    list.matched = filtering ? filtered.tokens.length : merged.length;
    list.sort = sort;
    return list;
  }

  // Inspect any token by CA or Pump.fun URL for direct Vamp Cloning
  async inspectToken(tokenAddress) {
    const match = String(tokenAddress).match(/[1-9A-HJ-NP-za-km-z]{32,44}/);
    const cleanAddress = match ? match[0] : tokenAddress;

    try {
      let pair = null;
      // 1. Try direct DexScreener tokens endpoint
      try {
        const res = await axios.get(`${config.DEXSCREENER_API}/tokens/${cleanAddress}`, { timeout: 4000 });
        if (res.data?.pairs?.[0]) pair = res.data.pairs[0];
      } catch (e) {}

      // 2. Fallback to DexScreener search endpoint (reliably catches newly created pump.fun coins)
      if (!pair) {
        try {
          const searchRes = await axios.get(`${config.DEXSCREENER_API}/search?q=${cleanAddress}`, { timeout: 4000 });
          if (searchRes.data?.pairs && searchRes.data.pairs.length > 0) {
            pair = searchRes.data.pairs.find(p => p.baseToken?.address === cleanAddress) || searchRes.data.pairs[0];
          }
        } catch (e) {}
      }

      if (pair) {
        const base = pair.baseToken || {};
        const info = pair.info || {};
        const twitter = (info.socials || []).find(s => (s.type || s.platform || '').toLowerCase().includes('twitter') || (s.url || '').includes('x.com') || (s.url || '').includes('twitter.com'))?.url || '';
        const telegram = (info.socials || []).find(s => (s.type || s.platform || '').toLowerCase().includes('telegram') || (s.url || '').includes('t.me'))?.url || '';
        const website = (info.websites || [])[0]?.url || (typeof (info.websites || [])[0] === 'string' ? (info.websites || [])[0] : '') || '';

        return {
          address: cleanAddress,
          name: base.name || 'Unknown',
          symbol: base.symbol || 'VAMP',
          description: info.description || `${base.name} - cloned & launched with Svarog/Vamp bundler`,
          icon: info.imageUrl || '',
          socials: { twitter, telegram, website },
          twitter,
          telegram,
          website,
          priceUsd: pair.priceUsd,
          marketCap: pair.marketCap,
          volume24h: pair.volume?.h24
        };
      }
    } catch (e) {
      console.warn('[VampScanner] Failed to inspect token:', e.message);
    }

    return {
      address: cleanAddress,
      name: 'Vamped Meme Coin',
      symbol: 'VAMP',
      description: 'Instant vamp launch on Pump.fun bonding curve',
      icon: '',
      socials: {}
    };
  }

  // Generate Vamp Mutation (e.g. clone + slight twist)
  generateVampMutation(tokenData, mode = 'spin') {
    const originalSymbol = tokenData.symbol || 'COIN';
    const originalName = tokenData.name || 'Memecoin';

    let newSymbol = originalSymbol;
    let newName = originalName;

    if (mode === 'v2') {
      newSymbol = originalSymbol.length > 5 ? originalSymbol.slice(0, 4) + '2' : originalSymbol + '2';
      newName = `${originalName} 2.0`;
    } else if (mode === 'spin') {
      const prefixes = ['Super', 'Meta', 'Baby', 'Chad', 'Turbo'];
      const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
      newSymbol = `${prefix.slice(0, 2)}${originalSymbol}`.toUpperCase().slice(0, 7);
      newName = `${prefix} ${originalName}`;
    }

    return {
      address: tokenData.address || tokenData.tokenAddress || '',
      name: newName,
      symbol: newSymbol,
      description: `${tokenData.description || originalName} - Community takeover & reborn launch.`,
      icon: tokenData.icon || '',
      socials: tokenData.socials || {},
      twitter: tokenData.socials?.twitter || tokenData.twitter || '',
      telegram: tokenData.socials?.telegram || tokenData.telegram || '',
      website: tokenData.socials?.website || tokenData.website || ''
    };
  }
}

module.exports = new VampScanner();

