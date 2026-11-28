const { AsyncLocalStorage } = require('async_hooks');
const { Connection, VersionedTransaction, Transaction } = require('@solana/web3.js');
const { ValidationError } = require('./validation');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;
const config = require('./config');

const READ_COOLDOWN_MS = 5 * 60 * 1000;
const CREDIT_COOLDOWN_MS = 30 * 60 * 1000;
const RATE_SUSTAINED_MS = 30 * 1000;
const RATE_FAILOVER_MS = 30 * 1000;
const RATE_RETRIES = 3;
const MAX_LOG_SUBS = 8;
const LIVE_TRADING_PAUSED = 'Live trading paused: only public RPC available';
const callLane = new AsyncLocalStorage();
const PRIORITY_METHODS = new Set([
  'sendTransaction',
  'sendRawTransaction',
  'confirmTransaction',
  'getSignatureStatuses',
  'getLatestBlockhash',
  'simulateTransaction',
  'getFeeForMessage'
]);

function redactUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch (err) {
    return value.replace(/([/?#].*)$/, '/…');
  }
}

function redactText(text) {
  return String(text || '').replace(/\b(?:https?|wss?):\/\/[^\s'")]+/gi, (url) => redactUrl(url));
}

function classifyRpcError(err) {
  if (!err) return null;
  const nested = err.error && typeof err.error === 'object' ? err.error : null;
  const msg = `${err.message || err} ${nested && nested.message || ''}`.toLowerCase();
  const code = err.code || err.errno || err.statusCode || err.status || (nested && nested.code);
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ENOTFOUND' || code === 'EPIPE' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'transport';
  }
  if (/econnreset|econnrefused|etimedout|socket hang up|network error|fetch failed|timed out|timeout|aborted/.test(msg)) return 'transport';
  if (/max usage reached|max usage|credit|exhausted|insufficient credits/.test(msg)) return 'credit';
  if (code === 401 || code === 402 || code === 403 || /\b401\b|\b402\b|\b403\b|unauthorized|forbidden|payment required/.test(msg)) return 'credit';
  if (code === 429 || code === -32429 || code === '-32429' || code === -32007 || code === '-32007' || /\b429\b|-32429|-32007|too many requests|rate limit|request limit/.test(msg)) return 'rate';
  return null;
}

function defaultRps(name, cfg = config) {
  if (name === 'QuickNode') return cfg.QUICKNODE_RPS;
  if (name === 'Helius') return cfg.HELIUS_RPS;
  return cfg.PUBLIC_RPS;
}

function createTokenBucket({ rps = 12, now = Date.now, sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const unlimited = !Number.isFinite(rps) || rps <= 0;
  const limit = unlimited ? 0 : Math.max(1, Math.floor(rps));
  const stamps = [];
  const recent = [];
  const queue = [];
  let seq = 0;
  let pumping = false;

  function prune(at) {
    while (stamps.length && at - stamps[0] >= 1000) stamps.shift();
    const cutoff = at - 60_000;
    while (recent.length && recent[0] < cutoff) recent.shift();
  }

  function note(at) {
    recent.push(at);
  }

  function grant(at) {
    stamps.push(at);
    note(at);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const at = now();
        prune(at);
        if (stamps.length < limit) {
          grant(at);
          queue.shift().resolve();
          continue;
        }
        await sleep(Math.max(1, 1000 - (at - stamps[0])));
      }
    } finally {
      pumping = false;
      if (queue.length) pump();
    }
  }

  function acquire(priority = false) {
    if (unlimited) {
      note(now());
      return Promise.resolve();
    }
    const at = now();
    prune(at);
    const priorityWaiting = queue.some(item => item.priority);
    if (stamps.length < limit && (priority || !priorityWaiting)) {
      grant(at);
      return Promise.resolve();
    }
    return new Promise(resolve => {
      queue.push({ priority: priority ? 1 : 0, seq: seq++, resolve });
      queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      pump();
    });
  }

  return {
    acquire,
    requestsInLastMinute() {
      const cutoff = now() - 60_000;
      return recent.filter(at => at >= cutoff).length;
    }
  };
}

function connectionOptions(provider) {
  const options = {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    wsEndpoint: provider && provider.wsUrl ? provider.wsUrl : undefined
  };
  if (provider && provider.limiter && provider.limitInFetch) {
    const baseFetch = globalThis.fetch;
    options.fetch = (input, init) => provider.limiter.acquire(callLane.getStore() === true).then(() => baseFetch(input, init));
  }
  return options;
}

function failoverLabel(kind) {
  if (kind === 'credit') return 'credit exhausted';
  if (kind === 'rate') return 'rate limited';
  return 'unreachable';
}

function isVersionedTx(value) {
  if (value instanceof VersionedTransaction) return true;
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.serialize === 'function'
    && Array.isArray(value.signatures)
    && value.message
    && !Array.isArray(value.instructions)
  );
}

function isLegacyTx(value) {
  if (value instanceof Transaction) return true;
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.sign === 'function'
    && Array.isArray(value.instructions)
  );
}

