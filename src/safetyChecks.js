const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, getExtensionData, ExtensionType } = require('@solana/spl-token');
const { bondingCurvePda } = require('./curveFeed');
const { decodeBondingCurve } = require('./curveFeed');
const { canonicalPoolPda, decodePool } = require('./pumpSwap');
const { bondingProgress, DEFAULT_GLOBAL } = require('./bondingCurve');
const config = require('./config');
const { ValidationError } = require('./validation');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_BLACKLIST = path.join(DATA_DIR, 'dev-blacklist.json');
const DEFAULT_LAUNCHED = path.join(DATA_DIR, 'launched-mints.json');
const PUMP_COIN = 'https://frontend-api.pump.fun/coins/';
const PUMP_USER = 'https://frontend-api.pump.fun/coins/user-created-coins/';
const RUGCHECK = 'https://api.rugcheck.xyz/v1/tokens/';

const DEFAULT_AUTO = {
  enabled: true,
  rugHistory: true,
  devHoldPct: 10,
  rugcheckDanger: true
};

function check(id, label, status, reason) {
  return { id, label, status, reason: reason || '', at: Date.now() };
}

function overallFromChecks(checks) {
  const scored = (checks || []).filter(row => row && row.status && row.status !== 'unknown');
  if (!scored.length) return { overall: 'unknown', score: null };
  const reds = scored.filter(row => row.status === 'red').length;
  const yellows = scored.filter(row => row.status === 'yellow').length;
  return {
    overall: reds ? 'red' : yellows ? 'yellow' : 'green',
    score: Math.max(0, 100 - reds * 25 - yellows * 10)
  };
}

