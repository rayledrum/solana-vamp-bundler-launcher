const axios = require('axios');
const config = require('./config');

const SOURCE_TIMEOUT_MS = 6000;
const SOURCE_CACHE_MS = 60 * 1000;
const SOL = 'So11111111111111111111111111111111111111112';
const PUMP_MCAP_URL = 'https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false';
const PUMP_LIVE_URL = `${PUMP_MCAP_URL}&complete=false`;

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
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
        volume24h: null,
        priceChange24h: null,
        dexId: coin.complete ? 'pump-graduated' : 'pump'
      }
    };
  }

  // Top coins by market cap, plus coins still on the bonding curve.
  // /coins/graduated is not a live route; graduated coins come back from the market-cap sort.
  async getPumpMarketCapCoins(extraOffsets = false) {
    const urls = [PUMP_MCAP_URL, PUMP_LIVE_URL];
    if (extraOffsets) {
      urls.push(PUMP_MCAP_URL.replace('offset=0', 'offset=50'), PUMP_MCAP_URL.replace('offset=0', 'offset=100'));
    }
    const tokens = [];
    for (const url of urls) {
      try {
        const data = await this.cachedGet(url);
        for (const coin of Array.isArray(data) ? data : []) {
          if (coin && coin.mint) tokens.push(this.tokenFromPumpCoin(coin));
        }
      } catch (err) {
        console.warn('[VampScanner] Pump market-cap feed failed:', err.message);
      }
    }
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
      volume24h: finiteOrNull(pair.volume && pair.volume.h24) || 0,
      priceChange24h: finiteOrNull(pair.priceChange && pair.priceChange.h24) || 0,
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

  filterByMinMcap(tokens, { minMcap = 0, showUnknown = false } = {}) {
    const floor = Number(minMcap);
    const min = Number.isFinite(floor) && floor > 0 ? floor : 0;
    if (!(min > 0)) return { tokens: tokens || [], hidden: 0, unknown: 0 };
    const kept = [];
    let hidden = 0;
    let unknown = 0;
    for (const token of tokens || []) {
      const mcap = finiteOrNull(token && token.metrics && token.metrics.mcap);
      if (mcap == null) {
        unknown += 1;
        if (showUnknown) kept.push({ ...token, mcapUnknown: true });
        else hidden += 1;
      } else if (mcap < min) {
        hidden += 1;
      } else {
        kept.push(token);
      }
    }
    return { tokens: kept, hidden, unknown };
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
    const minMcap = Number(options && options.minMcap);
    const floor = Number.isFinite(minMcap) && minMcap > 0 ? minMcap : 0;
    const requested = Number(limit);
    const safeLimit = Number.isFinite(requested) && requested > 0 ? requested : 15;
    const scan = floor > 0 ? Math.max(safeLimit, 50) : safeLimit;
    const show = floor > 0 ? Math.min(Math.max(safeLimit, 30), 50) : safeLimit;
    const jobs = [
      ['Pump market cap', () => this.getPumpMarketCapCoins(floor > 0)],
      ['Gecko movers', () => this.getPumpFunMovers(scan)],
      ['Gecko trending', () => this.getGeckoTrendingPools()],
      ['DexScreener', () => this.getDexScreenerCandidates()]
    ];
    if (floor > 0) {
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
    if (!(floor > 0)) {
      const list = merged.slice(0, show);
      list.scanned = merged.length;
      list.sources = sources;
      list.matched = merged.length;
      list.hidden = 0;
      list.unknown = 0;
      return list;
    }
    const filtered = this.filterByMinMcap(merged, { minMcap: floor, showUnknown: Boolean(options.showUnknown) });
    const sorted = filtered.tokens.slice().sort((a, b) => {
      const am = finiteOrNull(a.metrics && a.metrics.mcap) || 0;
      const bm = finiteOrNull(b.metrics && b.metrics.mcap) || 0;
      return bm - am;
    });
    const list = sorted.slice(0, show);
    list.hidden = filtered.hidden;
    list.unknown = filtered.unknown;
    list.scanned = merged.length;
    list.sources = sources;
    list.matched = filtered.tokens.length;
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