function encodeSig(sig) {
  if (!sig || sig.length === 0) return null;
  return bs58.encode(sig);
}

function toBytes(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (Array.isArray(raw)) {
    if (!raw.every(item => typeof item === 'number')) return null;
    return Buffer.from(raw);
  }
  if (typeof raw === 'string' && raw) return Buffer.from(raw, 'base64');
  return null;
}

function signatureOf(raw) {
  try {
    if (raw == null || typeof raw === 'number' || typeof raw === 'boolean') return null;
    if (isVersionedTx(raw)) return encodeSig(raw.signatures && raw.signatures[0]);
    if (isLegacyTx(raw)) return encodeSig(raw.signature);
    const buf = toBytes(raw);
    if (!buf || buf.length === 0) return null;
    try {
      const versioned = VersionedTransaction.deserialize(buf);
      if (versioned.signatures && versioned.signatures[0]) return encodeSig(versioned.signatures[0]);
    } catch (err) { /* legacy tx next */ }
    try {
      const legacy = Transaction.from(buf);
      if (legacy.signature) return encodeSig(legacy.signature);
    } catch (err) { /* not a transaction */ }
    return null;
  } catch (err) {
    return null;
  }
}

function providersFromConfig(cfg = config) {
  const list = [];
  if (cfg.HELIUS_CONFIGURED && cfg.HELIUS_RPC_URL) {
    list.push({
      name: 'Helius',
      httpUrl: cfg.HELIUS_RPC_URL,
      wsUrl: cfg.HELIUS_WS_URL || '',
      configured: true
    });
  }
  if (cfg.QUICKNODE_CONFIGURED && cfg.QUICKNODE_RPC_URL) {
    list.push({
      name: 'QuickNode',
      httpUrl: cfg.QUICKNODE_RPC_URL,
      wsUrl: cfg.QUICKNODE_WS_URL || '',
      configured: true
    });
  }
  list.push({
    name: 'Public',
    httpUrl: cfg.SOLANA_PUBLIC_RPC_URL,
    wsUrl: '',
    configured: true
  });
  return list;
}