function num(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function classifyRugcheck(report) {
  if (!report || typeof report !== 'object') {
    return check('rugcheck', 'RugCheck', 'unknown', 'RugCheck returned no report');
  }
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const danger = risks.filter(row => String(row.level || '').toLowerCase() === 'danger');
  const warn = risks.filter(row => String(row.level || '').toLowerCase() === 'warn');
  const score = num(report.score_normalised != null ? report.score_normalised : report.score);
  let status = 'green';
  if (report.rugged === true || danger.length || (score != null && score >= 60)) status = 'red';
  else if (warn.length || (score != null && score >= 30)) status = 'yellow';
  const names = danger.concat(warn).map(row => row.name || row.description).filter(Boolean).slice(0, 3);
  const parts = [];
  if (score != null) parts.push(`normalised score ${score}`);
  if (names.length) parts.push(names.join(', '));
  if (!parts.length) parts.push('No listed risks');
  return check('rugcheck', 'RugCheck', status, parts.join(' · '));
}

function classifyAuthorities(info) {
  if (!info) return check('authorities', 'Mint and freeze authority', 'unknown', 'Mint account was not read');
  const problems = [];
  if (info.mintAuthority) problems.push('mint authority is still set');
  if (info.freezeAuthority) problems.push('freeze authority is still set');
  const risky = info.extensions || [];
  if (risky.includes('permanentDelegate')) problems.push('Token-2022 permanent delegate');
  if (risky.includes('transferFee')) problems.push('Token-2022 transfer fee');
  if (risky.includes('transferHook')) problems.push('Token-2022 transfer hook');
  if (!problems.length) return check('authorities', 'Mint and freeze authority', 'green', 'Mint and freeze authority are revoked');
  const severe = info.mintAuthority || info.freezeAuthority || risky.includes('permanentDelegate') || risky.includes('transferFee');
  return check('authorities', 'Mint and freeze authority', severe ? 'red' : 'yellow', problems.join('; '));
}

function classifyHolders(input) {
  if (!input || !Array.isArray(input.accounts) || input.supplyRaw == null) {
    return check('holders', 'Holders', 'unknown', 'Holder list or supply was not read');
  }
  const exclude = new Set(input.exclude || []);
  const rows = input.accounts.filter(row => row && row.address && !exclude.has(row.address));
  const supply = BigInt(input.supplyRaw);
  if (supply <= 0n) return check('holders', 'Holders', 'unknown', 'Mint supply is zero');
  const amounts = rows.map(row => BigInt(row.amount || 0));
  const top = amounts.slice(0, 10).reduce((sum, amount) => sum + amount, 0n);
  const largest = amounts.reduce((max, amount) => (amount > max ? amount : max), 0n);
  const topPct = Number((top * 10000n) / supply) / 100;
  const largestPct = Number((largest * 10000n) / supply) / 100;
  const countText = input.holderCount != null ? `${input.holderCount} holders` : 'holder count not provided';
  let status = 'green';
  if (topPct >= 50 || largestPct >= 20) status = 'red';
  else if (topPct >= 30 || largestPct >= 10) status = 'yellow';
  return check('holders', 'Holders', status, `${countText}; top 10 ${topPct.toFixed(1)}%; largest non-pool ${largestPct.toFixed(1)}%`);
}

function classifySnipers(cluster) {
  if (!cluster || cluster.unknown || cluster.pct == null) {
    return check('snipers', 'Launch bundle', 'unknown', (cluster && cluster.reason) || 'First-block buyers were not read');
  }
  const pct = Number(cluster.pct);
  const status = pct >= 30 ? 'red' : pct >= 10 ? 'yellow' : 'green';
  return check('snipers', 'Launch bundle', status, `${pct.toFixed(1)}% of supply bought in the first block by ${cluster.buyers || 0} wallets`);
}

function classifyCurve(decoded) {
  if (!decoded) return check('bonding', 'Bonding curve', 'unknown', 'Bonding curve account was not read');
  if (decoded.complete) return check('bonding', 'Bonding curve', 'green', 'Graduated to PumpSwap');
  const progress = bondingProgress(decoded.realTokenReserves, DEFAULT_GLOBAL.initialRealTokenReserves, false);
  const status = progress >= 90 ? 'yellow' : 'green';
  return check('bonding', 'Bonding curve', status, `${progress.toFixed(1)}% of the curve is filled`);
}

function classifyMarket(pair) {
  if (!pair) return check('market', 'Liquidity and volume', 'unknown', 'DexScreener has no pair');
  const liq = num(pair.liquidity && pair.liquidity.usd);
  const volume = pair.volume || {};
  const txns = pair.txns || {};
  const parts = [];
  if (liq != null) parts.push(`liquidity $${Math.round(liq)}`);
  ['m5', 'h1', 'h24'].forEach(key => {
    const label = key === 'm5' ? '5m' : key === 'h1' ? '1h' : '24h';
    if (num(volume[key]) != null) parts.push(`${label} vol $${Math.round(volume[key])}`);
    const side = txns[key] || {};
    if (num(side.buys) != null || num(side.sells) != null) {
      parts.push(`${label} ${side.buys == null ? '—' : side.buys} buys / ${side.sells == null ? '—' : side.sells} sells`);
    }
  });
  if (!parts.length) return check('market', 'Liquidity and volume', 'unknown', 'DexScreener pair has no liquidity or volume fields');
  let status = 'green';
  if (liq != null && liq < 1000) status = 'red';
  else if (liq != null && liq < 10000) status = 'yellow';
  return check('market', 'Liquidity and volume', status, parts.join(' · '));
}

function classifyAge(createdMs, now) {
  if (!Number.isFinite(createdMs)) return check('age', 'Age', 'unknown', 'Creation time was not found');
  const minutes = Math.max(0, (now - createdMs) / 60000);
  const text = minutes < 120 ? `${minutes.toFixed(0)} minutes old` : `${(minutes / 60).toFixed(1)} hours old`;
  const status = minutes < 10 ? 'red' : minutes < 60 ? 'yellow' : 'green';
  return check('age', 'Age', status, text);
}

function classifySocials(source) {
  if (!source || source.ok === false) return check('socials', 'Socials', 'unknown', 'Social links were not read');
  const present = ['twitter', 'telegram', 'website'].filter(key => source[key]);
  if (!present.length) return check('socials', 'Socials', 'yellow', 'No Twitter, Telegram, or website');
  return check('socials', 'Socials', 'green', present.join(', '));
}

function classifyDevHolding(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) return check('devHolding', 'Dev holding', 'unknown', 'Creator balance was not read');
  const value = Number(pct);
  const status = value > 10 ? 'red' : value > 2 ? 'yellow' : 'green';
  return check('devHolding', 'Dev holding', status, `Dev holds ${value.toFixed(2)}% of supply`);
}

