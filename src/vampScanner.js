const axios = require('axios');
const config = require('./config');

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

class VampScanner {
  // Live Pump.fun bonding-curve coins plus graduated PumpSwap pairs.
  // Official pump.fun frontend APIs are Cloudflare-blocked from this host,
  // so this uses GeckoTerminal's pump-fun and pumpswap pool lists.
  async getPumpFunMovers(limit = 20) {
    const SOL = 'So11111111111111111111111111111111111111112';
    const feeds = [
      { dexId: 'pumpfun', url: 'https://api.geckoterminal.com/api/v2/networks/solana/dexes/pump-fun/pools?page=1&include=base_token,quote_token' },
      { dexId: 'pumpswap', url: 'https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools?page=1&include=base_token,quote_token' }
    ];
    const tokens = [];

    for (const feed of feeds) {
      try {
        const res = await axios.get(feed.url, {
          timeout: 8000,
          headers: { Accept: 'application/json' }
        });
        const included = {};
        for (const item of res.data?.included || []) {
          included[item.id] = item.attributes || {};
        }
        let added = 0;
        for (const pool of res.data?.data || []) {
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
            description: `${base.name || 'Pump.fun coin'} · ${feed.dexId}`,
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
              dexId: feed.dexId
            }
          });
          added += 1;
          if (added >= limit) break;
        }
      } catch (err) {
        console.warn(`[VampScanner] ${feed.dexId} feed failed:`, err.message);
      }
    }
    return tokens;
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

  // Fetch trending tokens from Pump.fun (via GeckoTerminal) and DexScreener
  async getTrendingSolanaTokens(limit = 15) {
    let dexTokens = [];
    let pumpTokens = [];
    try {
      // Query DexScreener free token profiles / latest boost pairs
      const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', {
        timeout: 6000
      });

      const solanaTokens = (res.data || [])
        .filter(item => item.chainId === 'solana')
        .slice(0, limit);

      // Enhance with detailed pair metrics & socials
      const results = [];
      for (const t of solanaTokens) {
        let metrics = null;
        let pairInfo = {};
        try {
          const pairRes = await axios.get(`${config.DEXSCREENER_API}/tokens/${t.tokenAddress}`, {
            timeout: 4000
          });
          if (pairRes.data?.pairs?.[0]) {
            const p = pairRes.data.pairs[0];
            pairInfo = p.info || {};
            metrics = {
              priceUsd: p.priceUsd,
              mcap: p.marketCap,
              volume24h: p.volume?.h24 || 0,
              priceChange24h: p.priceChange?.h24 || 0,
              dexId: p.dexId
            };
          }
        } catch (e) {
          // ignore individual pair errors
        }

        const icon = t.icon || pairInfo.imageUrl || '';
        const twitter = (pairInfo.socials || []).find(s => (s.type || '').toLowerCase().includes('twitter') || (s.url || '').includes('x.com') || (s.url || '').includes('twitter.com'))?.url || 
                        (t.links || []).find(l => (l.type || '').toLowerCase().includes('twitter') || (l.url || '').includes('x.com') || (l.url || '').includes('twitter.com'))?.url || '';
        const telegram = (pairInfo.socials || []).find(s => (s.type || '').toLowerCase().includes('telegram') || (s.url || '').includes('t.me'))?.url || 
                         (t.links || []).find(l => (l.type || '').toLowerCase().includes('telegram') || (l.url || '').includes('t.me'))?.url || '';
        const website = (pairInfo.websites || [])[0]?.url || (typeof (pairInfo.websites || [])[0] === 'string' ? (pairInfo.websites || [])[0] : '') ||
                        (t.links || []).find(l => (l.type || '').toLowerCase().includes('website'))?.url || '';

        results.push({
          tokenAddress: t.tokenAddress,
          name: t.name || (t.tokenAddress.slice(0, 6)),
          symbol: t.symbol || 'MEME',
          description: t.description || pairInfo.description || '',
          icon: icon,
          header: t.header || pairInfo.header || '',
          socials: { twitter, telegram, website },
          twitter,
          telegram,
          website,
          links: t.links || [],
            metrics: metrics || null
        });
      }

      dexTokens = results;
    } catch (err) {
      console.warn('[VampScanner] Failed to fetch DexScreener trending:', err.message);
    }

    try {
      pumpTokens = await this.getPumpFunMovers(limit);
    } catch (err) {
      console.warn('[VampScanner] Failed to fetch Pump.fun movers:', err.message);
    }

    return this.mergeTrendingTokens(pumpTokens, dexTokens, limit);
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

