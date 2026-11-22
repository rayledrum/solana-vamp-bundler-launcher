const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const config = require('./config');
const walletManager = require('./walletManager');
const bundler = require('./bundler');
const vampScanner = require('./vampScanner');
const pumpfun = require('./pumpfun');
const tradingEngine = require('./tradingEngine');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Configure Multer for token logo uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Broadcast helper to all connected WebSockets
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
}
tradingEngine.setBroadcaster(broadcast);

wss.on('connection', ws => {
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    payload: {
      message: 'Connected to Solana Vamp Launcher & Bundler Real-Time Stream',
      simulation: walletManager.simulationMode
    }
  }));
});

// Periodic Heartbeat / Slot broadcast via Helius (every 3 seconds)
setInterval(async () => {
  try {
    let slot = 471866000;
    if (!walletManager.simulationMode) {
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
  } catch (e) {
    // silently catch rpc heartbeat hiccups
  }
}, 3000);

// ==================== API ROUTES ====================

// Status & Config
app.get('/api/status', async (req, res) => {
  try {
    let slot = null;
    let rpcHealthy = true;
    try {
      slot = await walletManager.connection.getSlot('confirmed');
    } catch (e) {
      rpcHealthy = false;
    }

    res.json({
      success: true,
      simulationMode: walletManager.simulationMode,
      rpcHealthy,
      currentSlot: slot,
      heliusConfigured: Boolean(config.HELIUS_API_KEY),
      jitoEndpoints: config.JITO_ENDPOINTS,
      defaultTip: config.DEFAULT_JITO_TIP
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/simulation', (req, res) => {
  const { enabled } = req.body;
  walletManager.setSimulationMode(enabled);
  broadcast({ type: 'SIMULATION_TOGGLED', payload: { simulation: walletManager.simulationMode } });
  res.json({ success: true, simulationMode: walletManager.simulationMode });
});

// Wallets Management
app.get('/api/wallets/master', async (req, res) => {
  try {
    const info = await walletManager.getMasterInfo();
    res.json({ success: true, master: info });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wallets/master/generate', (req, res) => {
  try {
    const address = walletManager.generateNewMaster();
    broadcast({ type: 'MASTER_UPDATED', payload: { address } });
    res.json({ success: true, address });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wallets/master/import', (req, res) => {
  try {
    const { privateKey } = req.body;
    if (!privateKey) return res.status(400).json({ error: 'Private key is required' });
    const address = walletManager.importMasterKey(privateKey);
    broadcast({ type: 'MASTER_UPDATED', payload: { address } });
    res.json({ success: true, address });
  } catch (err) {
    res.status(400).json({ error: 'Invalid private key format: ' + err.message });
  }
});

app.get('/api/wallets/sub', async (req, res) => {
  try {
    const tokenMint = req.query.mint || null;
    const list = await walletManager.getSubWalletsInfo(tokenMint);
    res.json({ success: true, count: list.length, subWallets: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wallets/sub/generate', (req, res) => {
  try {
    const count = parseInt(req.body.count || '6', 10);
    const addresses = walletManager.generateSubWallets(count);
    broadcast({ type: 'SUB_WALLETS_UPDATED', payload: { count: addresses.length } });
    res.json({ success: true, count: addresses.length, addresses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wallets/disperse', async (req, res) => {
  try {
    const totalSol = parseFloat(req.body.totalSol);
    const randomize = Boolean(req.body.randomize);
    const deviationPct = parseFloat(req.body.deviationPct || '20');

    if (isNaN(totalSol) || totalSol <= 0) {
      return res.status(400).json({ error: 'Total SOL must be a positive number' });
    }

    const result = await walletManager.disperseSol(totalSol, randomize, deviationPct);
    broadcast({ type: 'SOL_DISPERSED', payload: result });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wallets/drain', async (req, res) => {
  try {
    const result = await walletManager.drainSol();
    broadcast({ type: 'SOL_DRAINED', payload: result });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wallets/export', (req, res) => {
  try {
    const keys = walletManager.exportAll();
    res.json({ success: true, data: keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Token Launch & Bundler
app.post('/api/launch/upload-meta', upload.single('logo'), async (req, res) => {
  try {
    const { name, symbol, description, twitter, telegram, website } = req.body;
    if (!name || !symbol) {
      return res.status(400).json({ error: 'Token name and symbol are required' });
    }

    const uploadRes = await pumpfun.uploadMetadata({
      name,
      symbol,
      description,
      twitter,
      telegram,
      website,
      fileBuffer: req.file ? req.file.buffer : null,
      fileName: req.file ? req.file.originalname : 'logo.png'
    });

    res.json({ success: true, ...uploadRes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/launch/preflight', async (req, res) => {
  try {
    const { devSolBuy, subWalletBuys, jitoTipSol } = req.body;
    const check = await bundler.preflightCheck({
      devSolBuy: parseFloat(devSolBuy || '0.5'),
      subWalletBuys: (subWalletBuys || []).map(x => parseFloat(x || '0')),
      jitoTipSol: parseFloat(jitoTipSol || '0.003')
    });
    res.json({ success: true, ...check });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/launch/execute', async (req, res) => {
  try {
    const {
      tokenName,
      tokenSymbol,
      tokenDescription,
      tokenMetadataUri,
      devSolBuy,
      subWalletBuys,
      jitoTipSol
    } = req.body;

    if (!tokenName || !tokenSymbol) {
      return res.status(400).json({ error: 'Token Name and Symbol are required' });
    }

    broadcast({ type: 'LAUNCH_STARTED', payload: { tokenSymbol, tokenName } });

    const launchResult = await bundler.launchBundle({
      tokenName,
      tokenSymbol,
      tokenDescription,
      tokenMetadataUri,
      devSolBuy: parseFloat(devSolBuy || '0.5'),
      subWalletBuys: (subWalletBuys || []).map(x => parseFloat(x || '0')),
      jitoTipSol: parseFloat(jitoTipSol || '0.003')
    });

    // Auto-track launched token in trading desk
    const initialHoldings = [
      { address: walletManager.masterWallet.publicKey.toBase58(), tokens: launchResult.devBuy?.tokens || 50000000, sol: parseFloat(devSolBuy || '0.5') }
    ];
    if (launchResult.subWallets) {
      launchResult.subWallets.forEach((sw, idx) => {
        const w = walletManager.subWallets[idx];
        if (w) {
          initialHoldings.push({
            address: w.publicKey.toBase58(),
            tokens: sw.tokensBought,
            sol: sw.solSpent
          });
        }
      });
    }

    tradingEngine.setActiveToken(launchResult.mint, initialHoldings);
    broadcast({ type: 'LAUNCH_SUCCESS', payload: launchResult });

    res.json({ success: true, ...launchResult });
  } catch (err) {
    broadcast({ type: 'LAUNCH_FAILED', payload: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

// Vamp Launcher / Cloner
app.get('/api/vamp/trending', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '12', 10);
    const tokens = await vampScanner.getTrendingSolanaTokens(limit);
    res.json({ success: true, tokens });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vamp/inspect/:address', async (req, res) => {
  try {
    const token = await vampScanner.inspectToken(req.params.address);
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vamp/mutate', (req, res) => {
  try {
    const { tokenData, mode } = req.body;
    const mutated = vampScanner.generateVampMutation(tokenData, mode);
    res.json({ success: true, mutated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live Trading & Exit Desk
app.get('/api/trading/stats', async (req, res) => {
  try {
    const requested = typeof req.query.mint === 'string' && req.query.mint ? req.query.mint : null;
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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trading/track', (req, res) => {
  try {
    const { mint } = req.body;
    if (!mint) return res.status(400).json({ error: 'Mint is required' });
    tradingEngine.setActiveToken(mint);
    res.json({ success: true, activeToken: mint });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trading/buy', async (req, res) => {
  try {
    const { solAmount, walletAddresses } = req.body;
    const result = await tradingEngine.executeBuy({
      solAmount: parseFloat(solAmount || '0.1'),
      walletAddresses: walletAddresses || []
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trading/sell', async (req, res) => {
  try {
    const { pct, walletAddresses } = req.body;
    const result = await tradingEngine.executeSell({
      pct: parseFloat(pct || '100'),
      walletAddresses: walletAddresses || []
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trading/cascade-sell', async (req, res) => {
  try {
    const delayMs = parseInt(req.body.delayMs || '1000', 10);
    const pct = parseFloat(req.body.pct || '100');
    const result = await tradingEngine.executeCascadeSell(delayMs, pct);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trading/bumper/start', (req, res) => {
  try {
    const solAmount = parseFloat(req.body.solAmount || '0.01');
    const intervalSeconds = parseInt(req.body.intervalSeconds || '20', 10);
    tradingEngine.startVolumeBumper(solAmount, intervalSeconds);
    res.json({ success: true, bumping: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trading/bumper/stop', (req, res) => {
  try {
    tradingEngine.stopVolumeBumper();
    res.json({ success: true, bumping: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
const PORT = config.PORT;
server.listen(PORT, config.HOST, () => {
  console.log(`=======================================================`);
  console.log(`🚀 SOLANA VAMP LAUNCHER & BUNDLER DESK RUNNING`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`⚡ Helius RPC: Connected (Free Tier API Key Active)`);
  console.log(`🛡️  Mode: ${walletManager.simulationMode ? 'SIMULATION MODE (Safe Testing)' : 'LIVE MAINNET'}`);
  console.log(`=======================================================`);
});

