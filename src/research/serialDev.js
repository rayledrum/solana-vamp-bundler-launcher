const GENERIC_IMAGE_HOSTS = new Set([
  'ipfs.io',
  'cf-ipfs.com',
  'gateway.ipfs.io',
  'cloudflare-ipfs.com',
  'arweave.net',
  'nftstorage.link',
  'pump.mypinata.cloud'
]);

function finite(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function hostOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).host.replace(/^www\./, '').toLowerCase();
  } catch (err) {
    return null;
  }
}

function handleOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/(?:twitter\.com|x\.com|t\.me)\/@?([a-z0-9_]+)/i);
  if (match) return match[1];
  return text.replace(/^@/, '') || null;
}

function descriptionKey(value) {
  const cleaned = String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length >= 24 ? cleaned : null;
}

function signalKeys(row) {
  const keys = [];
  if (row.treasury && !row.treasuryCex) keys.push(`treasury:${row.treasury}`);
  if (row.imageHash) keys.push(`hash:${String(row.imageHash).trim()}`);
  if (row.image) keys.push(`img:${String(row.image).trim()}`);
  const imageHost = hostOf(row.image);
  if (imageHost && !GENERIC_IMAGE_HOSTS.has(imageHost)) keys.push(`ihost:${imageHost}`);
  const site = hostOf(row.website);
  if (site) keys.push(`site:${site}`);
  const twitter = handleOf(row.twitter);
  if (twitter) keys.push(`tw:${twitter}`);
  const telegram = handleOf(row.telegram);
  if (telegram) keys.push(`tg:${telegram}`);
  const description = descriptionKey(row.description);
  if (description) keys.push(`desc:${description}`);
  return keys;
}

function outcomeOf(row) {
  return {
    mint: row.mint,
    dev: row.dev,
    peakMcapUsd: finite(row.peakMcapUsd),
    graduated: row.graduated === true ? true : (row.graduated === false ? false : null),
    rugged: row.rugged === true ? true : (row.rugged === false ? false : null)
  };
}

function linkSerialDevs(rows) {
  if (!Array.isArray(rows)) return null;
  const usable = rows.filter(row => row && row.mint && row.dev);
  const anySignal = usable.some(row => signalKeys(row).length > 0);
  const groups = new Map();
  usable.forEach(row => {
    signalKeys(row).forEach(key => {
      const list = groups.get(key) || [];
      list.push(row);
      groups.set(key, list);
    });
  });
  const byMint = new Map();
  for (const list of groups.values()) {
    const devs = new Set(list.map(row => row.dev));
    if (devs.size < 2) continue;
    list.forEach(row => {
      const slot = byMint.get(row.mint) || [];
      list.forEach(other => {
        if (other.mint === row.mint || other.dev === row.dev) return;
        if (!slot.some(item => item.mint === other.mint)) slot.push(outcomeOf(other));
      });
      byMint.set(row.mint, slot);
    });
  }
  return usable.map(row => {
    const linkedPriorCoins = byMint.has(row.mint) ? byMint.get(row.mint) : (anySignal ? [] : null);
    return {
      mint: row.mint,
      dev: row.dev,
      linkedPriorCoins,
      linkedDevs: linkedPriorCoins ? [...new Set(linkedPriorCoins.map(item => item.dev))] : null
    };
  });
}

module.exports = { linkSerialDevs, GENERIC_IMAGE_HOSTS };
