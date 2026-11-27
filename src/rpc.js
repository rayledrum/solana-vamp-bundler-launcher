const { Connection, VersionedTransaction, Transaction } = require('@solana/web3.js');
const { ValidationError } = require('./validation');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;
const config = require('./config');

const READ_COOLDOWN_MS = 5 * 60 * 1000;
const CREDIT_COOLDOWN_MS = 60 * 60 * 1000;
const LIVE_TRADING_PAUSED = 'Live trading paused: only public RPC available';

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
  const msg = String(err.message || err).toLowerCase();
  const code = err.code || err.errno || err.statusCode || err.status;
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ENOTFOUND' || code === 'EPIPE' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'transport';
  }
  if (/econnreset|econnrefused|etimedout|socket hang up|network error|fetch failed|timed out|timeout|aborted/.test(msg)) return 'transport';
  if (/max usage|credit|exhausted|insufficient credits|api key/.test(msg)) return 'credit';
  if (code === 401 || code === 403 || /\b401\b|\b403\b|unauthorized|forbidden/.test(msg)) return 'credit';
  if (code === 429 || /\b429\b|too many requests|rate limit/.test(msg)) return 'rate';
  return null;
}

function signatureOf(raw) {
  if (!raw) return null;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  try {
    const versioned = VersionedTransaction.deserialize(buf);
    if (versioned.signatures && versioned.signatures[0]) return bs58.encode(versioned.signatures[0]);
  } catch (err) { /* legacy tx next */ }
  try {
    const legacy = Transaction.from(buf);
    if (legacy.signature) return bs58.encode(legacy.signature);
  } catch (err) { /* not a transaction */ }
  return null;
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
  const providers = (options.providers || providersFromConfig()).map(row => ({
    ...row,
    unhealthyUntil: 0,
    lastKind: null
  }));
  const connect = options.connect || ((provider) => new Connection(provider.httpUrl, {
    commitment: 'confirmed',
    wsEndpoint: provider.wsUrl || undefined
  }));
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
    const provider = providers.find(row => row.name === name);
    if (!provider) return null;
    const wait = kind === 'credit' ? creditCooldownMs : cooldownMs;
    provider.unhealthyUntil = now() + wait;
    provider.lastKind = kind || 'rate';
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

  async function invoke(provider, method, args) {
    const conn = connectionFor(provider);
    const fn = conn[method];
    if (typeof fn !== 'function') throw new Error(`${provider.name} has no ${method}`);
    return fn.apply(conn, args);
  }

  async function call(method, args) {
    const first = pick();
    if (!first) throw new Error('No RPC provider is configured');
    try {
      return await invoke(first, method, args);
    } catch (err) {
      const kind = classifyRpcError(err);
      if (!kind) throw scrub(err);
      markUnhealthy(first.name, kind);
      const next = pick();
      if (!next || next.name === first.name) throw scrub(err);
      return invoke(next, method, args);
    }
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

  async function send(method, args) {
    const first = pick();
    if (!first) throw new Error('No RPC provider is configured');
    const signature = signatureOf(args && args[0]);
    try {
      return await invoke(first, method, args);
    } catch (err) {
      const kind = classifyRpcError(err);
      if (!kind) throw scrub(err);
      markUnhealthy(first.name, kind);
      if (kind !== 'transport') throw scrub(err);
      const next = pick();
      if (!next || next.name === first.name) throw scrub(err);
      if (signature) {
        const landed = await signatureLanded(next, signature);
        if (landed === true) return signature;
        if (landed == null) throw scrub(err);
      }
      return invoke(next, method, args);
    }
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
    resubscribe();
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

  function subscribe(method, args) {
    const provider = pick();
    if (!provider) throw new Error('No RPC provider is configured');
    const conn = connectionFor(provider);
    const localId = ++subSeq;
    const remoteId = typeof conn[method] === 'function' ? conn[method](...args) : null;
    subscriptions.push({ localId, remoteId, method, args, provider: provider.name });
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
    providers
  };
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
  classifyRpcError,
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
