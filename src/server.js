const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const config = require('./config');
const walletManager = require('./walletManager');
const bundler = require('./bundler');
const vampScanner = require('./vampScanner');
const pumpfun = require('./pumpfun');
const tradingEngine = require('./tradingEngine');
const { createAuthMiddleware, loadOrCreateApiToken, tokenAccepted } = require('./auth');
const { fetchHttpsImage } = require('./safeImage');
const {
  parseStrictBoolean,
  requirePositive,
  requireSolTradeAmount,
  requireSellPct,
  requireBumperInterval,
  requirePublicKey,
  requireMint,
  requireLaunchAmounts,
  requireSlippage,
  requirePriorityFee,
  ValidationError
} = require('./validation');

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

const apiAuth = loadOrCreateApiToken({ envToken: process.env.API_TOKEN });
const requireApiToken = createAuthMiddleware(apiAuth.token);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

let mutationActive = false;

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' https: data: blob:",
    "connect-src 'self' https://cdn.jsdelivr.net https://cdn.tailwindcss.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', requireApiToken);

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}
tradingEngine.setBroadcaster(broadcast);
bundler.setBroadcaster(broadcast);

function sendError(res, err) {
  const status = err.statusCode || (err instanceof ValidationError ? 400 : 500);
  if (!res.headersSent) res.status(status).json({ error: err.message });
}

function withMutationLock(handler) {
  return async (req, res) => {
    if (mutationActive) {
      return res.status(409).json({ error: 'Another trade or launch request is already running' });
    }
    mutationActive = true;
    try {
      await handler(req, res);
    } catch (err) {
      sendError(res, err);
    } finally {
      mutationActive = false;
    }
  };
}

server.on('upgrade', (request, socket, head) => {
  if (!tokenAccepted(request, apiAuth.token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', ws => {
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    payload: {
      message: 'Connected to Solana Vamp Launcher & Bundler Real-Time Stream',
      simulation: walletManager.simulationMode
    }
  }));
});

setInterval(async () => {
  try {
    let slot = 471866000;
    if (!walletManager.simulationMode && config.HELIUS_CONFIGURED) {
      slot = await walletManager.connection.getSlot('processed');
    } else {
      slot += Math.floor(Math.random() * 5);
    }
    broadcast({
      type: 'HEARTBEAT',
      payload: {
        slot,
        timestamp: Date.now(),
        simulation: walletManager.simulationMode
      }
    });
  } catch (err) {
    console.warn('[Heartbeat]', err.message);
  }
}, 3000);