function classifyDevFlow(flow) {
  if (!flow || flow.unknown) return check('devFlow', 'Dev buys and sells', 'unknown', (flow && flow.reason) || 'Creator trade history was not read');
  return check('devFlow', 'Dev buys and sells', flow.status || 'green', flow.reason);
}

function classifyCreatedCoins(coins) {
  if (!Array.isArray(coins)) return check('devCoins', 'Dev created coins', 'unknown', 'Creator coin list was not read');
  const graduated = coins.filter(coin => coin && coin.complete === true).length;
  const died = coins.filter(coin => coin && coin.complete === false && num(coin.usd_market_cap) != null && coin.usd_market_cap < 1000).length;
  const status = coins.length >= 5 && graduated === 0 ? 'yellow' : 'green';
  return check('devCoins', 'Dev created coins', status, `${coins.length} created, ${graduated} graduated, ${died} under $1k and not graduated`);
}

function classifyRugHistory(coins, rugcheck) {
  if (rugcheck && rugcheck.rugged === true) return check('rugHistory', 'Rug history', 'red', 'RugCheck marks this token rugged');
  if (!Array.isArray(coins)) return check('rugHistory', 'Rug history', 'unknown', 'Prior coins were not read');
  const collapsed = coins.filter(coin => {
    const peak = num(coin && (coin.peak_market_cap != null ? coin.peak_market_cap : coin.ath_market_cap));
    const now = num(coin && coin.usd_market_cap);
    return peak != null && peak > 0 && now != null && now <= peak * 0.1;
  });
  if (!coins.some(coin => num(coin && (coin.peak_market_cap != null ? coin.peak_market_cap : coin.ath_market_cap)) != null)) {
    return check('rugHistory', 'Rug history', 'unknown', 'Peak market cap is not on the creator coin list, so a dump timer cannot be measured');
  }
  if (collapsed.length) return check('rugHistory', 'Rug history', 'red', `${collapsed.length} prior coin${collapsed.length === 1 ? '' : 's'} fell more than 90% from the recorded peak`);
  return check('rugHistory', 'Rug history', 'green', 'No prior coin in this list fell more than 90% from its recorded peak');
}

