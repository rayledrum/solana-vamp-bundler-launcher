const { readMintMetadata } = require('./tokenMetadata');

function text(value) {
  return String(value || '').replace(/\0/g, '').trim();
}

function httpsImage(value) {
  const raw = text(value);
  if (raw.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${raw.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  if (raw.startsWith('https://')) return raw;
  return '';
}

function socialUrl(kind, value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw.startsWith('https://')) return raw;
  if (raw.startsWith('http://')) return '';
  const handle = raw.replace(/^@/, '');
  if (!handle || /\s/.test(handle)) return '';
  if (kind === 'twitter') return `https://x.com/${handle}`;
  if (kind === 'telegram') return `https://t.me/${handle}`;
  return '';
}

function blankPart() {
  return { name: '', symbol: '', description: '', icon: '', twitter: '', telegram: '', website: '' };
}

function fromPumpCoin(coin) {
  if (!coin || typeof coin !== 'object' || Array.isArray(coin)) return blankPart();
  return {
    name: text(coin.name),
    symbol: text(coin.symbol),
    description: text(coin.description),
    icon: httpsImage(coin.image_uri || coin.image),
    twitter: socialUrl('twitter', coin.twitter),
    telegram: socialUrl('telegram', coin.telegram),
    website: httpsImage(coin.website) || (text(coin.website).startsWith('https://') ? text(coin.website) : '')
  };
}

function fromUriJson(json) {
  if (!json || typeof json !== 'object') return blankPart();
  const ext = json.extensions || {};
  return {
    name: text(json.name),
    symbol: text(json.symbol),
    description: text(json.description),
    icon: httpsImage(json.image),
    twitter: socialUrl('twitter', json.twitter || ext.twitter),
    telegram: socialUrl('telegram', json.telegram || ext.telegram),
    website: text(json.website || ext.website).startsWith('https://') ? text(json.website || ext.website) : ''
  };
}

function fromDexPair(pair) {
  if (!pair || typeof pair !== 'object') return blankPart();
  const base = pair.baseToken || {};
  const info = pair.info || {};
  const social = (kind, needles) => {
    const row = (info.socials || []).find(item => {
      const type = text(item && (item.type || item.platform)).toLowerCase();
      const url = text(item && item.url);
      return needles.some(needle => type.includes(needle) || url.includes(needle));
    });
    return text(row && row.url).startsWith('https://') ? text(row.url) : '';
  };
  const website = (info.websites || []).map(item => text(typeof item === 'string' ? item : item && item.url)).find(url => url.startsWith('https://')) || '';
  return {
    name: text(base.name),
    symbol: text(base.symbol),
    description: text(info.description),
    icon: httpsImage(info.imageUrl),
    twitter: social('twitter', ['twitter', 'x.com']),
    telegram: social('telegram', ['telegram', 't.me']),
    website
  };
}

function fromGeckoToken(payload) {
  const attrs = payload && payload.data && payload.data.attributes ? payload.data.attributes : (payload && payload.attributes) || null;
  if (!attrs) return blankPart();
  const websites = Array.isArray(attrs.websites) ? attrs.websites : [];
  const website = websites.map(item => text(typeof item === 'string' ? item : item && item.url)).find(url => url.startsWith('https://')) || '';
  return {
    name: text(attrs.name),
    symbol: text(attrs.symbol),
    description: text(attrs.description),
    icon: httpsImage(attrs.image_url),
    twitter: socialUrl('twitter', attrs.twitter_handle),
    telegram: socialUrl('telegram', attrs.telegram_handle),
    website
  };
}

function mergeVampParts(parts) {
  const merged = blankPart();
  for (const part of parts || []) {
    if (!part) continue;
    for (const key of Object.keys(merged)) {
      if (!merged[key] && part[key]) merged[key] = part[key];
    }
  }
  const missing = [];
  if (!merged.icon) missing.push('logo');
  if (!merged.twitter) missing.push('twitter');
  if (!merged.telegram) missing.push('telegram');
  if (!merged.website) missing.push('website');
  if (!merged.description) missing.push('description');
  merged.missing = missing;
  return merged;
}

async function readJson(get, url) {
  if (!text(url).startsWith('https://')) return null;
  const response = await get(url);
  return response && response.data ? response.data : null;
}

async function collectVampMetadata(mint, deps) {
  const get = deps && deps.get;
  const parts = [];
  try {
    const response = await readJson(get, `https://frontend-api-v3.pump.fun/coins/${mint}`);
    parts.push(fromPumpCoin(response));
  } catch (err) {
    parts.push(blankPart());
  }
  try {
    const onChain = deps.readMetadata
      ? await deps.readMetadata(deps.connection, mint)
      : await readMintMetadata(deps.connection, mint);
    const json = onChain && onChain.uri ? await readJson(get, onChain.uri) : null;
    const fromJson = fromUriJson(json);
    if (onChain) {
      if (!fromJson.name) fromJson.name = text(onChain.name);
      if (!fromJson.symbol) fromJson.symbol = text(onChain.symbol);
    }
    parts.push(fromJson);
  } catch (err) {
    parts.push(blankPart());
  }
  try {
    let payload = await readJson(get, `https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    let pair = payload && payload.pairs && payload.pairs[0];
    if (!pair) {
      payload = await readJson(get, `https://api.dexscreener.com/latest/dex/search?q=${mint}`);
      const pairs = payload && payload.pairs || [];
      pair = pairs.find(item => item && item.baseToken && item.baseToken.address === mint) || pairs[0];
    }
    parts.push(fromDexPair(pair));
  } catch (err) {
    parts.push(blankPart());
  }
  try {
    const payload = await readJson(get, `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`);
    parts.push(fromGeckoToken(payload));
  } catch (err) {
    parts.push(blankPart());
  }
  const merged = mergeVampParts(parts);
  merged.address = mint;
  return merged;
}

module.exports = {
  httpsImage,
  socialUrl,
  fromPumpCoin,
  fromUriJson,
  fromDexPair,
  fromGeckoToken,
  mergeVampParts,
  collectVampMetadata
};
