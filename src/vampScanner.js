const axios = require('axios');
const config = require('./config');

class VampScanner {
  // Fetch trending tokens from DexScreener (Solana pairs)
  async getTrendingSolanaTokens(limit = 15) {
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
          metrics: metrics || { priceUsd: '0.0001', mcap: 45000, volume24h: 12000, priceChange24h: 35.5, dexId: 'pumpfun' }
        });
      }

      return results;
    } catch (err) {
      console.warn('[VampScanner] Failed to fetch DexScreener trending, using fallback feed:', err.message);
      // Return curated trending Solana memecoin list as fallback
      return [
        {
          tokenAddress: '6p6xgHyF7AeQHyVaKnTyCaNXECw9wEkPr538JLfcpump',
          name: 'Pepe Original Solana',
          symbol: 'PEPE',
          description: 'The real frog on Solana with pure community power and zero tax.',
          icon: 'https://cdn.dexscreener.com/cms/images/6p6xgHyF7AeQHyVaKnTyCaNXECw9wEkPr538JLfcpump?size=lg',
          links: [{ label: 'Twitter', url: 'https://x.com' }],
          metrics: { priceUsd: '0.0034', mcap: 3400000, volume24h: 890000, priceChange24h: 74.2, dexId: 'pumpfun' }
        },
        {
          tokenAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
          name: 'Bonk 2.0 Revival',
          symbol: 'BONK2',
          description: 'Revamping the classic dog meme with modern bonding curves and hyper deflation.',
          icon: 'https://cdn.dexscreener.com/cms/images/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263?size=lg',
          links: [{ label: 'Telegram', url: 'https://t.me' }],
          metrics: { priceUsd: '0.000045', mcap: 67000, volume24h: 145000, priceChange24h: 120.4, dexId: 'pumpfun' }
        },
        {
          tokenAddress: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZpump',
          name: 'Giga Chad AI',
          symbol: 'GIGA',
          description: 'Autonomous AI agent spreading alpha and unyielding gains.',
          icon: 'https://cdn.dexscreener.com/cms/images/ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZpump?size=lg',
          links: [{ label: 'Website', url: 'https://gigachad.sol' }],
          metrics: { priceUsd: '0.012', mcap: 1200000, volume24h: 420000, priceChange24h: -5.4, dexId: 'pumpfun' }
        }
      ];
    }
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