function classifyCreatorFlags(report) {
  if (!report) return check('creatorFlags', 'RugCheck creator flags', 'unknown', 'RugCheck creator flags were not read');
  const insider = report.insiderNetworks || report.graphInsiders || report.insiders;
  const danger = Array.isArray(report.risks) && report.risks.some(row => /creator|insider/i.test(`${row.name || ''} ${row.description || ''}`) && String(row.level || '').toLowerCase() === 'danger');
  if (danger || (Array.isArray(insider) && insider.length)) {
    return check('creatorFlags', 'RugCheck creator flags', 'red', 'RugCheck lists a creator or insider warning');
  }
  return check('creatorFlags', 'RugCheck creator flags', 'green', 'No creator or insider flag on the RugCheck report');
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function emptyBlacklist() {
  return { devs: [], flaggedMints: {}, auto: { ...DEFAULT_AUTO } };
}

function createSafetyChecks(options = {}) {
  const blacklistFile = options.blacklistFile || DEFAULT_BLACKLIST;
  const launchedFile = options.launchedFile || DEFAULT_LAUNCHED;
  const ttlMs = options.ttlMs || 60_000;
  const minIntervalMs = options.minIntervalMs == null ? 250 : options.minIntervalMs;
  const fetchJson = options.fetchJson || defaultFetchJson;
  const connection = options.connection || null;
  const cache = new Map();
  let lastCall = 0;

  async function pace() {
    const wait = minIntervalMs - (Date.now() - lastCall);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCall = Date.now();
  }

  async function external(url) {
    await pace();
    return fetchJson(url);
  }

  function loadBlacklist() {
    const data = readJson(blacklistFile, emptyBlacklist());
    if (!Array.isArray(data.devs)) data.devs = [];
    if (!data.flaggedMints || typeof data.flaggedMints !== 'object') data.flaggedMints = {};
    data.auto = { ...DEFAULT_AUTO, ...(data.auto || {}) };
    return data;
  }

  function saveBlacklist(data) {
    writeJson(blacklistFile, data);
  }

  function isOwnLaunch(mint) {
    const data = readJson(launchedFile, { mints: [] });
    return Array.isArray(data.mints) && data.mints.includes(mint);
  }

  function noteOwnLaunch(mint) {
    if (!mint) return;
    const data = readJson(launchedFile, { mints: [] });
    const mints = Array.isArray(data.mints) ? data.mints : [];
    if (!mints.includes(mint)) mints.push(mint);
    writeJson(launchedFile, { mints });
  }

  function listBlacklist() {
    return loadBlacklist();
  }

  function addBlacklist(address, reason, source) {
    const key = String(address || '').trim();
    if (!key) throw new Error('A dev address is required');
    new PublicKey(key);
    const data = loadBlacklist();
    if (!data.devs.some(row => row.address === key)) {
      data.devs.push({ address: key, reason: reason || 'Manual', source: source || 'manual', at: Date.now() });
      saveBlacklist(data);
    }
    return data;
  }

  function removeBlacklist(address, confirm) {
    if (confirm !== true) throw new ValidationError('Removing a dev requires confirm: true');
    const key = String(address || '').trim();
    const data = loadBlacklist();
    data.devs = data.devs.filter(row => row.address !== key);
    saveBlacklist(data);
    return data;
  }

  function updateSettings(auto) {
    const data = loadBlacklist();
    data.auto = {
      enabled: auto && auto.enabled !== undefined ? Boolean(auto.enabled) : data.auto.enabled,
      rugHistory: auto && auto.rugHistory !== undefined ? Boolean(auto.rugHistory) : data.auto.rugHistory,
      devHoldPct: auto && auto.devHoldPct != null ? Number(auto.devHoldPct) : data.auto.devHoldPct,
      rugcheckDanger: auto && auto.rugcheckDanger !== undefined ? Boolean(auto.rugcheckDanger) : data.auto.rugcheckDanger
    };
    saveBlacklist(data);
    return data.auto;
  }

  function isMintFlagged(mint) {
    const data = loadBlacklist();
    return Boolean(data.flaggedMints[mint]);
  }

  function flagMint(mint, creator) {
    if (!mint) return;
    const data = loadBlacklist();
    data.flaggedMints[mint] = { creator: creator || null, at: Date.now() };
    saveBlacklist(data);
  }

  async function readAuthorities(mint) {
    if (!connection || typeof connection.getAccountInfo !== 'function') return null;
    try {
      const info = await connection.getAccountInfo(new PublicKey(mint), 'confirmed');
      if (!info) return null;
      const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const unpacked = unpackMint(new PublicKey(mint), info, program);
      const extensions = [];
      const tlv = unpacked.tlvData || Buffer.alloc(0);
      if (getExtensionData(ExtensionType.PermanentDelegate, tlv)) extensions.push('permanentDelegate');
      if (getExtensionData(ExtensionType.TransferFeeConfig, tlv)) extensions.push('transferFee');
      if (getExtensionData(ExtensionType.TransferHook, tlv)) extensions.push('transferHook');
      return {
        mintAuthority: unpacked.mintAuthority ? unpacked.mintAuthority.toBase58() : null,
        freezeAuthority: unpacked.freezeAuthority ? unpacked.freezeAuthority.toBase58() : null,
        extensions
      };
    } catch (err) {
      return null;
    }
  }

  async function readHolders(mint) {
    if (!connection) return null;
    try {
      const supply = await connection.getTokenSupply(new PublicKey(mint), 'confirmed');
      const largest = await connection.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
      const curve = bondingCurvePda(mint, config.PUMP_PROGRAM_ID);
      let program = TOKEN_PROGRAM_ID;
      try {
        const info = await connection.getAccountInfo(new PublicKey(mint), 'confirmed');
        if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) program = TOKEN_2022_PROGRAM_ID;
      } catch (err) { /* classic ATA is the fallback */ }
      const curveAta = getAssociatedTokenAddressSync(new PublicKey(mint), curve, true, program).toBase58();
      const exclude = [curve.toBase58(), curveAta];
      try {
        const poolInfo = await connection.getAccountInfo(canonicalPoolPda(mint), 'confirmed');
        const pool = decodePool(poolInfo && poolInfo.data);
        if (pool && pool.baseVault) exclude.push(pool.baseVault);
      } catch (err) { /* an open curve has no pool vault */ }
      const value = supply && supply.value;
      return {
        accounts: (largest && largest.value || []).map(row => ({
          address: row.address && row.address.toBase58 ? row.address.toBase58() : String(row.address),
          amount: row.amount
        })),
        supplyRaw: value && value.amount,
        holderCount: null,
        exclude
      };
    } catch (err) {
      return null;
    }
  }

  async function readCurve(mint) {
    if (!connection || typeof connection.getAccountInfo !== 'function') return null;
    try {
      const info = await connection.getAccountInfo(bondingCurvePda(mint, config.PUMP_PROGRAM_ID), 'confirmed');
      return decodeBondingCurve(info && info.data);
    } catch (err) {
      return null;
    }
  }

  async function creatorBalancePct(creator, mint, supplyRaw) {
    if (!connection || !creator || !supplyRaw) return null;
    try {
      const accounts = await connection.getTokenAccountsByOwner(new PublicKey(creator), { mint: new PublicKey(mint) }, 'confirmed');
      let raw = 0n;
      for (const row of accounts.value || []) {
        const data = row.account && row.account.data;
        if (data && data.length >= 72) raw += data.readBigUInt64LE(64);
      }
      return Number((raw * 10000n) / BigInt(supplyRaw)) / 100;
    } catch (err) {
      return null;
    }
  }

  async function report(mint) {
    const key = String(mint || '').trim();
    if (!key) throw new Error('A mint is required');
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < ttlMs) return cached.report;
    if (isOwnLaunch(key)) {
      const own = {
        mint: key,
        ownLaunch: true,
        label: 'Own launch',
        checkedAt: Date.now(),
        overall: 'green',
        score: null,
        creator: null,
        blacklisted: false,
      checks: [],
      auto: loadBlacklist().auto
    };
    cache.set(key, { at: Date.now(), report: own });
      return own;
    }

    let rug = null;
    let coin = null;
    let dex = null;
    try { rug = await external(`${RUGCHECK}${key}/report/summary`); } catch (err) { rug = null; }
    try { coin = await external(`${PUMP_COIN}${key}`); } catch (err) { coin = null; }
    try {
      const body = await external(`https://api.dexscreener.com/latest/dex/tokens/${key}`);
      dex = body && Array.isArray(body.pairs) ? body.pairs[0] : null;
    } catch (err) { dex = null; }

    const creator = (coin && coin.creator) || (rug && (rug.creator || rug.creatorAddress)) || null;
    let coins = null;
    if (creator) {
      coins = [];
      try {
        for (let offset = 0; offset < 250; offset += 50) {
          const page = await external(`${PUMP_USER}${creator}?offset=${offset}&limit=50&includeNsfw=false`);
          const rows = Array.isArray(page) ? page : (page && page.coins) || [];
          coins.push(...rows);
          if (rows.length < 50) break;
        }
      } catch (err) {
        coins = null;
      }
    }

    const authorities = await readAuthorities(key);
    const holders = await readHolders(key);
    if (holders && rug && num(rug.totalHolders) != null) holders.holderCount = rug.totalHolders;
    const curve = await readCurve(key);
    const supplyRaw = holders && holders.supplyRaw;
    const devPct = await creatorBalancePct(creator, key, supplyRaw);
    const createdMs = coin && num(coin.created_timestamp)
      ? (coin.created_timestamp < 1e12 ? coin.created_timestamp * 1000 : coin.created_timestamp)
      : null;
    const socials = dex && dex.info && Array.isArray(dex.info.socials) ? dex.info.socials : [];
    const socialSource = (coin || dex)
      ? {
        ok: true,
        twitter: (coin && (coin.twitter || coin.x)) || (socials.find(row => /twitter|x\.com/i.test(`${row.type || ''} ${row.url || ''}`)) || {}).url || '',
        telegram: (coin && coin.telegram) || (socials.find(row => /telegram|t\.me/i.test(`${row.type || ''} ${row.url || ''}`)) || {}).url || '',
        website: (coin && coin.website) || (dex && dex.info && Array.isArray(dex.info.websites) && (dex.info.websites[0] && (dex.info.websites[0].url || dex.info.websites[0]))) || ''
      }
      : { ok: false };

    const checks = [
      rug ? classifyRugcheck(rug) : check('rugcheck', 'RugCheck', 'unknown', 'RugCheck request failed'),
      classifyAuthorities(authorities),
      classifyHolders(holders),
      classifySnipers({ unknown: true, reason: 'First-block buyers were not read' }),
      classifyCurve(curve),
      classifyMarket(dex),
      classifyAge(createdMs, Date.now()),
      classifySocials(socialSource),
      classifyDevHolding(devPct),
      classifyDevFlow({ unknown: true, reason: 'Creator buy and sell counts were not on the coin or RugCheck payload' }),
      classifyCreatedCoins(coins),
      classifyRugHistory(coins, rug),
      rug ? classifyCreatorFlags(rug) : check('creatorFlags', 'RugCheck creator flags', 'unknown', 'RugCheck request failed'),
      check('blacklist', 'Local blacklist', 'green', 'Dev is not on the local blacklist')
    ];

    const book = loadBlacklist();
    const listed = creator && book.devs.find(row => row.address === creator);
    if (listed) {
      checks[checks.length - 1] = check('blacklist', 'Local blacklist', 'red', `Dev is blacklisted: ${listed.reason}`);
      flagMint(key, creator);
    }

    const summary = overallFromChecks(checks);
    const row = {
      mint: key,
      ownLaunch: false,
      label: null,
      checkedAt: Date.now(),
      overall: summary.overall,
      score: summary.score,
      creator,
      blacklisted: Boolean(listed),
      blacklistReason: listed ? listed.reason : null,
      checks
    };
    maybeAutoBlacklist(row, book);
    row.auto = loadBlacklist().auto;
    cache.set(key, { at: Date.now(), report: row });
    return row;
  }

  function maybeAutoBlacklist(row, book) {
    const auto = book.auto || DEFAULT_AUTO;
    if (!auto.enabled || !row.creator || book.devs.some(item => item.address === row.creator)) return;
    const byId = Object.fromEntries(row.checks.map(item => [item.id, item]));
    const reasons = [];
    if (auto.rugHistory && byId.rugHistory && byId.rugHistory.status === 'red') reasons.push(byId.rugHistory.reason);
    if (auto.rugcheckDanger && byId.rugcheck && byId.rugcheck.status === 'red') reasons.push(byId.rugcheck.reason);
    const hold = byId.devHolding;
    const holdPct = hold && /([\d.]+)%/.exec(hold.reason);
    if (auto.devHoldPct != null && holdPct && Number(holdPct[1]) > Number(auto.devHoldPct) && hold.status === 'red') {
      reasons.push(hold.reason);
    }
    if (!reasons.length) return;
    addBlacklist(row.creator, reasons[0], 'auto');
    row.blacklisted = true;
    row.blacklistReason = reasons[0];
    row.checks = row.checks.map(item => item.id === 'blacklist'
      ? check('blacklist', 'Local blacklist', 'red', `Dev was auto-blacklisted: ${reasons[0]}`)
      : item);
    const again = overallFromChecks(row.checks);
    row.overall = again.overall;
    row.score = again.score;
    flagMint(row.mint, row.creator);
  }

  function buyBlockReason(mint) {
    if (!mint || isOwnLaunch(mint)) return null;
    const data = loadBlacklist();
    const flagged = data.flaggedMints[mint];
    const creator = flagged && flagged.creator;
    const row = creator && data.devs.find(item => item.address === creator);
    if (!row) return null;
    return `Buys blocked: dev ${creator} is blacklisted (${row.reason}). Existing positions are not sold automatically.`;
  }

  return {
    report,
    buyBlockReason,
    isOwnLaunch,
    noteOwnLaunch,
    listBlacklist,
    addBlacklist,
    removeBlacklist,
    updateSettings,
    isMintFlagged,
    cache
  };
}

async function defaultFetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const safetyChecks = createSafetyChecks();

module.exports = {
  createSafetyChecks,
  overallFromChecks,
  classifyRugcheck,
  classifyAuthorities,
  classifyHolders,
  classifySnipers,
  classifyCurve,
  classifyMarket,
  classifyAge,
  classifySocials,
  classifyDevHolding,
  classifyCreatedCoins,
  classifyRugHistory,
  safetyChecks
};