app.get('/api/status', async (req, res) => {
  try {
    let slot = null;
    let rpcHealthy = false;
    if (config.HELIUS_CONFIGURED || !walletManager.simulationMode) {
      try {
        slot = await walletManager.connection.getSlot('confirmed');
        rpcHealthy = true;
      } catch (err) {
        rpcHealthy = false;
      }
    }

    res.json({
      success: true,
      simulationMode: walletManager.simulationMode,
      liveTradingAllowed: config.LIVE_TRADING,
      rpcHealthy,
      currentSlot: slot,
      heliusConfigured: config.HELIUS_CONFIGURED,
      jitoEndpoints: config.JITO_ENDPOINTS,
      defaultTip: config.DEFAULT_JITO_TIP,
      limits: {
        maxSolPerTrade: config.MAX_SOL_PER_TRADE,
        maxSolPerSession: config.MAX_SOL_PER_SESSION,
        maxJitoTipSol: config.MAX_JITO_TIP_SOL,
        slippagePct: config.SLIPPAGE_PCT,
        priorityFeeSol: config.PRIORITY_FEE_SOL,
        minBumpIntervalSec: config.MIN_BUMP_INTERVAL_SEC
      }
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/settings/simulation', (req, res) => {
  try {
    const enabled = parseStrictBoolean(req.body && req.body.enabled);
    const confirm = parseStrictBoolean(req.body && req.body.confirm);
    if (enabled === null) {
      return res.status(400).json({ error: 'enabled must be a boolean (true or false)' });
    }
    if (enabled === false) {
      if (!config.LIVE_TRADING) {
        return res.status(403).json({
          error: 'Live trading is locked. Set LIVE_TRADING=true in .env and restart. Create fresh wallets first; the previously published master and sub-wallets are leaked and must not be funded.'
        });
      }
      if (confirm !== true) {
        return res.status(400).json({ error: 'Switching to live mode requires confirm: true' });
      }
    }
    walletManager.setSimulationMode(enabled);
    broadcast({ type: 'SIMULATION_TOGGLED', payload: { simulation: walletManager.simulationMode } });
    res.json({ success: true, simulationMode: walletManager.simulationMode, liveTradingAllowed: config.LIVE_TRADING });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/settings/trading', (req, res) => {
  try {
    if (req.body && req.body.slippagePct !== undefined) {
      config.SLIPPAGE_PCT = requireSlippage(req.body.slippagePct);
    }
    if (req.body && req.body.priorityFeeSol !== undefined) {
      config.PRIORITY_FEE_SOL = requirePriorityFee(req.body.priorityFeeSol);
    }
    res.json({
      success: true,
      slippagePct: config.SLIPPAGE_PCT,
      priorityFeeSol: config.PRIORITY_FEE_SOL
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/wallets/master', async (req, res) => {
  try {
    const info = await walletManager.getMasterInfo();
    res.json({ success: true, master: info });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/wallets/master/generate', async (req, res) => {
  try {
    const address = await walletManager.generateNewMaster(req.body && req.body.force === true);
    broadcast({ type: 'MASTER_UPDATED', payload: { address } });
    res.json({ success: true, address });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/wallets/master/import', async (req, res) => {
  try {
    const { privateKey } = req.body || {};
    if (!privateKey) return res.status(400).json({ error: 'Private key is required' });
    const address = await walletManager.importMasterKey(privateKey, req.body.force === true);
    broadcast({ type: 'MASTER_UPDATED', payload: { address } });
    res.json({ success: true, address });
  } catch (err) {
    sendError(res, err.statusCode ? err : Object.assign(err, { statusCode: 400 }));
  }
});

app.get('/api/wallets/sub', async (req, res) => {
  try {
    const tokenMint = req.query.mint ? requireMint(req.query.mint) : null;
    const list = await walletManager.getSubWalletsInfo(tokenMint);
    res.json({ success: true, count: list.length, subWallets: list });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/wallets/sub/generate', async (req, res) => {
  try {
    const count = Number(req.body && req.body.count);
    if (!Number.isInteger(count) || count < 1 || count > 24) {
      return res.status(400).json({ error: 'count must be an integer from 1 to 24' });
    }
    const addresses = await walletManager.generateSubWallets(count, req.body.force === true);
    broadcast({ type: 'SUB_WALLETS_UPDATED', payload: { count: addresses.length } });
    res.json({ success: true, count: addresses.length, addresses });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/wallets/disperse', withMutationLock(async (req, res) => {
  const totalSol = requirePositive(req.body && req.body.totalSol, 'Total SOL', config.MAX_SOL_PER_SESSION);
  const randomize = parseStrictBoolean(req.body && req.body.randomize) === true;
  const deviationPct = req.body && req.body.deviationPct !== undefined ? Number(req.body.deviationPct) : 20;
  if (!Number.isFinite(deviationPct) || deviationPct < 0 || deviationPct > 100) {
    throw new ValidationError('deviationPct must be between 0 and 100');
  }
  const result = await walletManager.disperseSol(totalSol, randomize, deviationPct);
  broadcast({ type: 'SOL_DISPERSED', payload: result });
  res.json(result);
}));

app.post('/api/wallets/drain', withMutationLock(async (req, res) => {
  const result = await walletManager.drainSol();
  broadcast({ type: 'SOL_DRAINED', payload: result });
  res.status(result.success ? 200 : 502).json(result);
}));

app.post('/api/wallets/export', (req, res) => {
  try {
    if (!req.body || req.body.confirm !== true) {
      return res.status(400).json({ error: 'Exporting private keys requires confirm: true' });
    }
    res.json({ success: true, data: walletManager.exportAll() });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/wallets/reclaim-rent', withMutationLock(async (req, res) => {
  const mintAddress = req.body && req.body.mintAddress ? requireMint(req.body.mintAddress) : null;
  const result = await walletManager.reclaimRentAndRewards(mintAddress);
  res.json(result);
}));

app.post('/api/launch/upload-meta', upload.single('logo'), async (req, res) => {
  try {
    const { name, symbol, description, twitter, telegram, website, imageUrl } = req.body || {};
    if (!name || !symbol) {
      return res.status(400).json({ error: 'Token name and symbol are required' });
    }

    let fileBuffer = req.file ? req.file.buffer : null;
    let fileName = req.file ? req.file.originalname : 'logo.png';

    if (!fileBuffer && imageUrl) {
      try {
        const image = await fetchHttpsImage(imageUrl);
        fileBuffer = image.buffer;
        fileName = image.fileName;
      } catch (imgErr) {
        console.warn('[UploadMeta] Rejected remote imageUrl:', imgErr.message);
      }
    }

    const uploadRes = await pumpfun.uploadMetadata({
      name,
      symbol,
      description,
      twitter,
      telegram,
      website,
      fileBuffer,
      fileName
    });

    res.json({ success: true, ...uploadRes });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/launch/preflight', async (req, res) => {
  try {
    const amounts = requireLaunchAmounts({
      devSolBuy: req.body && req.body.devSolBuy,
      subWalletBuys: (req.body && req.body.subWalletBuys) || [],
      jitoTipSol: req.body && req.body.jitoTipSol
    });
    const check = await bundler.preflightCheck(amounts);
    res.json({ success: true, ...check });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/launch/execute', withMutationLock(async (req, res) => {
  const body = req.body || {};
  const { tokenName, tokenSymbol, tokenDescription, tokenMetadataUri } = body;
  if (!tokenName || !tokenSymbol) {
    throw new ValidationError('Token Name and Symbol are required');
  }
  if (tokenMetadataUri) {
    let metadataUrl;
    try { metadataUrl = new URL(String(tokenMetadataUri)); } catch (err) {
      throw new ValidationError('tokenMetadataUri must be an https URL');
    }
    if (metadataUrl.protocol !== 'https:') throw new ValidationError('tokenMetadataUri must be an https URL');
  }
  const amounts = requireLaunchAmounts({
    devSolBuy: body.devSolBuy,
    subWalletBuys: body.subWalletBuys || [],
    jitoTipSol: body.jitoTipSol
  });
  const delayRaw = body.subWalletDelaySec === undefined || body.subWalletDelaySec === '' ? 0 : Number(body.subWalletDelaySec);
  if (!Number.isFinite(delayRaw) || delayRaw < 0 || delayRaw > 10) {
    throw new ValidationError('subWalletDelaySec must be between 0 and 10');
  }

  broadcast({ type: 'LAUNCH_STARTED', payload: { tokenSymbol, tokenName, subWalletDelaySec: delayRaw } });

  let launchResult;
  try {
    launchResult = await bundler.launchBundle({
    tokenName,
    tokenSymbol,
    tokenDescription,
    tokenMetadataUri,
    devSolBuy: amounts.devSolBuy,
    subWalletBuys: amounts.subWalletBuys,
    jitoTipSol: amounts.jitoTipSol,
    subWalletDelaySec: delayRaw
  });
  } catch (err) {
    broadcast({ type: 'LAUNCH_FAILED', payload: { error: err.message, mint: err.mint || null } });
    throw err;
  }

  if (!launchResult.success) {
    broadcast({ type: 'LAUNCH_FAILED', payload: { error: launchResult.error || 'Bundle did not land', mint: launchResult.mint } });
    return res.status(502).json(launchResult);
  }

  const initialHoldings = [];
  if (launchResult.devBuy && Number.isFinite(Number(launchResult.devBuy.tokens))) {
    initialHoldings.push({
      address: walletManager.masterWallet.publicKey.toBase58(),
      tokens: Number(launchResult.devBuy.tokens),
      sol: Number(launchResult.devBuy.sol)
    });
  }
  for (const row of launchResult.subWallets || []) {
    if (row.landed === false || !Number.isFinite(Number(row.tokensBought))) continue;
    const wallet = walletManager.subWallets[(row.walletIndex || 1) - 1];
    if (!wallet) continue;
    initialHoldings.push({
      address: wallet.publicKey.toBase58(),
      tokens: Number(row.tokensBought),
      sol: Number(row.solSpent)
    });
  }

  tradingEngine.setActiveToken(launchResult.mint, initialHoldings);
  broadcast({ type: 'LAUNCH_SUCCESS', payload: launchResult });
  res.json({ success: true, ...launchResult });
}));

app.get('/api/vamp/trending', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '12', 10);
    const tokens = await vampScanner.getTrendingSolanaTokens(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 12);
    res.json({ success: true, tokens });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/vamp/inspect/:address', async (req, res) => {
  try {
    const address = requireMint(req.params.address);
    const token = await vampScanner.inspectToken(address);
    res.json({ success: true, token });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/vamp/mutate', (req, res) => {
  try {
    const { tokenData, mode } = req.body || {};
    const mutated = vampScanner.generateVampMutation(tokenData, mode);
    res.json({ success: true, mutated });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/chart/candles', async (req, res) => {
  try {
    const mint = requireMint(req.query.mint);
    const tf = String(req.query.tf || '1m');
    const data = await pumpfun.getChartCandles(mint, tf);
    res.json({ success: true, ...data });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/trading/stats', async (req, res) => {
  try {
    const requested = req.query.mint ? requireMint(req.query.mint) : null;
    if (requested && requested !== tradingEngine.activeToken) {
      return res.json({
        success: true,
        stats: {
          activeToken: requested,
          stale: true,
          currentMint: tradingEngine.activeToken,
          wallets: []
        }
      });
    }
    const stats = await tradingEngine.getLiveStats();
    if (requested && stats.activeToken !== requested) {
      stats.stale = true;
      stats.currentMint = tradingEngine.activeToken;
    }
    res.json({ success: true, stats });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/trading/track', (req, res) => {
  try {
    const mint = requireMint(req.body && req.body.mint);
    tradingEngine.setActiveToken(mint);
    res.json({ success: true, activeToken: mint });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/trading/buy', withMutationLock(async (req, res) => {
  const solAmount = requireSolTradeAmount(req.body && req.body.solAmount);
  const walletAddresses = Array.isArray(req.body && req.body.walletAddresses)
    ? req.body.walletAddresses.map(address => requirePublicKey(address, 'Wallet'))
    : [];
  const result = await tradingEngine.executeBuy({ solAmount, walletAddresses });
  res.status(result.success ? 200 : 502).json(result);
}));

app.post('/api/trading/sell', withMutationLock(async (req, res) => {
  const pct = requireSellPct(req.body && req.body.pct);
  const walletAddresses = Array.isArray(req.body && req.body.walletAddresses)
    ? req.body.walletAddresses.map(address => requirePublicKey(address, 'Wallet'))
    : [];
  const result = await tradingEngine.executeSell({ pct, walletAddresses });
  res.status(result.success ? 200 : 502).json(result);
}));

app.post('/api/trading/cascade-sell', withMutationLock(async (req, res) => {
  const delayMs = req.body && req.body.delayMs !== undefined ? Number(req.body.delayMs) : 1000;
  const pct = requireSellPct(req.body && req.body.pct !== undefined ? req.body.pct : 100);
  const result = await tradingEngine.executeCascadeSell(delayMs, pct);
  res.status(result.success ? 200 : 502).json(result);
}));

app.post('/api/trading/bumper/start', (req, res) => {
  try {
    const solAmount = requireSolTradeAmount(req.body && req.body.solAmount);
    const intervalSeconds = requireBumperInterval(req.body && req.body.intervalSeconds);
    tradingEngine.startVolumeBumper(solAmount, intervalSeconds);
    res.json({
      success: true,
      bumping: true,
      simulated: true,
      note: 'Volume bumper is simulation-only and does not submit transactions.'
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/trading/bumper/stop', (req, res) => {
  try {
    tradingEngine.stopVolumeBumper();
    res.json({ success: true, bumping: false, simulated: true });
  } catch (err) {
    sendError(res, err);
  }
});

const PORT = config.PORT;
server.listen(PORT, config.HOST, () => {
  console.log('=======================================================');
  console.log('SOLANA VAMP LAUNCHER & BUNDLER DESK');
  console.log(`URL: http://${config.HOST}:${PORT}`);
  console.log(`Helius RPC: ${config.HELIUS_CONFIGURED ? 'configured from .env' : 'not configured'}`);
  console.log(`Mode: ${walletManager.simulationMode ? 'SIMULATION (default)' : 'LIVE MAINNET'}`);
  console.log(`Live unlock: ${config.LIVE_TRADING ? 'LIVE_TRADING=true' : 'off'}`);
  console.log('=======================================================');
});