function createRpcPool(options = {}) {
  const now = options.now || Date.now;
  const cooldownMs = options.cooldownMs == null ? READ_COOLDOWN_MS : options.cooldownMs;
  const creditCooldownMs = options.creditCooldownMs == null ? CREDIT_COOLDOWN_MS : options.creditCooldownMs;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const rateRetries = options.rateRetries == null ? RATE_RETRIES : options.rateRetries;
  const rateSustainedMs = options.rateSustainedMs == null ? RATE_SUSTAINED_MS : options.rateSustainedMs;
  const usingDefaultConnect = options.connect == null;
  const providers = (options.providers || providersFromConfig()).map(row => {
    const rps = row.rps != null ? row.rps : defaultRps(row.name);
    return {
      ...row,
      rps,
      unhealthyUntil: 0,
      lastKind: null,
      rateSince: 0,
      limiter: createTokenBucket({ rps, now, sleep }),
      limitInFetch: usingDefaultConnect && Number.isFinite(rps)
    };
  });
  const log = options.log || (line => console.log(line));
  const connect = options.connect || ((provider) => new Connection(provider.httpUrl, connectionOptions(provider)));
  const connections = new Map();
  const watched = new Set();
  const socketFailures = new Map();
  const subscriptions = [];
  let subSeq = 0;

  function connectionFor(provider) {
    if (!connections.has(provider.name)) {
      const conn = connect(provider);
      connections.set(provider.name, conn);
      watchSocket(provider, conn);
    }
    return connections.get(provider.name);
  }

  function healthy(provider, at = now()) {
    return provider.unhealthyUntil <= at;
  }

  function pick(at = now()) {
    const ready = providers.find(row => healthy(row, at));
    if (ready) return ready;
    return providers.slice().sort((a, b) => a.unhealthyUntil - b.unhealthyUntil)[0] || null;
  }

  function markUnhealthy(name, kind) {
    const before = pick();
    const provider = providers.find(row => row.name === name);
    if (!provider) return null;
    const wait = kind === 'credit' ? creditCooldownMs : (kind === 'rate' ? (options.rateFailoverMs == null ? RATE_FAILOVER_MS : options.rateFailoverMs) : cooldownMs);
    provider.unhealthyUntil = now() + wait;
    provider.lastKind = kind || 'rate';
    const after = pick();
    if (before && after && before.name !== after.name) {
      log(`RPC failover: ${before.name} -> ${after.name} (${failoverLabel(kind)})`);
      resubscribe();
    }
    return provider;
  }

  function status(at = now()) {
    const active = pick(at);
    return {
      active: active ? active.name : null,
      providers: providers.map(row => ({
        name: row.name,
        configured: row.configured !== false,
        healthy: healthy(row, at),
        cooldownMs: Math.max(0, row.unhealthyUntil - at)
      }))
    };
  }

  function backoffMs(tryIndex) {
    const base = Math.min(2000, 200 * (2 ** tryIndex));
    return base + Math.floor(Math.random() * 50);
  }

  async function invoke(provider, method, args, priority) {
    if (provider.limiter && !provider.limitInFetch) await provider.limiter.acquire(priority);
    return callLane.run(Boolean(priority), () => {
      const conn = connectionFor(provider);
      const fn = conn[method];
      if (typeof fn !== 'function') throw new Error(`${provider.name} has no ${method}`);
      return fn.apply(conn, args);
    });
  }

  async function runWith(provider, method, args, { priority = false, rateTries = 0, failover = true } = {}) {
    try {
      const result = await invoke(provider, method, args, priority);
      provider.rateSince = 0;
      return result;
    } catch (err) {
      const kind = classifyRpcError(err);
      if (kind === 'rate') {
        if (!provider.rateSince) provider.rateSince = now();
        const sustained = now() - provider.rateSince >= rateSustainedMs;
        if (!sustained && rateTries < rateRetries) {
          await sleep(backoffMs(rateTries));
          return runWith(provider, method, args, { priority, rateTries: rateTries + 1, failover });
        }
        if (!(sustained && failover)) throw scrub(err);
        markUnhealthy(provider.name, 'rate');
      } else if (!kind || !failover) {
        throw scrub(err);
      } else {
        markUnhealthy(provider.name, kind);
      }
      const next = pick();
      if (!next || next.name === provider.name) throw scrub(err);
      return runWith(next, method, args, { priority, rateTries: 0, failover });
    }
  }

  async function call(method, args, priority = false) {
    const first = pick();
    if (!first) throw new Error('No RPC provider is configured');
    return runWith(first, method, args, { priority: priority || PRIORITY_METHODS.has(method) });
  }

  async function signatureLanded(provider, signature) {
    try {
      const result = await invoke(provider, 'getSignatureStatuses', [[signature]]);
      const row = result && result.value && result.value[0];
      return Boolean(row);
    } catch (err) {
      return null;
    }
  }

  async function prepareSend(method, args) {
    const list = args || [];
    if (method !== 'sendTransaction') {
      return { method, args: list, signature: signatureOf(list[0]) };
    }
    const tx = list[0];
    if (isVersionedTx(tx)) {
      if (Array.isArray(list[1])) throw new Error('Invalid arguments');
      const raw = tx.serialize();
      return { method: 'sendRawTransaction', args: [raw, list[1]], signature: signatureOf(tx) || signatureOf(raw) };
    }
    if (isLegacyTx(tx)) {
      const signers = list[1];
      if (!Array.isArray(signers)) throw new Error('Invalid arguments');
      if (!tx.recentBlockhash && !tx.nonceInfo) {
        const latest = await call('getLatestBlockhash', ['confirmed']);
        const value = latest && latest.blockhash ? latest : latest && latest.value;
        if (!value || !value.blockhash) throw new Error('failed to get recent blockhash');
        tx.recentBlockhash = value.blockhash;
        tx.lastValidBlockHeight = value.lastValidBlockHeight;
      }
      if (!tx.feePayer) {
        const payer = signers[0] && signers[0].publicKey;
        if (!payer) throw new Error('sendTransaction needs a fee payer');
        tx.feePayer = payer;
      }
      tx.sign(...signers);
      const raw = tx.serialize();
      return { method: 'sendRawTransaction', args: [raw, list[2]], signature: signatureOf(raw) };
    }
    return { method, args: list, signature: signatureOf(tx) };
  }

  async function send(method, args) {
    const first = pick();
    if (!first) throw new Error('No RPC provider is configured');
    // Sign a Transaction once, then every attempt uses those exact bytes.
    const prepared = await prepareSend(method, args);
    const deliver = async (provider, rateTries) => {
      try {
        const sent = await invoke(provider, prepared.method, prepared.args, true);
        provider.rateSince = 0;
        return sent;
      } catch (err) {
        const kind = classifyRpcError(err);
        if (kind === 'rate') {
          if (prepared.signature) {
            const landed = await signatureLanded(provider, prepared.signature);
            if (landed === true) return prepared.signature;
            if (landed == null) throw scrub(err);
          }
          if (!provider.rateSince) provider.rateSince = now();
          const sustained = now() - provider.rateSince >= rateSustainedMs;
          if (!sustained && rateTries < rateRetries) {
            await sleep(backoffMs(rateTries));
            return deliver(provider, rateTries + 1);
          }
          if (!sustained) throw scrub(err);
          markUnhealthy(provider.name, 'rate');
          const next = pick();
          if (!next || next.name === provider.name) throw scrub(err);
          return deliver(next, 0);
        }
        if (!kind) throw scrub(err);
        markUnhealthy(provider.name, kind);
        if (kind !== 'transport') throw scrub(err);
        const next = pick();
        if (!next || next.name === provider.name) throw scrub(err);
        if (prepared.signature) {
          const landed = await signatureLanded(next, prepared.signature);
          if (landed === true) return prepared.signature;
          if (landed == null) throw scrub(err);
        }
        return invoke(next, prepared.method, prepared.args, true);
      }
    };
    return deliver(first, 0);
  }

  function watchSocket(provider, conn) {
    if (watched.has(provider.name)) return;
    const ws = conn && conn._rpcWebSocket;
    if (!ws || typeof ws.on !== 'function') return;
    watched.add(provider.name);
    const note = () => noteSocketClosed(provider.name);
    ws.on('error', note);
    ws.on('close', note);
  }

  function noteSocketClosed(name) {
    const count = (socketFailures.get(name) || 0) + 1;
    socketFailures.set(name, count);
    if (count < 2) return;
    socketFailures.set(name, 0);
    markUnhealthy(name, 'transport');
  }

  async function probe(probeOptions = {}) {
    const timeoutMs = probeOptions.timeoutMs == null ? 2500 : probeOptions.timeoutMs;
    const method = probeOptions.method || 'getSlot';
    const args = method === 'getHealth' ? [] : ['processed'];
    for (const provider of providers) {
      if (!healthy(provider)) continue;
      let timer;
      try {
        await Promise.race([
          invoke(provider, method, args),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const err = new Error('timeout');
              err.code = 'ETIMEDOUT';
              reject(err);
            }, timeoutMs);
          })
        ]);
        clearTimeout(timer);
        return provider;
      } catch (err) {
        clearTimeout(timer);
        const kind = classifyRpcError(err);
        if (kind === 'rate') continue;
        markUnhealthy(provider.name, kind || 'transport');
      }
    }
    return pick();
  }

  function resubscribe() {
    const provider = pick();
    if (!provider) return;
    subscriptions.forEach(sub => {
      const previous = providers.find(row => row.name === sub.provider);
      const previousConn = previous && connections.get(previous.name);
      if (previousConn && sub.remoteId != null) {
        const remove = sub.method === 'onLogs' ? 'removeOnLogsListener' : 'removeAccountChangeListener';
        if (typeof previousConn[remove] === 'function') {
          try { previousConn[remove](sub.remoteId); } catch (err) { /* already closed */ }
        }
      }
      const conn = connectionFor(provider);
      if (typeof conn[sub.method] !== 'function') return;
      sub.remoteId = conn[sub.method](...sub.args);
      sub.provider = provider.name;
    });
  }

  function subscriptionKey(method, args) {
    const target = args && args[0];
    const id = target && target.toBase58 ? target.toBase58() : String(target == null ? '' : target);
    const commitment = typeof args[2] === 'string' ? args[2] : (typeof args[1] === 'string' ? args[1] : '');
    return `${method}:${id}:${commitment}`;
  }

  function openSubscription(sub, attempt) {
    const provider = providers.find(row => row.name === sub.provider) || pick();
    if (!provider) return;
    const conn = connectionFor(provider);
    const start = () => {
      if (!subscriptions.includes(sub)) return;
      try {
        sub.remoteId = typeof conn[sub.method] === 'function' ? conn[sub.method](...sub.args) : null;
        sub.provider = provider.name;
      } catch (err) {
        if (classifyRpcError(err) === 'rate' && attempt < rateRetries) {
          sleep(backoffMs(attempt)).then(() => openSubscription(sub, attempt + 1));
          return;
        }
      }
    };
    if (!provider.limiter || !Number.isFinite(provider.rps)) {
      start();
      return;
    }
    provider.limiter.acquire(false).then(start);
  }

  function subscribe(method, args) {
    const provider = pick();
    if (!provider) throw new Error('No RPC provider is configured');
    const key = subscriptionKey(method, args);
    const existing = subscriptions.find(row => row.key === key);
    if (existing) return existing.localId;
    if (method === 'onLogs' && subscriptions.filter(row => row.method === 'onLogs').length >= MAX_LOG_SUBS) {
      log('RPC logsSubscribe skipped: subscription cap reached');
      return 0;
    }
    const localId = ++subSeq;
    const sub = { localId, remoteId: null, method, args, provider: provider.name, key };
    subscriptions.push(sub);
    openSubscription(sub, 0);
    return localId;
  }

  function unsubscribe(method, localId) {
    const index = subscriptions.findIndex(row => row.localId === localId);
    if (index < 0) return;
    const sub = subscriptions[index];
    const conn = connections.get(sub.provider);
    const remove = method === 'onLogs' ? 'removeOnLogsListener' : 'removeAccountChangeListener';
    if (conn && typeof conn[remove] === 'function' && sub.remoteId != null) {
      try { conn[remove](sub.remoteId); } catch (err) { /* already closed */ }
    }
    subscriptions.splice(index, 1);
  }

  const connection = new Proxy({}, {
    get(target, prop) {
      if (prop === 'rpcPool') return api;
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
      if (prop === 'onAccountChange') return (...args) => subscribe('onAccountChange', args);
      if (prop === 'onLogs') return (...args) => subscribe('onLogs', args);
      if (prop === 'removeAccountChangeListener') return (id) => unsubscribe('onAccountChange', id);
      if (prop === 'removeOnLogsListener') return (id) => unsubscribe('onLogs', id);
      if (prop === 'sendRawTransaction' || prop === 'sendTransaction') return (...args) => send(prop, args);
      // Transaction and Message objects must reach the connection unchanged.
      // They are not raw bytes, and they are not signed here.
      if (prop === 'simulateTransaction' || prop === 'getFeeForMessage') return (...args) => call(prop, args);
      if (prop === 'then') return undefined;
      const active = pick();
      const conn = active ? connectionFor(active) : null;
      const value = conn ? conn[prop] : undefined;
      if (typeof value !== 'function') return value;
      return (...args) => call(prop, args);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });

  const api = {
    connection,
    call,
    send,
    pick,
    markUnhealthy,
    status,
    noteSocketClosed,
    probe,
    providers
  };
  if (process.env.RPC_DEBUG === '1') {
    const timer = setInterval(() => {
      log(`RPC requests last 60s: ${providers.map(row => `${row.name} ${row.limiter ? row.limiter.requestsInLastMinute() : 0}/min`).join(', ')}`);
    }, 60_000);
    if (typeof timer.unref === 'function') timer.unref();
  }
  return api;
}

function scrub(err) {
  if (err && err.message) err.message = redactText(err.message);
  return err;
}

const rpc = createRpcPool();
let liveOverride = null;
let boundPool = null;

function bindLiveTradingPool(pool) {
  boundPool = pool || null;
}

function liveTradingPaused(snapshot) {
  if (liveOverride === 'allow') return false;
  if (liveOverride === 'pause') return true;
  const current = snapshot || (boundPool || rpc).status();
  return !current || current.active == null || current.active === 'Public';
}

function assertLiveTrading() {
  if (!liveTradingPaused()) return;
  throw new ValidationError(LIVE_TRADING_PAUSED);
}

function setLiveTradingOverride(mode) {
  liveOverride = mode == null ? null : mode;
}

function startupLine() {
  const rows = rpc.status().providers;
  const names = rows.map(row => row.name).join(', ');
  return `RPC providers: ${names}. Active: ${rpc.status().active}`;
}

module.exports = {
  createRpcPool,
  createTokenBucket,
  classifyRpcError,
  connectionOptions,
  redactUrl,
  redactText,
  signatureOf,
  providersFromConfig,
  rpc,
  startupLine,
  liveTradingPaused,
  assertLiveTrading,
  setLiveTradingOverride,
  bindLiveTradingPool,
  LIVE_TRADING_PAUSED,
  READ_COOLDOWN_MS,
  CREDIT_COOLDOWN_MS
};
