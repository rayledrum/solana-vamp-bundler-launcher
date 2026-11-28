// Institutional Solana Memecoin Bundler & Trading Terminal
const state = {
  currentTab: 'trading',
  simulationMode: true,
  appWsOpen: false,
  feedConnected: false,
  feedSubscribed: 0,
  lastLiveBalanceAt: 0,
  currentSlot: null,
  masterWallet: null,
  subWallets: [],
  selectedJitoTip: 0.005,
  maxJitoTipSol: 0.01,
  launchMode: 'bundle',
  bundleForm: emptyBundleForm(),
  vampMinMcap: 0,
  vampMaxMcap: 0,
  vampMinAge: 0,
  vampMaxAge: 0,
  vampAgeUnit: 'minutes',
  vampMinVolume: 0,
  vampMinLiquidity: 0,
  vampSort: '',
  vampSortTouched: false,
  vampShowUnknown: false,
  activeToken: null,
  chartToken: null,
  chartEpoch: 0,
  logoFile: null,
  logoUrl: null,
  isBumping: false,
  ws: null,

  // Charting state (Ultra-fast timeframes down to 1s / 5s)
  chartTimeframe: '5s', // '1s', '5s', '15s', '30s', '1m', '5m'
  candles: [],
  // Source bars/ticks. Timeframe changes regroup these instead of clearing the chart.
  chartSamples: [],
  // Width of the stored samples. 1000 means real 1s bars are already loaded.
  chartSampleMs: null,
  currentCandle: null,
  lastPrice: null,
  allocation: { dev: 0, sub: 0, curve: 100 },
  curveProgressPct: 0,
  hoverCandle: null,

  // Sub-wallet execution settings
  subWalletDelaySec: 0,
  trendingTokens: []
};

const API_TOKEN_STORAGE = 'svarogApiToken';

function getApiToken() {
  let token = sessionStorage.getItem(API_TOKEN_STORAGE);
  if (!token) {
    token = window.prompt('Enter the API token printed by the server (or stored in data/api-token):');
    if (token) {
      token = token.trim();
      sessionStorage.setItem(API_TOKEN_STORAGE, token);
    }
  }
  return token || '';
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', 'Bearer ' + getApiToken());
  const response = await window.fetch(url, Object.assign({}, options, { headers }));
  if (response.status === 401) {
    sessionStorage.removeItem(API_TOKEN_STORAGE);
    showToast('API token was rejected. Reload the page and enter it again.', 'error');
  }
  return response;
}

function bindShellActions() {
  const call = (el, event) => {
    const name = el.dataset.fn;
    const arg = el.dataset.arg;
    if (name === 'toggleSimulation') return toggleSimulation(arg === 'true');
    if (name === 'toggleVolumeBumper') return toggleVolumeBumper(arg === 'true');
    if (name === 'refreshMovers') return loadTrendingVampTokens();
    if (name === 'copyInput') {
      const input = document.getElementById(arg);
      return copyToClipboard(input ? input.value : '', el.dataset.arg2 || 'CA');
    }
    if (name === 'clickLogo') return document.getElementById('logoFile').click();
    if (name === 'delayInput') return handleDelayInputChange(el.value);
    if (name === 'toggleSelectAll') return toggleSelectAllRows(el.checked);
    if (name === 'toggleSafetyAuto') return toggleSafetyAuto(el.checked);
    if (name === 'saveExitLadder') return saveExitLadder(el.checked);
    if (name === 'saveFarmRide') return saveFarmRide(el.checked);
    if (name === 'refreshResearch') return refreshResearch();
    if (name === 'logoSelect') return handleLogoSelect(event);
    if (name === 'captureLaunchDraft') {
      captureLaunchDraft(el);
      return;
    }
    if (name === 'bundleMetrics') {
      captureBundleInput(el);
      return calculateBundleMetrics();
    }
    const fn = window[name];
    if (typeof fn !== 'function') return;
    if (arg === undefined) return fn();
    if (/^-?\d+(\.\d+)?$/.test(arg)) return fn(Number(arg));
    return fn(arg);
  };
  const route = (eventName) => (event) => {
    const el = event.target.closest('[data-fn]');
    if (!el) return;
    if ((el.dataset.evt || 'click') !== eventName) return;
    call(el, event);
  };
  document.addEventListener('click', route('click'));
  document.addEventListener('input', route('input'));
  document.addEventListener('change', route('change'));
}

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  getApiToken();
  bindShellActions();
  if (window.lucide) lucide.createIcons();
  initChart();
  bindTrackedCaInputs();
  updateSimulationUi(state.simulationMode);
  connectWebSocket();
  document.addEventListener('visibilitychange', () => {
    if (!state.ws || state.ws.readyState !== 1) return;
    try {
      state.ws.send(JSON.stringify({ type: 'VISIBILITY', hidden: document.hidden }));
    } catch (err) { /* the next heartbeat is enough */ }
  });
  loadStatus();
  refreshResearch();
  loadMasterWallet();
  loadSubWallets();
  restoreLaunchPrefs();
  loadTrendingVampTokens();
  loadLiveStats();

  // Live mode pushes balances over the socket. Simulation refreshes slowly so a
  // free RPC plan is not spent on the desk sitting open.
  let lastStatsRefresh = 0;
  let lastWalletRefresh = 0;
  setInterval(() => {
    const gap = state.simulationMode ? 30000 : 8000;
    if (Date.now() - lastStatsRefresh < gap) return;
    lastStatsRefresh = Date.now();
    loadLiveStats();
  }, 8000);
  setInterval(() => {
    const gap = state.simulationMode ? 60000 : 20000;
    if (Date.now() - lastWalletRefresh < gap) return;
    lastWalletRefresh = Date.now();
    loadMasterWallet();
    loadSubWallets();
  }, 20000);
  setInterval(() => {
    renderFeedStatus();
    paintChartFeed();
  }, 1000);
});

// ==================== REAL-TIME WEBSOCKET PIPELINE ====================

function connectWebSocket() {
  const isHttp = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = (isHttp && window.location.host) ? window.location.host : '127.0.0.1:3000';
  const wsUrl = `${protocol}//${host}/?token=${encodeURIComponent(getApiToken())}`;

  try {
    state.ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('WebSocket init error:', err);
    setTimeout(connectWebSocket, 3000);
    return;
  }

  state.ws.onopen = () => {
    try {
      state.ws.send(JSON.stringify({ type: 'VISIBILITY', hidden: document.hidden }));
    } catch (err) { /* the socket is still opening */ }
    state.appWsOpen = true;
    renderFeedStatus();
    logTerminal('[WebSocket] Connected to real-time Helius & Jito telemetry');
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsMessage(data);
    } catch (e) {
      console.error('Error parsing WS message:', e);
    }
  };

  state.ws.onerror = (e) => {
    console.warn('[WebSocket] Connection notice for', wsUrl);
  };

  state.ws.onclose = () => {
    state.appWsOpen = false;
    state.feedConnected = false;
    renderFeedStatus();
    logTerminal('[WebSocket] Connection closed. Reconnecting in 3s...');
    setTimeout(connectWebSocket, 3000);
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'CONNECTED':
      noteSimulationMode(simulationModeFromUpdate(msg));
      break;

    case 'SIMULATION_TOGGLED':
      noteSimulationMode(simulationModeFromUpdate(msg));
      loadMasterWallet();
      loadSubWallets();
      loadLiveStats();
      break;

    case 'HEARTBEAT':
      noteSimulationMode(simulationModeFromUpdate(msg));
      paintRpcStatus(msg.payload && msg.payload.rpc);
      state.currentSlot = msg.payload.slot;
      if (msg.payload && Number.isFinite(msg.payload.slot)) {
        document.getElementById('slotDisplay').innerText = `Slot: ${msg.payload.slot.toLocaleString()}`;
      }
      const sbSlot = document.getElementById('sidebarSlotBadge');
      if (sbSlot) sbSlot.innerText = `Slot: ${msg.payload.slot.toLocaleString()}`;
      // Placeholder series only. A loaded coin chart is driven by its candles and trades.
      if (state.simulationMode && !state.chartToken) {
        const jitter = (Math.random() - 0.48) * 0.0000005;
        const newPrice = Math.max(0.000005, state.lastPrice + jitter);
        // Only push when no token is loaded; pass current epoch so it can be ignored after switch
        pushChartTick(newPrice, Math.random() * 0.1, state.chartEpoch);
      }
      break;

    case 'LAUNCH_STARTED':
      logTerminal(`🚀 [Bundle Launch] Started for ${msg.payload.tokenSymbol}... (Sub delay: ${msg.payload.subWalletDelaySec || 0}s)`);
      showToast(`Launching ${msg.payload.tokenSymbol}...`, 'info');
      break;

    case 'LAUNCH_STEP_DEV':
      logTerminal(`🚀 [Block 1 Landed] Dev token created & bought in 1st block! Mint: ${msg.payload.mint?.slice(0, 8)}...`);
      logTerminal(`⏳ [Delay Timer] Holding ${msg.payload.delaySec}s before sub-wallets buy...`);
      showToast(`Block 1 Dev Buy landed! Sub-wallets firing in ${msg.payload.delaySec}s...`, 'info');
      state.activeToken = msg.payload.mint;
      updateActiveTokenUi(msg.payload.mint);
      loadLiveStats();
      break;

    case 'LAUNCH_SUCCESS':
      logTerminal(`✅ [Bundle Landed] Mint: ${msg.payload.mint} | Slot: ${msg.payload.slot} | Jito Tip: ${msg.payload.jitoTipSol} SOL`);
      showToast(`Landed! Mint: ${msg.payload.mint.slice(0, 8)}...`, 'success');
      state.activeToken = msg.payload.mint;
      updateActiveTokenUi(msg.payload.mint);
      loadSubWallets();
      loadLiveStats();
      switchTab('trading');
      break;

    case 'LAUNCH_FAILED':
      logTerminal(`❌ [Bundle Failed] Error: ${msg.payload.error}`);
      showToast(`Launch failed: ${msg.payload.error}`, 'error');
      break;

    case 'BUY_EXECUTED':
      logTerminal(`🟢 [Manual Buy] Bought tokens for ${msg.payload.totalSpentSol} SOL across ${msg.payload.resultsCount} wallets`);
      showToast(`Bought tokens (+${msg.payload.totalSpentSol} SOL)`, 'success');
      applyReportedFill(msg.payload, msg.payload.totalSpentSol);
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'SELL_EXECUTED':
      logTerminal(`🔴 [Manual Sell] Sold ${msg.payload.pct}% | Recv: +${msg.payload.totalReceivedSol} SOL`);
      showToast(`Sold ${msg.payload.pct}% across bundle (+${msg.payload.totalReceivedSol} SOL)`, 'warning');
      applyReportedFill(msg.payload, msg.payload.totalReceivedSol);
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'CASCADE_STEP':
      logTerminal(`🌊 [Cascade] Step ${msg.payload.step}/${msg.payload.total} executed for ${msg.payload.address.slice(0, 6)}...`);
      applyReportedFill(msg.payload, 0);
      break;

    case 'CASCADE_COMPLETED':
      showToast('Cascade exit successfully completed', 'success');
      loadLiveStats();
      break;

    case 'SOL_DISPERSED':
      logTerminal(`💸 [Disperse] Sent SOL across sub-wallets successfully.`);
      showToast('SOL dispersed to all sub-wallets', 'success');
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'SOL_DRAINED':
      logTerminal(`🧹 [Drain] Reclaimed ${msg.payload.drainedSol} SOL to Master Dev wallet.`);
      showToast(`Drained ${msg.payload.drainedSol} SOL to Master`, 'success');
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'BUMPER_STARTED':
      paintBumper(msg.payload || {}, true);
      logTerminal(`[Bump] Started ${msg.payload.simulated ? 'simulation' : 'live'} cycles of ${msg.payload.solAmount} SOL on ${msg.payload.mint}`);
      break;

    case 'BUMPER_STOPPED':
      paintBumper(msg.payload || {}, false);
      logTerminal('[Bump] Stopped');
      break;

    case 'BUMP_TICK':
      paintBumper(msg.payload || {}, true);
      logBumpTick(msg.payload || {});
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'TOKEN_TRACKED':
      state.activeToken = msg.payload.mint;
      updateActiveTokenUi(msg.payload.mint);
      loadLiveStats();
      break;

    case 'HOLDINGS_SEEDED':
      if (!msg.payload || !msg.payload.mint || msg.payload.mint === state.activeToken) loadLiveStats();
      break;

    case 'PUBLIC_TRADE':
      renderTradeTick(msg.payload);
      break;

    case 'BALANCE_UPDATE':
      applyLiveSolUpdate(msg.payload || {});
      break;

    case 'TOKEN_BALANCE_UPDATE':
      applyLiveTokenUpdate(msg.payload || {});
      break;

    case 'PNL_UPDATE':
      applyPnlUpdate(msg.payload || {});
      break;

    case 'CURVE_PROGRESS':
      paintCurve(msg.payload || {});
      break;

    case 'FEED_STATUS':
      if (msg.payload && (msg.payload.channel === 'chart' || msg.payload.channel === 'pumpportal')) {
        applyChartFeedStatus(msg.payload);
        break;
      }
      state.feedConnected = Boolean(msg.payload && msg.payload.connected);
      state.feedSubscribed = msg.payload ? msg.payload.subscribed : 0;
      renderFeedStatus();
      break;
  }
}

const uiQueue = [];
let uiFrame = 0;
let uiLastFlush = 0;

function queueUi(fn) {
  uiQueue.push(fn);
  if (uiFrame) return;
  const pump = () => {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - uiLastFlush < 100) {
      uiFrame = requestAnimationFrame(pump);
      return;
    }
    uiLastFlush = now;
    uiFrame = 0;
    const batch = uiQueue.splice(0, uiQueue.length);
    batch.forEach(run => {
      try { run(); } catch (err) { console.error(err); }
    });
  };
  uiFrame = requestAnimationFrame(pump);
}

function touchLiveStamp() {
  state.lastLiveBalanceAt = Date.now();
  renderFeedStatus();
}

function walletRow(address) {
  if (state.masterWallet && state.masterWallet.address === address) return state.masterWallet;
  return (state.subWallets || []).find(row => row.address === address) || null;
}

function applyLiveSolUpdate(payload) {
  const row = walletRow(payload.address);
  if (row) {
    row.liveBalance = payload.liveBalance;
    row.liveError = null;
    if (!state.simulationMode) row.balance = payload.liveBalance;
  }
  touchLiveStamp();
  queueUi(() => {
    renderStoredBalances();
    document.querySelectorAll(`[data-wallet="${payload.address}"] .sol-dual`).forEach(el => {
      const current = walletRow(payload.address);
      if (current) renderDualBalance(el, current);
    });
  });
}

function applyLiveTokenUpdate(payload) {
  if (payload.mint && state.activeToken && payload.mint !== state.activeToken) return;
  if (state.chartToken && payload.mint && payload.mint !== state.chartToken && payload.mint !== state.activeToken) return;
  const row = walletRow(payload.address);
  if (row) row.tokens = payload.tokenAmount;
  touchLiveStamp();
  queueUi(() => {
    const cell = document.querySelector(`[data-wallet="${payload.address}"] .token-amt`);
    if (cell) cell.textContent = String(Number(payload.tokenAmount) || 0);
  });
}

function applyPnlUpdate(payload) {
  if (state.simulationMode) return;
  if (payload.mint && state.activeToken && payload.mint !== state.activeToken) return;
  queueUi(() => paintPnl(payload));
}

function paintPnl(payload) {
  (payload.wallets || []).forEach(row => {
    const tr = document.querySelector(`[data-wallet="${row.address}"]`);
    if (!tr) return;
    const pnl = tr.querySelector('.pnl-amt');
    const cost = tr.querySelector('.cost-amt');
    const value = tr.querySelector('.value-amt');
    const tokens = tr.querySelector('.token-amt');
    if (tokens && row.tokens != null) tokens.textContent = Number(row.tokens).toLocaleString();
    if (value && row.valueSol != null) value.textContent = Number(row.valueSol).toFixed(3);
    if (cost) cost.textContent = row.costBasisSol == null ? '—' : Number(row.costBasisSol).toFixed(3);
    if (pnl) {
      if (row.pnlSol == null || row.costKnown === false) {
        pnl.textContent = '—';
        pnl.className = 'pnl-amt text-[10px] font-mono text-slate-500';
      } else {
        const sign = row.pnlSol >= 0 ? '+' : '';
        pnl.textContent = `${row.pnlSol >= 0 ? '▲' : '▼'} ${sign}${Number(row.pnlSol).toFixed(3)} (${sign}${Number(row.pnlPct || 0).toFixed(1)}%)`;
        pnl.className = `pnl-amt text-[10px] font-mono ${row.pnlSol >= 0 ? 'badge-pnl-green' : 'badge-pnl-red'}`;
      }
    }
  });
  const total = payload.total;
  if (!total) return;
  const valueDisplay = document.getElementById('deskSolValueDisplay');
  if (valueDisplay && total.valueSol != null) valueDisplay.textContent = `${Number(total.valueSol).toFixed(4)} SOL`;
  const invested = document.getElementById('deskInvestedDisplay');
  if (invested) invested.textContent = total.costBasisSol == null ? '—' : `${Number(total.costBasisSol).toFixed(4)} SOL`;
  const pnlDisplay = document.getElementById('deskPnlDisplay');
  if (!pnlDisplay) return;
  if (total.pnlSol == null) {
    pnlDisplay.textContent = '—';
    pnlDisplay.className = 'text-2xl font-mono font-extrabold text-slate-400';
    return;
  }
  const sign = total.pnlSol >= 0 ? '+' : '';
  pnlDisplay.textContent = `${sign}${Number(total.pnlSol).toFixed(4)} SOL (${sign}${Number(total.pnlPct || 0).toFixed(2)}%)`;
  pnlDisplay.className = total.pnlSol >= 0
    ? 'text-2xl font-mono font-extrabold text-emerald-400'
    : 'text-2xl font-mono font-extrabold text-rose-400';
}

function applyChartFeedStatus(payload) {
  if (payload.channel === 'pumpportal' && payload.message) {
    logTerminal(`[PumpPortal] ${payload.message}`);
    const el = document.getElementById('chartSourceDisplay');
    if (el) el.title = payload.message;
    return;
  }
  state.chartFeedConnected = payload.connected !== false;
  state.chartFeedLabel = payload.label || 'Helius bonding curve';
  paintChartFeed();
}

function paintChartFeed() {
  if (state.simulationMode) return;
  const ageSec = state.lastChartTickAt ? Math.round((Date.now() - state.lastChartTickAt) / 1000) : null;
  const stale = !state.chartFeedConnected && (ageSec == null || ageSec > 10);
  const label = state.chartFeedLabel || 'Helius bonding curve';
  setChartSource(stale ? `feed: ${label} · stale` : `feed: ${label} · live`);
}

function renderFeedStatus() {
  const el = document.getElementById('balanceFeedStatus');
  if (!el) return;
  if (state.simulationMode) {
    el.textContent = 'sim · polled';
    el.style.color = '#78909c';
    el.title = 'Simulation uses the ledger immediately. On-chain LIVE balances refresh on a timer, not a socket.';
    return;
  }
  const ageSec = state.lastLiveBalanceAt ? Math.round((Date.now() - state.lastLiveBalanceAt) / 1000) : null;
  const ageText = ageSec == null ? 'no update yet' : `${ageSec}s ago`;
  const disconnected = !state.feedConnected || !state.appWsOpen;
  if (disconnected && (ageSec == null || ageSec > 10)) {
    el.textContent = `stale · feed disconnected · ${ageText}`;
    el.style.color = '#f04c5e';
    el.title = 'No live balance update for more than 10 seconds while the feed is disconnected.';
    return;
  }
  el.textContent = `live · ${ageText}`;
  el.style.color = '#00c48c';
  el.title = `Account socket connected (${state.feedSubscribed || 0} subscriptions).`;
}

// ==================== ULTRA-FAST CANDLESTICK CHART (DOWN TO 1s / 5s) ====================

const TIMEFRAME_MS = {
  '1s': 1000,
  '5s': 5000,
  '15s': 15000,
  '30s': 30000,
  '1m': 60000,
  '5m': 300000
};

const chartBook = ChartBook.createBook();

function applySeriesView(series) {
  if (!series) return;
  state.chartSamples = series.samples;
  state.chartSampleMs = series.sampleMs;
  if (Number.isFinite(series.lastPrice) && series.lastPrice > 0) state.lastPrice = series.lastPrice;
  else if (!series.samples || series.samples.length === 0) state.lastPrice = null;
}

function applyReportedFill(payload, volume) {
  const price = ChartBook.reportedFillPrice(payload);
  if (!(price > 0) || !payload || !payload.mint) return;
  const epoch = payload.mint === state.chartToken ? state.chartEpoch : null;
  pushChartTick(price, volume || 0, epoch, payload.mint);
}

function initChart() {
  generateInitialCandles();
  renderCandlestickChart();
  renderGauge(state.curveProgressPct);
  renderSparkline();
  renderDonutChart(state.allocation.dev, state.allocation.sub, state.allocation.curve);

  // Resize listener
  window.addEventListener('resize', () => {
    renderCandlestickChart();
    renderGauge(state.curveProgressPct);
    renderSparkline();
    renderDonutChart(state.allocation.dev, state.allocation.sub, state.allocation.curve);
  });

  // Crosshair mouse tracking
  const canvas = document.getElementById('candlestickCanvas');
  if (canvas) {
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      handleChartHover(x);
    });
    canvas.addEventListener('mouseleave', () => {
      state.hoverCandle = null;
      renderCandlestickChart();
    });
  }
}

function setChartTimeframe(tf) {
  if (!TIMEFRAME_MS[tf] || tf === state.chartTimeframe) return;
  state.chartTimeframe = tf;
  document.querySelectorAll('.chart-tf-btn').forEach(btn => {
    btn.classList.remove('active', 'text-cyan-400', 'bg-[#1e2a42]');
    btn.classList.add('text-slate-400');
  });

  const activeBtn = document.getElementById(`tfBtn-${tf}`);
  if (activeBtn) {
    activeBtn.classList.add('active', 'text-cyan-400', 'bg-[#1e2a42]');
    activeBtn.classList.remove('text-slate-400');
  }

  // Regroup bars already stored. Fetch only when the click asks for a finer
  // width than we have (for example 5m history, then 1s). Do not clear first.
  const targetMs = TIMEFRAME_MS[tf];
  const haveMs = state.chartSampleMs || Infinity;
  if (state.chartToken && targetMs < haveMs) {
    loadCandlesForToken(state.chartToken, { clear: false });
  } else if (state.chartSamples && state.chartSamples.length) {
    rebuildDisplayCandles();
    updateChartHeaders();
    renderCandlestickChart();
    renderSparkline();
  } else if (!state.chartToken) {
    generateInitialCandles();
    renderCandlestickChart();
  }
  showToast(`Chart timeframe set to ${tf}`, 'info');
}

function activeChartSeries() {
  return state.chartToken ? chartBook.peek(state.chartToken) : null;
}

function formatChartMarketCap(price, withUsd) {
  const series = activeChartSeries();
  const mcap = ChartScale.marketCapSol(price, ChartScale.supplyOf(series));
  if (withUsd) return ChartScale.formatMarketCapLabel(mcap, ChartScale.solUsdOf(series));
  return ChartScale.formatMarketCapSol(mcap);
}

function noteChartScale(mint, trade) {
  if (!mint || !trade) return;
  const price = Number(trade.priceSol);
  const mcap = Number(trade.marketCapSol);
  const patch = {};
  if (price > 0 && mcap > 0) patch.supplyUi = mcap / price;
  if (Number(trade.solUsd) > 0) patch.solUsd = Number(trade.solUsd);
  if (Number(trade.supplyUi) > 0) {
    patch.supplyUi = Number(trade.supplyUi);
    patch.source = trade.supplySource || 'mint';
  }
  if (patch.supplyUi || patch.solUsd) chartBook.noteScale(mint, patch);
}

function clearLiveTradeTape() {
  const chartBar = document.getElementById('chartLiveTradesBar');
  if (chartBar) {
    chartBar.innerHTML = '<span style="color:#546e7a;font-size:10px;">Streaming live trades from Solana &amp; Pump.fun...</span>';
  }
  const tapePanel = document.getElementById('txTapePanel');
  if (tapePanel) {
    tapePanel.innerHTML = '<div style="font-size:11px;color:#546e7a;text-align:center;padding:14px 0;">No transactions yet</div>';
  }
}

function setChartSymbol(symbol) {
  const el = document.getElementById('chartSymbolDisplay');
  if (el && symbol) el.innerText = symbol;
}

function setChartSource(source) {
  const el = document.getElementById('chartSourceDisplay');
  if (!el) return;
  el.textContent = source ? source : '';
}

let chartLoadSeq = 0;

function bindActiveSeries(series) {
  applySeriesView(series);
  state.hoverCandle = null;
  setChartSource(series && series.source ? series.source : '');
  if (series && series.symbol) setChartSymbol(series.symbol);
  rebuildDisplayCandles();
  updateChartHeaders();
  renderCandlestickChart();
  renderSparkline();
}

async function loadCandlesForToken(mint, options = {}) {
  if (!mint) return;
  const clear = options.clear !== false;
  const seq = ++chartLoadSeq;
  const requestedTf = state.chartTimeframe;
  if (clear) {
    const view = chartBook.activate(mint);
    state.chartEpoch = view.epoch;
    state.chartToken = mint;
    if (!view.series.symbol) setChartSymbol(mint.slice(0, 4).toUpperCase());
    bindActiveSeries(view.series);
    renderTradeTape(view.series.trades);
  }

  try {
    const res = await apiFetch(`/api/chart/candles?mint=${encodeURIComponent(mint)}&tf=${encodeURIComponent(requestedTf)}`);
    const data = await res.json();
    if (seq !== chartLoadSeq || state.chartToken !== mint) return;
    if (!res.ok) throw new Error(data.error || 'Candle request failed');
    const candles = Array.isArray(data.candles) ? data.candles : [];
    if (candles.length === 0) {
      chartBook.replaceSeries(mint, {
        samples: [],
        sampleMs: TIMEFRAME_MS[requestedTf] || 5000,
        lastPrice: null,
        source: 'empty',
        symbol: data.symbol || null
      });
      if (data.symbol) setChartSymbol(data.symbol);
    } else chartBook.replaceSeries(mint, {
      samples: candles.map(copyChartSample),
      sampleMs: TIMEFRAME_MS[data.servedRes] || TIMEFRAME_MS[requestedTf] || 60000,
      lastPrice: candles[candles.length - 1].close,
      source: data.source || '',
      symbol: data.symbol || null,
      supplyUi: Number(data.supplyUi) > 0 ? Number(data.supplyUi) : null,
      supplySource: data.supplySource || null,
      solUsd: Number(data.solUsd) > 0 ? Number(data.solUsd) : null
    });
    if (data.symbol) setChartSymbol(data.symbol);
  } catch (err) {
    if (seq !== chartLoadSeq || state.chartToken !== mint) return;
    if (!clear) {
      rebuildDisplayCandles();
      updateChartHeaders();
      renderCandlestickChart();
      renderSparkline();
      return;
    }
    chartBook.replaceSeries(mint, {
      samples: [],
      sampleMs: TIMEFRAME_MS[requestedTf] || 5000,
      lastPrice: null,
      source: 'empty'
    });
    state.lastPrice = null;
  }
  if (seq !== chartLoadSeq || state.chartToken !== mint) return;
  bindActiveSeries(chartBook.peek(mint));
}

const MAX_CHART_SAMPLES = 5000;
const MAX_CHART_BARS = 180;

function copyChartSample(sample) {
  return {
    time: Number(sample.time),
    open: Number(sample.open),
    high: Number(sample.high),
    low: Number(sample.low),
    close: Number(sample.close),
    volume: Number(sample.volume) || 0
  };
}

function appendChartSample(sample) {
  if (!Array.isArray(state.chartSamples)) state.chartSamples = [];
  state.chartSamples.push(sample);
  if (state.chartSamples.length > MAX_CHART_SAMPLES) {
    state.chartSamples.splice(0, state.chartSamples.length - MAX_CHART_SAMPLES);
  }
}

// Group stored samples into the selected timeframe. Finer switches keep each
// existing bar; coarser switches merge them. Nothing is discarded or refetched.
function aggregateChartSamples(samples, tfMs) {
  const buckets = [];
  const index = new Map();
  for (const sample of samples) {
    const time = Number(sample.time);
    const close = Number(sample.close);
    if (!Number.isFinite(time) || !Number.isFinite(close)) continue;
    const bucketTime = Math.floor(time / tfMs) * tfMs;
    let bucket = index.get(bucketTime);
    if (!bucket) {
      const open = Number(sample.open);
      const high = Number(sample.high);
      const low = Number(sample.low);
      bucket = {
        time: bucketTime,
        open: Number.isFinite(open) ? open : close,
        high: Number.isFinite(high) ? high : close,
        low: Number.isFinite(low) ? low : close,
        close,
        volume: Number(sample.volume) || 0
      };
      index.set(bucketTime, bucket);
      buckets.push(bucket);
    } else {
      const high = Number(sample.high);
      const low = Number(sample.low);
      if (Number.isFinite(high)) bucket.high = Math.max(bucket.high, high);
      if (Number.isFinite(low)) bucket.low = Math.min(bucket.low, low);
      bucket.close = close;
      bucket.volume += Number(sample.volume) || 0;
    }
  }
  return buckets;
}

function rebuildDisplayCandles() {
  const tfMs = TIMEFRAME_MS[state.chartTimeframe] || 5000;
  const candles = aggregateChartSamples(state.chartSamples || [], tfMs);
  state.candles = candles.length > MAX_CHART_BARS ? candles.slice(-MAX_CHART_BARS) : candles;
  state.currentCandle = state.candles.length ? state.candles[state.candles.length - 1] : null;
  if (state.currentCandle && Number.isFinite(state.currentCandle.close)) {
    state.lastPrice = state.currentCandle.close;
  }
}

function generateInitialCandles() {
  state.chartSamples = [];
  state.candles = [];
  state.currentCandle = null;
  state.lastPrice = null;
  updateChartHeaders();
}

function pushChartTick(price, volume = 0.1, expectedEpoch = null, mint = null) {
  if (!Number.isFinite(price) || price <= 0) return;
  // Placeholder heartbeats have no mint. Once a coin is loaded they must not
  // land on it, and the loaded series is what the chart draws.
  if (!mint) {
    if (state.chartToken) return;
    if (expectedEpoch != null && expectedEpoch !== state.chartEpoch) return;
    return;
  }
  if (mint === state.chartToken && expectedEpoch != null && expectedEpoch !== state.chartEpoch) return;
  const visible = chartBook.appendSample(mint, {
    time: Date.now(),
    open: price,
    high: price,
    low: price,
    close: price,
    volume: volume || 0
  });
  if (!visible) return;
  state.lastPrice = price;
  applySeriesView(chartBook.peek(mint));
  rebuildDisplayCandles();
  updateChartHeaders();
  renderCandlestickChart();
  renderSparkline();
}

function updateChartHeaders() {
  const pDisplay = document.getElementById('chartPriceDisplay');
  const cDisplay = document.getElementById('chartChangeDisplay');
  if (pDisplay) pDisplay.innerText = Number(state.lastPrice) > 0 ? formatChartMarketCap(state.lastPrice, true) : '—';

  if (state.candles.length > 1) {
    const first = state.candles[0].open;
    const changePct = ((state.lastPrice - first) / first) * 100;
    const prefix = changePct >= 0 ? '+' : '';
    if (cDisplay) {
      cDisplay.innerText = `${prefix}${changePct.toFixed(1)}%`;
      cDisplay.className = changePct >= 0
        ? 'text-[10px] px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-300 font-mono font-bold'
        : 'text-[10px] px-1.5 py-0.2 rounded bg-rose-950 text-rose-300 font-mono font-bold';
    }
  }

  const vol = state.candles.reduce((acc, c) => acc + c.volume, 0);
  const volEl = document.getElementById('chartVolDisplay');
  if (volEl) volEl.innerText = `${vol.toFixed(1)} SOL`;
}

function handleChartHover(mouseX) {
  const canvas = document.getElementById('candlestickCanvas');
  if (!canvas || state.candles.length === 0) return;
  const width = canvas.width / (window.devicePixelRatio || 1);
  const chartWidth = width - 60; // right padding for price scale
  const candleSlot = chartWidth / state.candles.length;
  const idx = Math.floor(mouseX / candleSlot);
  if (idx >= 0 && idx < state.candles.length) {
    state.hoverCandle = state.candles[idx];
  } else {
    state.hoverCandle = null;
  }
  renderCandlestickChart();
}

function renderCandlestickChart() {
  const canvas = document.getElementById('candlestickCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const chartRight = w - 92;
  const volHeight = 35;
  const priceHeight = h - volHeight - 20;

  // Background
  ctx.fillStyle = '#090d16';
  ctx.fillRect(0, 0, w, h);

  if (state.candles.length === 0) return;

  // Find min/max price and max volume
  let minP = Infinity;
  let maxP = -Infinity;
  let maxV = 0.001;

  state.candles.forEach(c => {
    if (c.low < minP) minP = c.low;
    if (c.high > maxP) maxP = c.high;
    if (c.volume > maxV) maxV = c.volume;
  });

  const pRange = (maxP - minP) || 0.000001;
  minP -= pRange * 0.08;
  maxP += pRange * 0.08;
  const effectiveRange = maxP - minP;

  // Horizontal Grid Lines & Price Labels
  ctx.strokeStyle = '#141c2c';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '10px JetBrains Mono, monospace';

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const y = 15 + (priceHeight / gridSteps) * i;
    const pVal = maxP - (effectiveRange / gridSteps) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(chartRight, y);
    ctx.stroke();
    ctx.fillText(formatChartMarketCap(pVal, false), chartRight + 6, y + 3);
  }

  const slotW = chartRight / state.candles.length;
  const candleW = Math.max(3, slotW * 0.65);

  // Draw Candlesticks & Volume Bars
  const maPoints = [];
  let maSum = 0;
  const maPeriod = 5;

  state.candles.forEach((c, i) => {
    const cx = i * slotW + (slotW / 2);
    const isUp = c.close >= c.open;
    const candleColor = isUp ? '#10b981' : '#ef4444';

    // Volume bar
    const vH = (c.volume / maxV) * volHeight;
    const vy = h - vH - 5;
    ctx.fillStyle = isUp ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)';
    ctx.fillRect(cx - (candleW / 2), vy, candleW, vH);

    // Candle Wick
    const yh = 15 + ((maxP - c.high) / effectiveRange) * priceHeight;
    const yl = 15 + ((maxP - c.low) / effectiveRange) * priceHeight;
    ctx.strokeStyle = candleColor;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, yh);
    ctx.lineTo(cx, yl);
    ctx.stroke();

    // Candle Body
    const yo = 15 + ((maxP - c.open) / effectiveRange) * priceHeight;
    const yc = 15 + ((maxP - c.close) / effectiveRange) * priceHeight;
    const topY = Math.min(yo, yc);
    const bodyH = Math.max(2, Math.abs(yc - yo));

    ctx.fillStyle = candleColor;
    ctx.fillRect(cx - (candleW / 2), topY, candleW, bodyH);

    // Moving average accumulation
    maSum += c.close;
    if (i >= maPeriod) maSum -= state.candles[i - maPeriod].close;
    const curMa = maSum / Math.min(i + 1, maPeriod);
    const maY = 15 + ((maxP - curMa) / effectiveRange) * priceHeight;
    maPoints.push({ x: cx, y: maY });
  });

  // Draw 5-period MA curve in glowing gold
  if (maPoints.length > 1) {
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(maPoints[0].x, maPoints[0].y);
    for (let k = 1; k < maPoints.length; k++) {
      ctx.lineTo(maPoints[k].x, maPoints[k].y);
    }
    ctx.stroke();
  }

  // Draw Current Price Dashed Line & Badge
  const curY = 15 + ((maxP - state.lastPrice) / effectiveRange) * priceHeight;
  ctx.strokeStyle = 'rgba(6, 182, 212, 0.7)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, curY);
  ctx.lineTo(chartRight, curY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Price badge on right axis
  ctx.fillStyle = '#06b6d4';
  ctx.fillRect(chartRight + 2, curY - 8, 86, 16);
  ctx.fillStyle = '#0a0d14';
  ctx.font = 'bold 9px JetBrains Mono';
  ctx.fillText(formatChartMarketCap(state.lastPrice, false), chartRight + 4, curY + 4);

  drawTradeMarkers(ctx, {
    candles: state.candles,
    slotW,
    maxP,
    effectiveRange,
    priceHeight
  });

  // Hover Tooltip / Crosshair
  if (state.hoverCandle) {
    const hc = state.hoverCandle;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.fillRect(10, 8, 320, 24);
    ctx.strokeRect(10, 8, 320, 24);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '9px JetBrains Mono';
    ctx.fillText(ChartScale.formatOhlc(hc, ChartScale.supplyOf(activeChartSeries())), 14, 23);
  }
}

// ==================== RADIAL SPEEDOMETER GAUGE (SENTIMENT / BONDING) ====================

function paintCurve(payload) {
  const pct = Number(payload.progressPct);
  const complete = Boolean(payload.complete);
  if (Number.isFinite(pct)) {
    state.curveProgressPct = pct;
    renderGauge(pct, complete);
  }
  const label = document.getElementById('migrationTargetLabel');
  if (!label) return;
  const sol = Number(payload.realSol);
  const solText = Number.isFinite(sol) ? `${sol.toFixed(2)} SOL` : '— SOL';
  if (complete) {
    label.textContent = Number.isFinite(sol) && sol > 0
      ? `Graduated · ${solText} in pool → PumpSwap`
      : 'Graduated → PumpSwap';
  } else {
    label.textContent = Number.isFinite(sol)
      ? `${solText} in curve → PumpSwap`
      : 'Bonding curve → PumpSwap';
  }
}

function renderGauge(percentage = 0, complete = false) {
  const canvas = document.getElementById('gaugeCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const cx = rect.width / 2;
  const cy = rect.height * 0.88;
  const r = Math.min(cx - 15, cy - 15);
  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;

  ctx.clearRect(0, 0, rect.width, rect.height);

  // Background Track Arc
  ctx.lineWidth = 11;
  ctx.strokeStyle = '#182236';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.stroke();

  // Value Arc with Gradient (Red -> Orange -> Yellow -> Green)
  const effectivePct = Math.min(100, Math.max(0, Number(percentage) || 0));
  const pct = effectivePct / 100;
  const currentAngle = startAngle + (pct * Math.PI);

  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, '#f43f5e');
  grad.addColorStop(0.35, '#f59e0b');
  grad.addColorStop(0.7, '#10b981');
  grad.addColorStop(1, '#06b6d4');

  ctx.strokeStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, currentAngle);
  ctx.stroke();

  // Needle pointer (in soft slate-gray, no harsh pure white)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(currentAngle);
  ctx.fillStyle = '#cbd5e1';
  ctx.beginPath();
  ctx.moveTo(r - 18, 0);
  ctx.lineTo(r + 6, 0);
  ctx.lineTo(r - 18, 2.5);
  ctx.fill();
  ctx.restore();

  // Center pivot pin
  ctx.fillStyle = '#38bdf8';
  ctx.beginPath();
  ctx.arc(cx, cy, 3.5, 0, 2 * Math.PI);
  ctx.fill();

  // Update text label
  const valEl = document.getElementById('gaugeValueText');
  const pillEl = document.getElementById('curveSentimentPill');
  if (valEl) valEl.innerText = `${effectivePct.toFixed(0)}%`;
  const caption = document.getElementById('gaugeCaption');
  if (caption) caption.textContent = complete ? 'Graduated' : 'Bonding';
  if (pillEl) {
    if (complete) {
      pillEl.innerText = 'GRADUATED → PUMPSWAP';
      pillEl.className = 'text-[10px] font-bold text-cyan-300 font-mono';
    } else if (effectivePct > 70) {
      pillEl.innerText = `${effectivePct.toFixed(0)}% BULLISH ▲`;
      pillEl.className = 'text-[10px] font-bold text-emerald-400 font-mono';
    } else if (effectivePct > 30) {
      pillEl.innerText = `${effectivePct.toFixed(0)}% WARMING`;
      pillEl.className = 'text-[10px] font-bold text-amber-400 font-mono';
    } else {
      pillEl.innerText = `${effectivePct.toFixed(0)}% BONDING`;
      pillEl.className = 'text-[10px] font-bold text-[#94a3b8] font-mono';
    }
  }
}

// ==================== MINI SPARKLINE & DONUT CHARTS ====================

function renderSparkline() {
  const canvas = document.getElementById('sparklineCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.scale(dpr, dpr);

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  if (state.candles.length < 2) return;
  const prices = state.candles.slice(-25).map(c => c.close);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = (max - min) || 0.000001;

  const step = w / (prices.length - 1);
  ctx.strokeStyle = prices[prices.length - 1] >= prices[0] ? '#10b981' : '#ef4444';
  ctx.lineWidth = 1.8;
  ctx.beginPath();

  prices.forEach((p, i) => {
    const x = i * step;
    const y = h - 6 - (((p - min) / range) * (h - 12));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function paintHoldingAllocation(wallets) {
  const supply = 1_000_000_000;
  let dev = 0;
  let subs = 0;
  (wallets || []).forEach(row => {
    const tokens = Number(row.tokens) || 0;
    if (String(row.role || '').indexOf('Master') === 0) dev += tokens;
    else subs += tokens;
  });
  const devPct = (dev / supply) * 100;
  const subPct = (subs / supply) * 100;
  state.allocation = { dev: devPct, sub: subPct, curve: Math.max(0, 100 - devPct - subPct) };
  renderDonutChart(state.allocation.dev, state.allocation.sub, state.allocation.curve);
}

function renderDonutChart(devPct = 0, subPct = 0, curvePct = 100) {
  const canvas = document.getElementById('donutCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  canvas.width = 130 * dpr;
  canvas.height = 130 * dpr;
  ctx.scale(dpr, dpr);

  const cx = 65;
  const cy = 65;
  const r = 50;
  const innerR = 34;

  ctx.clearRect(0, 0, 130, 130);

  const slices = [
    { pct: devPct / 100, color: '#06b6d4' },
    { pct: subPct / 100, color: '#6366f1' },
    { pct: curvePct / 100, color: '#10b981' }
  ];

  let currentAngle = -Math.PI / 2;
  slices.forEach(s => {
    const sliceAngle = s.pct * 2 * Math.PI;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, currentAngle, currentAngle + sliceAngle);
    ctx.arc(cx, cy, innerR, currentAngle + sliceAngle, currentAngle, true);
    ctx.closePath();
    ctx.fill();
    currentAngle += sliceAngle;
  });

  const devEl = document.getElementById('donutDevPct');
  const subEl = document.getElementById('donutSubPct');
  const curveEl = document.getElementById('donutCurvePct');
  if (devEl) devEl.innerText = `${devPct.toFixed(1)}%`;
  if (subEl) subEl.innerText = `${subPct.toFixed(1)}%`;
  if (curveEl) curveEl.innerText = `${curvePct.toFixed(1)}%`;
}

// ==================== WORKSTATION NAVIGATION & TABS ====================

function switchTab(tabId) {
  state.currentTab = tabId;
  document.querySelectorAll('.tab-pane').forEach(el => {
    el.classList.add('hidden');
    el.style.display = 'none';
  });
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active', 'text-cyan-400', 'bg-[#131b2c]');
    btn.classList.add('text-[#94a3b8]');
  });

  const pane = document.getElementById(`tabContent-${tabId}`);
  const btn = document.getElementById(`tabBtn-${tabId}`);

  if (pane) {
    pane.classList.remove('hidden');
    pane.style.display = 'flex';
  }
  if (btn) {
    btn.classList.add('active');
  }

  if (tabId === 'trading') {
    setTimeout(() => {
      renderCandlestickChart();
      renderGauge(state.curveProgressPct);
      renderSparkline();
      renderDonutChart();
      renderTopMovers();
    }, 50);
  } else if (tabId === 'wallets') {
    loadMasterWallet();
    loadSubWallets();
  } else if (tabId === 'vamp') {
    loadTrendingVampTokens();
  } else if (tabId === 'launchpad') {
    paintLaunchDraft();
  }

  if (window.lucide) {
    setTimeout(() => lucide.createIcons(), 10);
  }
}

function paintRpcStatus(rpc) {
  const el = document.getElementById('rpcStatusDisplay');
  const banner = document.getElementById('publicRpcBanner');
  if (el && rpc && rpc.active) {
    const row = (rpc.providers || []).find(item => item.name === rpc.active);
    const healthy = !row || row.healthy !== false;
    el.textContent = `${rpc.active} · ${healthy ? 'healthy' : 'unhealthy'}`;
    el.style.color = healthy ? '#86efac' : '#fda4af';
  }
  if (banner) banner.style.display = rpc && rpc.paused ? 'block' : 'none';
  paintSidebarRpc(rpc);
}

function paintSidebarRpc(rpc) {
  if (!rpc) return;
  const name = rpc.active || 'Public';
  const colors = { Helius: '#00c48c', QuickNode: '#00d4ff', Alchemy: '#3b82f6', Public: '#f04c5e' };
  const color = colors[name] || '#94a3b8';
  const label = document.getElementById('sidebarRpcName');
  const dot = document.getElementById('sidebarRpcDot');
  const note = document.getElementById('sidebarRpcNote');
  if (dot) dot.style.background = color;
  if (label) {
    label.style.color = color;
    const text = label.childNodes[label.childNodes.length - 1];
    if (text && text.nodeType === 3) text.nodeValue = name.toUpperCase();
    else label.appendChild(document.createTextNode(name.toUpperCase()));
  }
  if (note) {
    const paused = name === 'Public' || rpc.paused;
    const socket = rpc.ws && typeof rpc.ws === 'object'
      ? (rpc.ws.mode === 'socket' && rpc.ws.provider ? rpc.ws.provider : 'polling')
      : (rpc.ws || 'polling');
    const account = paused ? 'live paused' : (rpc.account || name);
    const usage = (rpc.providers || []).find(row => row.name === name);
    const used = usage && usage.callsToday != null && usage.dailyBudget
      ? ` · ${usage.callsToday}/${usage.dailyBudget} today`
      : (usage && usage.callsToday ? ` · ${usage.callsToday} today` : '');
    note.textContent = `${account}${used} · WS ${socket}`;
    note.style.color = paused ? '#f04c5e' : '#78909c';
  }
}

async function loadStatus() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    noteSimulationMode(simulationModeFromUpdate(data));
    if (data.currentSlot) {
      document.getElementById('slotDisplay').innerText = `Slot: ${data.currentSlot.toLocaleString()}`;
    }
    if (data.limits && Number(data.limits.maxJitoTipSol) > 0) state.maxJitoTipSol = Number(data.limits.maxJitoTipSol);
    if (data.rpc) paintRpcStatus(data.rpc);
    const rpcRes = await apiFetch('/api/rpc/status');
    if (rpcRes.ok) paintRpcStatus(await rpcRes.json());
  } catch (err) {
    console.error('Failed to load status:', err);
  }
}

async function toggleSimulation(enable) {
  const simulationOn = enable === true;
  if (!simulationOn) {
    const accepted = window.confirm('Switch to live mode? Real SOL will be spent on mainnet. This is not saved: a restart returns to simulation. Create fresh wallets first. The published master FLAgPA3VzRhAC8auZAoS4FNeqah4vKuf5CEL49i2SMcy and its sub-wallets are leaked and must never be funded.');
    if (!accepted) return;
  }
  try {
    const res = await apiFetch('/api/settings/simulation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: simulationOn, confirm: !simulationOn })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Mode change refused', 'error');
      return;
    }
    noteSimulationMode(simulationModeFromUpdate(data));
    loadMasterWallet();
    loadSubWallets();
    loadLiveStats();
    showToast(`Switched to ${simulationOn ? 'SIMULATION MODE' : 'LIVE MAINNET'}`, simulationOn ? 'info' : 'warning');
  } catch (e) {
    showToast('Failed to toggle mode: ' + e.message, 'error');
  }
}

function paintModeButton(button, style) {
  if (!button || !style) return;
  button.style.background = style.background;
  button.style.color = style.color;
  button.style.border = style.border;
  button.setAttribute('aria-pressed', style.pressed ? 'true' : 'false');
}

function noteSimulationMode(value) {
  if (value !== true && value !== false) return;
  state.simulationMode = value;
  updateSimulationUi(value);
}

function updateSimulationUi(isSim) {
  const styles = simulationSwitchStyles(isSim);
  paintModeButton(document.getElementById('modeSimBtn'), styles.sim);
  paintModeButton(document.getElementById('modeLiveBtn'), styles.live);
  const badge = document.getElementById('liveModeBadge');
  if (badge) {
    badge.style.display = styles.badge.display;
    badge.style.background = styles.badge.background;
    badge.style.color = styles.badge.color;
    badge.style.border = styles.badge.border;
    badge.textContent = styles.badge.text;
  }
  const simBanner = document.getElementById('simBanner');
  if (simBanner) simBanner.style.display = styles.simBanner;
  const liveBanner = document.getElementById('liveBanner');
  if (liveBanner) liveBanner.style.display = styles.liveBanner;
  if (document.body) document.body.dataset.tradingMode = isSim === false ? 'live' : 'sim';
  if (typeof renderStoredBalances === 'function') renderStoredBalances();
  if (typeof renderFeedStatus === 'function') renderFeedStatus();
}

// ==================== MANUAL TRADING ENGINE (BUY GREEN / SELL RED) ====================

function setManualBuyAmount(amt) {
  document.getElementById('manualBuySolInput').value = amt;
}

function setManualSellPct(pct) {
  document.getElementById('manualSellPctInput').value = pct;
}

function getTargetAddresses(targetMode) {
  if (targetMode === 'dev') {
    return state.masterWallet ? [state.masterWallet.address] : [];
  }
  if (targetMode === 'selected') {
    return Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => cb.value);
  }
  const all = [];
  if (state.masterWallet) all.push(state.masterWallet.address);
  state.subWallets.forEach(w => all.push(w.address));
  return all;
}

function collectSignatures(data, into = []) {
  (data && data.results || []).forEach(row => {
    if (!row) return;
    if (row.txSignature) into.push(row.txSignature);
    if (row.results) collectSignatures(row, into);
  });
  return into;
}

function tradeFailureText(data) {
  if (data && data.error) return String(data.error);
  const lines = [];
  const walk = (rows) => (rows || []).forEach(row => {
    if (!row) return;
    if (row.results) walk(row.results);
    else if (row.status && !/success/i.test(String(row.status))) lines.push(String(row.status));
  });
  walk(data && data.results);
  return lines.join('; ') || 'Trade failed with no error message';
}

async function finishTrade(label, res) {
  const data = await res.json().catch(() => ({}));
  const failed = !res.ok || data.success === false;
  const sigs = collectSignatures(data);
  if (sigs.length) {
    sigs.forEach(sig => logTerminal(`[${label}] Confirmed https://solscan.io/tx/${sig}`));
    showToast(`${label} confirmed. Solscan: https://solscan.io/tx/${sigs[0]}`, 'success');
  }
  if (failed) {
    const message = tradeFailureText(data);
    logTerminal(`[${label}] Failed: ${message}`);
    showToast(`${label} failed: ${message}`, 'error');
  } else if (!sigs.length && data.simulation) {
    logTerminal(`[${label}] Simulated. No chain transaction was sent.`);
    showToast(`${label} simulated`, 'info');
  } else if (!sigs.length) {
    logTerminal(`[${label}] Finished with no transaction signature.`);
    showToast(`${label} finished with no signature`, 'warning');
  }
  if (!failed || sigs.length) {
    loadLiveStats();
    loadMasterWallet();
    loadSubWallets();
  }
  return data;
}

async function executeManualBuy() {
  if (!state.activeToken) {
    return showToast('No active token is currently selected! Launch or track a CA first.', 'warning');
  }

  const solAmount = parseFloat(document.getElementById('manualBuySolInput').value || '0.1');
  const targetMode = document.getElementById('manualBuyTargetSelect').value;
  const walletAddresses = getTargetAddresses(targetMode);

  if (walletAddresses.length === 0) {
    return showToast('No target wallets selected for buy order', 'warning');
  }

  const btn = document.getElementById('btnManualBuy');
  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>BUYING...</span>`;
  logTerminal(`[Buy] Pending ${solAmount} SOL from ${walletAddresses.length} wallet(s)`);
  showToast('Buy pending…', 'info');

  try {
    const res = await apiFetch('/api/trading/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ solAmount, walletAddresses })
    });
    await finishTrade('Buy', res);
  } catch (err) {
    logTerminal(`[Buy] Failed: ${err.message}`);
    showToast(`Buy failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="arrow-up" class="w-4 h-4"></i><span>▲ BUY TOKENS (GREEN UP)</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

async function executeManualSell() {
  if (!state.activeToken) {
    return showToast('No active token is currently selected! Launch or track a CA first.', 'warning');
  }

  const pct = parseFloat(document.getElementById('manualSellPctInput').value || '50');
  const targetMode = document.getElementById('manualSellTargetSelect').value;
  const walletAddresses = getTargetAddresses(targetMode);

  if (walletAddresses.length === 0) {
    return showToast('No target wallets selected for sell order', 'warning');
  }

  const btn = document.getElementById('btnManualSell');
  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>SELLING...</span>`;
  logTerminal(`[Sell] Pending ${pct}% from ${walletAddresses.length} wallet(s)`);
  showToast('Sell pending…', 'info');

  try {
    const res = await apiFetch('/api/trading/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pct, walletAddresses })
    });
    await finishTrade('Sell', res);
  } catch (err) {
    logTerminal(`[Sell] Failed: ${err.message}`);
    showToast(`Sell failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="arrow-down" class="w-4 h-4"></i><span>▼ SELL TOKENS (RED DOWN)</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

async function executeInlineBuy(address, solAmount = 0.1) {
  logTerminal(`[Buy] Pending ${solAmount} SOL for ${address}`);
  showToast(`Buy pending for ${address.slice(0, 6)}…`, 'info');
  try {
    const res = await apiFetch('/api/trading/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ solAmount, walletAddresses: [address] })
    });
    await finishTrade('Buy', res);
  } catch (err) {
    logTerminal(`[Buy] Failed: ${err.message}`);
    showToast('Buy failed: ' + err.message, 'error');
  }
}

async function executeInlineSell(address, pct = 100) {
  logTerminal(`[Sell] Pending ${pct}% from ${address}`);
  showToast(`Sell pending for ${address.slice(0, 6)}…`, 'info');
  try {
    const res = await apiFetch('/api/trading/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pct, walletAddresses: [address] })
    });
    await finishTrade('Sell', res);
  } catch (err) {
    logTerminal(`[Sell] Failed: ${err.message}`);
    showToast('Sell failed: ' + err.message, 'error');
  }
}

async function executeCascadeExit() {
  if (!confirm('CASCADE EXIT: Staggered sell across sub-wallets with delays?')) return;
  logTerminal('[Cascade] Pending staggered sell');
  showToast('Cascade pending…', 'info');
  try {
    const res = await apiFetch('/api/trading/cascade-sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delayMs: 800, pct: 100 })
    });
    await finishTrade('Cascade', res);
  } catch (err) {
    logTerminal(`[Cascade] Failed: ${err.message}`);
    showToast('Cascade failed: ' + err.message, 'error');
  }
}

async function executePanicDumpAll() {
  if (!confirm('PANIC DUMP ALL: Emergency exit 100% of all tokens across all wallets immediately?')) return;
  logTerminal('[Panic] Pending 100% sell');
  showToast('Panic sell pending…', 'warning');
  try {
    const res = await apiFetch('/api/trading/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pct: 100 })
    });
    await finishTrade('Panic', res);
  } catch (err) {
    logTerminal(`[Panic] Failed: ${err.message}`);
    showToast('Panic failed: ' + err.message, 'error');
  }
}

function selectAllTableRows(select) {
  document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = select);
  const masterCb = document.getElementById('checkAllRows');
  if (masterCb) masterCb.checked = select;
  updateSelectedCount();
}

function toggleSelectAllRows(checked) {
  document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = checked);
  updateSelectedCount();
}

function selectWalletsByRole(role) {
  if (role === 'all') {
    selectAllTableRows(true);
  } else if (role === 'none') {
    selectAllTableRows(false);
  } else if (role === 'dev') {
    document.querySelectorAll('.row-checkbox').forEach(cb => {
      cb.checked = (state.masterWallet && cb.value === state.masterWallet.address);
    });
    updateSelectedCount();
  } else if (role === 'subs') {
    document.querySelectorAll('.row-checkbox').forEach(cb => {
      cb.checked = !(state.masterWallet && cb.value === state.masterWallet.address);
    });
    updateSelectedCount();
  }
}

function updateSelectedCount() {
  const count = document.querySelectorAll('.row-checkbox:checked').length;
  const total = document.querySelectorAll('.row-checkbox').length;
  const badge = document.getElementById('matrixSelectedCount');
  if (badge) {
    badge.innerText = `${count}/${total} Selected`;
  }
}

function setMatrixBuyAmount(amt) {
  const el = document.getElementById('matrixBuyAmountInput');
  if (el) el.value = amt;
}

function setMatrixSellPct(pct) {
  const el = document.getElementById('matrixSellPctInput');
  if (el) el.value = pct;
}

function handleDelayInputChange(val) {
  let num = Math.max(0, Math.min(10, parseFloat(val || '0')));
  if (isNaN(num)) num = 0;
  state.subWalletDelaySec = num;

  const mInput = document.getElementById('subWalletBuyDelayInput');
  const lInput = document.getElementById('launchSubDelayInput');
  const mBadge = document.getElementById('subDelayBadge');
  const lBadge = document.getElementById('launchSubDelayBadge');

  if (mInput && parseFloat(mInput.value) !== num) mInput.value = num;
  if (lInput && parseFloat(lInput.value) !== num) lInput.value = num;

  const badgeText = num === 0 ? '1st Block' : `+${num}s Delay`;
  const badgeColor = num === 0 ? '#00c48c' : '#fbbf24';
  const badgeBg = num === 0 ? 'rgba(0,196,140,0.12)' : 'rgba(251,191,36,0.12)';
  const badgeBorder = num === 0 ? 'rgba(0,196,140,0.25)' : 'rgba(251,191,36,0.25)';

  [mBadge, lBadge].forEach(b => {
    if (b) {
      b.innerText = badgeText;
      b.style.color = badgeColor;
      b.style.background = badgeBg;
      b.style.borderColor = badgeBorder;
    }
  });
}
window.handleDelayInputChange = handleDelayInputChange;

async function executeMatrixBuy() {
  if (!state.activeToken) {
    return showToast('No active token is currently selected! Launch or track a CA first.', 'warning');
  }
  const checked = Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => cb.value);
  const walletAddresses = checked.length > 0 ? checked : getTargetAddresses('all');
  if (walletAddresses.length === 0) {
    return showToast('No wallets selected for buy order', 'warning');
  }
  const solAmount = parseFloat(document.getElementById('matrixBuyAmountInput')?.value || '0.1');
  const btn = document.getElementById('btnMatrixBuy');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader" class="w-3 h-3 animate-spin"></i><span>BUYING...</span>`;
  }

  const delaySec = state.subWalletDelaySec || 0;
  const isDevIncluded = state.masterWallet && walletAddresses.includes(state.masterWallet.address);
  const subTargets = state.masterWallet ? walletAddresses.filter(a => a !== state.masterWallet.address) : walletAddresses;

  try {
    if (delaySec > 0 && isDevIncluded && subTargets.length > 0) {
      // Step 1: Dev buys immediately
      logTerminal(`[Buy] Pending dev wallet ${solAmount} SOL, then ${delaySec}s before sub-wallets`);
      showToast('Buy pending…', 'info');
      const devRes = await apiFetch('/api/trading/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solAmount, walletAddresses: [state.masterWallet.address] })
      });
      const devData = await finishTrade('Buy', devRes);
      if (!devRes.ok || devData.success === false) return;

      // Step 2: Delay countdown
      await new Promise(r => setTimeout(r, delaySec * 1000));

      // Step 3: Sub-wallets buy
      logTerminal(`[Multi-Buy] Firing ${subTargets.length} sub-wallets buy after ${delaySec}s delay...`);
      logTerminal(`[Buy] Pending ${subTargets.length} sub-wallet buy(s)`);
      const res = await apiFetch('/api/trading/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solAmount, walletAddresses: subTargets })
      });
      await finishTrade('Buy', res);
    } else {
      logTerminal(`[Buy] Pending ${solAmount} SOL across ${walletAddresses.length} wallet(s)`);
      showToast('Buy pending…', 'info');
      const res = await apiFetch('/api/trading/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solAmount, walletAddresses })
      });
      await finishTrade('Buy', res);
    }
  } catch (err) {
    showToast(`Multi-Buy error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `▲ BUY SELECTED`;
    }
    if (window.lucide) lucide.createIcons();
  }
}

async function executeMatrixSell() {
  if (!state.activeToken) {
    return showToast('No active token is currently selected! Launch or track a CA first.', 'warning');
  }
  const checked = Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => cb.value);
  const walletAddresses = checked.length > 0 ? checked : getTargetAddresses('all');
  if (walletAddresses.length === 0) {
    return showToast('No wallets selected for sell order', 'warning');
  }
  const pct = parseInt(document.getElementById('matrixSellPctInput')?.value || '50', 10);
  const btn = document.getElementById('btnMatrixSell');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader" class="w-3 h-3 animate-spin"></i><span>SELLING...</span>`;
  }
  try {
    logTerminal(`[Sell] Pending ${pct}% from ${walletAddresses.length} wallet(s)`);
    showToast('Sell pending…', 'info');
    const res = await apiFetch('/api/trading/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pct, walletAddresses })
    });
    await finishTrade('Sell', res);
  } catch (err) {
    logTerminal(`[Sell] Failed: ${err.message}`);
    showToast(`Sell failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `▼ SELL SELECTED`;
    }
    if (window.lucide) lucide.createIcons();
  }
}

// ==================== LIVE STATS & TABLE SYNC ====================

async function loadLiveStats() {
  const requestedMint = state.activeToken;
  const requestedEpoch = state.chartEpoch;
  try {
    const qs = requestedMint ? `?mint=${encodeURIComponent(requestedMint)}` : '';
    const res = await apiFetch(`/api/trading/stats${qs}`);
    const data = await res.json();
    const s = data.stats;
    if (!s) return;
    if (state.chartEpoch !== requestedEpoch || state.activeToken !== requestedMint) return;
    if (s.stale) return;
    if (requestedMint && s.activeToken && s.activeToken !== requestedMint) return;

    if (s.activeToken) {
      state.activeToken = s.activeToken;
      updateActiveTokenUi(s.activeToken);
      state.curveProgressPct = s.curveProgressPct;
      paintCurve({
        progressPct: s.curveProgressPct,
        realSol: s.curveRealSol,
        complete: s.curveComplete
      });

      document.getElementById('deskSolValueDisplay').innerText = `${s.currentSolValue} SOL`;
      document.getElementById('deskInvestedDisplay').innerText = s.totalSolInvested == null ? '—' : `${s.totalSolInvested} SOL`;

      const pnlDisplay = document.getElementById('deskPnlDisplay');
      const pnlBadge = document.getElementById('deskPnlStatusBadge');
      if (s.pnlSol == null) {
        pnlDisplay.innerText = '—';
        pnlDisplay.className = 'text-2xl font-mono font-extrabold text-slate-400';
        pnlBadge.className = 'badge-pnl-green';
        pnlBadge.innerText = 'COST UNKNOWN';
      } else {
      const pnlPrefix = s.pnlSol >= 0 ? '+' : '';

      pnlDisplay.innerText = `${pnlPrefix}${s.pnlSol} SOL (${pnlPrefix}${s.pnlPct}%)`;
      if (s.pnlSol >= 0) {
        pnlDisplay.className = 'text-2xl font-mono font-extrabold text-emerald-400';
        pnlBadge.className = 'badge-pnl-green';
        pnlBadge.innerText = '▲ IN PROFIT';
      } else {
        pnlDisplay.className = 'text-2xl font-mono font-extrabold text-rose-400';
        pnlBadge.className = 'badge-pnl-red';
        pnlBadge.innerText = '▼ DRAWDOWN';
      }
      }

      if (s.dexInfo) {
        document.getElementById('deskMcapDisplay').innerText = `$${(s.dexInfo.marketCap || 0).toLocaleString()}`;
      } else if (Number(s.curveMarketCapSol) > 0) {
        document.getElementById('deskMcapDisplay').innerText = `${Number(s.curveMarketCapSol).toFixed(2)} SOL`;
      } else {
        document.getElementById('deskMcapDisplay').innerText = '—';
      }
      paintHoldingAllocation(s.wallets);
    }

    if (s.wallets && s.wallets.length > 0) {
      renderTradingWalletsTable(s.wallets);
      const simBalance = s.wallets.reduce((sum, row) => sum + (Number(row.simBalance) || 0), 0);
      const liveKnown = s.wallets.every(row => row.liveBalance != null && Number.isFinite(Number(row.liveBalance)));
      state.balanceTotals = {
        simBalance,
        liveBalance: liveKnown ? s.wallets.reduce((sum, row) => sum + Number(row.liveBalance), 0) : null,
        liveError: s.wallets.map(row => row.liveError).find(Boolean) || null
      };
      const masterRow = s.wallets.find(row => row.role === 'Master Dev');
      if (masterRow && state.masterWallet) {
        state.masterWallet.simBalance = masterRow.simBalance;
        state.masterWallet.liveBalance = masterRow.liveBalance;
        state.masterWallet.liveError = masterRow.liveError;
      }
      renderStoredBalances();
    }
  } catch (e) {
    // ignore
  }
}

function renderTradingWalletsTable(wallets) {
  const tbody = document.getElementById('tradingWalletsTableBody');
  if (!tbody) return;

  // Preserve checked state across polling intervals
  const existingBoxes = Array.from(document.querySelectorAll('.row-checkbox'));
  const isInitial = existingBoxes.length === 0;
  const prevChecked = new Set(
    existingBoxes.filter(cb => cb.checked).map(cb => cb.value)
  );

  tbody.innerHTML = '';

  (wallets || []).forEach(w => {
    const isDev = w.role === 'Master Dev';
    const tr = document.createElement('tr');
    tr.className = 'border-b border-[#192235]/60 hover:bg-[#131b2b]/50 transition-colors text-xs font-mono';

    const pnlKnown = w.pnlSol != null && Number.isFinite(Number(w.pnlSol));
    const pnlSol = pnlKnown ? Number(w.pnlSol) : null;
    const pnlPct = pnlKnown ? Number(w.pnlPct) : null;
    const pnlPrefix = pnlKnown && pnlSol >= 0 ? '+' : '';
    const pnlClass = !pnlKnown ? 'text-slate-500' : (pnlSol >= 0 ? 'badge-pnl-green' : 'badge-pnl-red');
    const pnlSymbol = !pnlKnown ? '' : (pnlSol >= 0 ? '▲' : '▼');
    const costText = w.solInvested == null ? '—' : Number(w.solInvested).toFixed(3);
    const pnlText = pnlKnown
      ? `${pnlSymbol} ${pnlPrefix}${pnlSol.toFixed(3)} (${pnlPrefix}${Number(pnlPct || 0).toFixed(1)}%)`
      : '—';
    const isChecked = isInitial ? true : prevChecked.has(w.address);

    const address = String(w.address || '');
    const safeAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? address : '';
    tr.dataset.wallet = safeAddress;
    tr.innerHTML = `
      <td class="py-2 px-2" style="width:26px;">
        <input type="checkbox" class="row-checkbox" ${isChecked ? 'checked' : ''} style="accent-color:#00d4ff;width:13px;height:13px;cursor:pointer;">
      </td>
      <td class="py-2 px-2">
        <div style="display:flex;align-items:center;gap:5px;">
          <span class="font-bold ${isDev ? 'text-amber-400' : 'text-slate-300'}" style="font-size:11px;"></span>
          <span class="addr-short" style="color:#546e7a;font-size:10px;"></span>
          <button type="button" class="copy-addr" style="background:none;border:none;color:#546e7a;cursor:pointer;padding:1px;display:flex;align-items:center;" title="Copy Address">
            <i data-lucide="copy" style="width:11px;height:11px;"></i>
          </button>
          <a class="solscan-link" target="_blank" rel="noopener noreferrer" style="color:#546e7a;display:flex;align-items:center;text-decoration:none;" title="View on Solscan">
            <i data-lucide="external-link" style="width:10px;height:10px;"></i>
          </a>
        </div>
      </td>
      <td class="py-2 px-2 text-right"><span class="sol-dual"></span></td>
      <td class="py-2 px-2 text-right text-slate-200 token-amt">${escapeHtml((Number(w.tokens) || 0).toLocaleString())}</td>
      <td class="py-2 px-2 text-right text-slate-400 cost-amt">${escapeHtml(costText)}</td>
      <td class="py-2 px-2 text-right font-semibold text-slate-200 value-amt">${escapeHtml((Number(w.currentValue) || 0).toFixed(3))}</td>
      <td class="py-2 px-2 text-center">
        <span class="pnl-amt ${pnlClass} text-[10px] font-mono"></span>
      </td>
      <td class="py-2 px-2 text-right">
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:5px;">
          <div style="display:flex;align-items:center;gap:2px;background:rgba(0,196,140,0.06);padding:2px 3px;border-radius:5px;border:1px solid rgba(0,196,140,0.2);">
            <span style="font-size:8px;font-weight:800;color:#00c48c;padding:0 2px;">BUY</span>
            <button type="button" class="btn-quick-buy" data-buy="0.02" style="font-size:9px;padding:1px 4px;">+0.02</button>
            <button type="button" class="btn-quick-buy" data-buy="0.05" style="font-size:9px;padding:1px 4px;">+0.05</button>
            <button type="button" class="btn-quick-buy" data-buy="0.1" style="font-size:9px;padding:1px 4px;">+0.1</button>
          </div>
          <div style="display:flex;align-items:center;gap:2px;background:rgba(240,76,94,0.06);padding:2px 3px;border-radius:5px;border:1px solid rgba(240,76,94,0.2);">
            <span style="font-size:8px;font-weight:800;color:#f04c5e;padding:0 2px;">SELL</span>
            <button type="button" class="btn-quick-sell" data-sell="25" style="font-size:9px;padding:1px 4px;">25%</button>
            <button type="button" class="btn-quick-sell" data-sell="50" style="font-size:9px;padding:1px 4px;">50%</button>
            <button type="button" class="btn-quick-sell" data-sell="75" style="font-size:9px;padding:1px 4px;">75%</button>
            <button type="button" class="btn-quick-sell" data-sell="100" style="font-size:9px;padding:1px 4px;background:rgba(240,76,94,0.22);font-weight:800;">100%</button>
          </div>
        </div>
      </td>
    `;
    const box = tr.querySelector('.row-checkbox');
    box.value = safeAddress;
    box.addEventListener('change', () => updateSelectedCount());
    renderDualBalance(tr.querySelector('.sol-dual'), w);
    tr.querySelector('.font-bold').textContent = String(w.role || '');
    tr.querySelector('.addr-short').textContent = safeAddress ? `${safeAddress.slice(0, 4)}...${safeAddress.slice(-4)}` : '';
    tr.querySelector('.copy-addr').addEventListener('click', () => {
      if (!safeAddress) return;
      navigator.clipboard.writeText(safeAddress);
      showToast(`Copied ${w.role || 'wallet'} address`, 'info');
    });
    const scan = tr.querySelector('.solscan-link');
    if (safeAddress) scan.href = `https://solscan.io/account/${safeAddress}`;
    else scan.removeAttribute('href');
    tr.querySelector('td:nth-child(7) span').textContent = pnlText;
    tr.querySelectorAll('[data-buy]').forEach(button => {
      button.addEventListener('click', () => executeInlineBuy(safeAddress, Number(button.dataset.buy)));
    });
    tr.querySelectorAll('[data-sell]').forEach(button => {
      button.addEventListener('click', () => executeInlineSell(safeAddress, Number(button.dataset.sell)));
    });
    tbody.appendChild(tr);
  });

  updateSelectedCount();
  if (window.lucide) lucide.createIcons();
}

function updateActiveTokenUi(mint) {
  if (!mint) return;
  const navInput = document.getElementById('navTrackCaInput');
  if (navInput) navInput.value = mint;
  const chartCa = document.getElementById('chartManualCaInput');
  if (chartCa) chartCa.value = mint;
  const link = document.getElementById('deskPumpLink');
  if (link) {
    const safeMint = externalMint(mint);
    link.href = safeMint ? `https://pump.fun/coin/${safeMint}` : '#';
    link.innerText = safeMint ? `Pump.fun (${safeMint.slice(0, 4)}...) ↗` : 'Pump.fun';
  }
  if (mint !== state.chartToken) {
    loadCandlesForToken(mint);
  }
  loadSafety(mint);
}

function extractSolanaAddress(input) {
  if (!input) return '';
  const match = String(input).trim().match(/[1-9A-HJ-NP-za-km-z]{32,44}/);
  return match ? match[0] : String(input).trim();
}

function bindTrackedCaInputs() {
  const trackFrom = (input) => {
    if (!input) return;
    const ca = extractSolanaAddress(input.value);
    if (!ca) return;
    input.value = ca;
    if (input.id === 'chartManualCaInput') loadChartCaFromInput();
    else setTrackedTokenFromNav();
  };
  const onKey = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    trackFrom(event.target);
  };
  const onPaste = (event) => {
    const text = event.clipboardData && event.clipboardData.getData('text');
    const ca = extractSolanaAddress(text);
    if (!ca) return;
    event.preventDefault();
    event.target.value = ca;
    trackFrom(event.target);
  };
  ['chartManualCaInput', 'navTrackCaInput'].forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('keydown', onKey);
    input.addEventListener('paste', onPaste);
  });
}

let safetyCreator = null;

function paintSafety(report) {
  const score = document.getElementById('safetyScore');
  const list = document.getElementById('safetyChecks');
  const banner = document.getElementById('safetyBanner');
  const exitAlert = document.getElementById('exitAlert');
  if (!score || !list) return;
  safetyCreator = report && report.creator || null;
  if (report && report.ownLaunch) {
    score.textContent = 'Own launch';
    score.style.color = '#86efac';
    list.innerHTML = '';
    if (banner) banner.style.display = 'none';
    if (exitAlert) exitAlert.style.display = 'none';
    const topTraders = document.getElementById('topTraders');
    if (topTraders) topTraders.style.display = 'none';
    return;
  }
  const colors = { green: '#86efac', yellow: '#fcd34d', red: '#fda4af', unknown: '#94a3b8', na: '#94a3b8', incomplete: '#fbbf24' };
  const unknownCount = (report && report.checks || []).filter(row => row && row.status === 'unknown').length;
  const verdict = (report && report.overall) || 'unknown';
  const headline = report && report.score != null ? `${verdict} · ${report.score}` : verdict;
  score.textContent = unknownCount ? `${headline} · ${unknownCount} unknown` : headline;
  score.style.color = colors[verdict] || colors.unknown;
  const summary = document.getElementById('chartSafetySummary');
  if (summary) {
    const reds = (report && report.checks || []).filter(row => row && row.status === 'red').length;
    summary.style.display = 'inline-block';
    summary.textContent = `${verdict} ${report && report.score != null ? report.score : '—'} · ${reds} red · ${unknownCount} unknown`;
  }
  list.innerHTML = '';
  (report && report.checks || []).forEach(row => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;gap:6px;align-items:flex-start;min-width:0;';
    const dot = document.createElement('span');
    dot.textContent = '●';
    dot.style.color = colors[row.status] || colors.unknown;
    const text = document.createElement('span');
    const when = row.at ? new Date(row.at).toISOString().slice(11, 19) : '';
    const stateLabel = row.status === 'unknown' ? 'UNKNOWN' : row.status === 'na' ? 'n/a' : row.status === 'green' ? 'PASS' : (row.status || '');
    text.textContent = `${stateLabel} ${row.label}: ${row.reason || row.status}${when ? ' · ' + when : ''}`;
    item.append(dot, text);
    list.appendChild(item);
  });
  if (banner) {
    if (report && report.blacklisted) {
      banner.style.display = 'block';
      banner.textContent = `Dev ${report.creator || ''} is blacklisted. Buys are blocked. Existing positions are not sold automatically.`;
    } else {
      banner.style.display = 'none';
      banner.textContent = '';
    }
  }
  if (exitAlert) {
    const alert = report && report.exitAlert;
    const reasons = alert && Array.isArray(alert.reasons) ? alert.reasons : [];
    if (alert && alert.action === 'sell' && reasons.length) {
      exitAlert.style.display = 'block';
      exitAlert.textContent = `Exit alert: ${reasons.join('; ')}. Sim sells the ladder. Live does not auto-sell.`;
    } else {
      exitAlert.style.display = 'none';
      exitAlert.textContent = '';
    }
  }
  paintTopTraders(report && report.topTraders);
}

function paintTopTraders(row) {
  const host = document.getElementById('topTraders');
  if (!host) return;
  host.textContent = '';
  if (!row || !Array.isArray(row.wallets)) {
    host.style.display = 'none';
    return;
  }
  host.style.display = 'block';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:9.5px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#78909c;margin-bottom:4px;';
  const linked = row.linkedProfitPct == null ? '—' : `${Number(row.linkedProfitPct).toFixed(1)}%`;
  const organic = row.organicProfitPct == null ? '—' : `${Number(row.organicProfitPct).toFixed(1)}%`;
  title.textContent = `Top traders · linked profit ${linked} · organic ${organic}`;
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:10px;color:#cbd5e1;';
  const head = document.createElement('tr');
  ['Wallet', 'PnL', 'SOL in', 'SOL out', 'Bought', 'Received', 'Tags'].forEach(label => {
    const cell = document.createElement('th');
    cell.textContent = label;
    cell.style.cssText = 'text-align:left;font-weight:700;color:#78909c;padding:2px 4px;';
    head.appendChild(cell);
  });
  table.appendChild(head);
  row.wallets.slice(0, 20).forEach(item => {
    const line = document.createElement('tr');
    const tags = ['coordinated', 'kol', 'kolShadow', 'serialDev', 'sniper'].filter(key => item[key] === true).join(' ');
    const cells = [
      item.wallet ? String(item.wallet).slice(0, 4) : '—',
      item.pnl == null ? '—' : Number(item.pnl).toFixed(3),
      item.solIn == null ? '—' : Number(item.solIn).toFixed(3),
      item.solOut == null ? '—' : Number(item.solOut).toFixed(3),
      item.tokensBought == null ? '—' : String(item.tokensBought),
      item.tokensReceived == null ? '—' : String(item.tokensReceived),
      tags || '—'
    ];
    cells.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      cell.style.cssText = 'padding:2px 4px;font-family:monospace;';
      line.appendChild(cell);
    });
    table.appendChild(line);
  });
  host.append(title, table);
}

async function saveFarmRide(enabled) {
  try {
    const res = await apiFetch('/api/research/farm-ride', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: Boolean(enabled) })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Farm ride setting failed');
    showToast(enabled ? 'Sim farm ride on' : 'Farm ride off', 'info');
  } catch (err) {
    const box = document.getElementById('farmRideEnabled');
    if (box) box.checked = false;
    showToast(err.message, 'error');
  }
}

function scrollToSafety() {
  const panel = document.getElementById('safetyPanel');
  if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function paintOriginBadge(origin) {
  const badge = document.getElementById('chartOriginBadge');
  if (!badge) return;
  const status = origin && origin.status;
  const styles = {
    og: 'display:inline-block;background:rgba(45,212,191,0.16);color:#5eead4;border:1px solid rgba(45,212,191,0.45);',
    vamp: 'display:inline-block;background:rgba(244,114,182,0.16);color:#fb7185;border:1px solid rgba(251,146,60,0.55);',
    unknown: 'display:inline-block;background:rgba(148,163,184,0.16);color:#94a3b8;border:1px solid rgba(148,163,184,0.4);',
    possible: 'display:inline-block;background:rgba(251,191,36,0.16);color:#fbbf24;border:1px solid rgba(251,191,36,0.45);'
  };
  if (status !== 'og' && status !== 'vamp' && status !== 'unknown' && status !== 'possible') {
    badge.style.display = 'none';
    badge.textContent = '';
    badge.title = '';
    return;
  }
  badge.style.cssText = `${styles[status]}font-size:9px;font-weight:800;letter-spacing:0.04em;padding:2px 6px;border-radius:999px;`;
  badge.textContent = status === 'unknown' ? 'UNKNOWN' : (origin.label || status.toUpperCase());
  const tip = [origin.reason, origin.og && origin.og.mint ? `OG ${origin.og.mint}` : '', origin.ogDevBuying ? 'OG dev is buying this vamp' : ''].filter(Boolean).join(' · ');
  badge.title = tip;
}

function paintFarmRide(decision) {
  const el = document.getElementById('farmRideStatus');
  if (!el) return;
  if (!decision || decision.eligible == null) {
    el.textContent = `Farm ride: unknown${decision && decision.reasons && decision.reasons.length ? '. ' + decision.reasons.join('; ') : ''}`;
    return;
  }
  el.textContent = `Farm ride: ${decision.eligible ? 'eligible' : 'not eligible'}. ${(decision.reasons || []).join('; ')}`;
}

let safetyPollMint = '';
let safetyPolls = 0;

async function loadSafety(mint) {
  if (!mint) return;
  if (safetyPollMint !== mint) {
    safetyPollMint = mint;
    safetyPolls = 0;
  }
  try {
    const res = await apiFetch(`/api/safety/${encodeURIComponent(mint)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Safety check failed');
    paintSafety(data.report);
    if (data.report && data.report.pending && safetyPolls < 4 && safetyPollMint === mint) {
      safetyPolls += 1;
      setTimeout(() => { if (safetyPollMint === mint) loadSafety(mint); }, 4000);
    } else if (data.report && !data.report.pending) {
      safetyPolls = 0;
    }
    try {
      const originRes = await apiFetch(`/api/research/origin/${encodeURIComponent(mint)}`);
      const originBody = await originRes.json().catch(() => ({}));
      paintOriginBadge(originRes.ok ? originBody.origin : { status: 'unknown', reason: 'Lookalike search failed' });
    } catch (err) {
      paintOriginBadge({ status: 'unknown', reason: err.message });
    }
    try {
      const farm = await apiFetch(`/api/research/farm-ride/${encodeURIComponent(mint)}`);
      const farmBody = await farm.json().catch(() => ({}));
      if (farm.ok) paintFarmRide(farmBody.decision);
    } catch (err) {
      paintFarmRide(null);
    }
    const box = document.getElementById('safetyAutoBlacklist');
    if (box && data.report && data.report.auto) box.checked = data.report.auto.enabled !== false;
  } catch (err) {
    paintSafety({ overall: 'unknown', score: null, checks: [{ id: 'error', label: 'Safety', status: 'unknown', reason: err.message, at: Date.now() }] });
  }
}

async function toggleSafetyAuto(checked) {
  try {
    await apiFetch('/api/safety/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: { enabled: Boolean(checked) } })
    });
  } catch (err) {
    showToast('Safety setting failed: ' + err.message, 'error');
  }
}

async function refreshResearch() {
  const metaEl = document.getElementById('researchMeta');
  const sniperEl = document.getElementById('researchSnipers');
  if (!metaEl) return;
  try {
    const res = await apiFetch('/api/research/meta');
    const data = await res.json().catch(() => ({}));
    const themes = data.windows && data.windows['1h'] || [];
    metaEl.textContent = themes.length
      ? themes.slice(0, 4).map(row => `${row.theme} ${row.momentum.toFixed(1)}`).join(' · ')
      : 'No theme sample yet.';
    const snipers = await apiFetch('/api/research/snipers');
    const body = await snipers.json().catch(() => ({}));
    const own = (body.ownLaunches || []).filter(row => row.known);
    if (sniperEl) {
      sniperEl.textContent = own.length
        ? own.map(row => `${row.mint.slice(0, 4)} same-block ${row.sameBlockSupplyPct == null ? '—' : row.sameBlockSupplyPct.toFixed(1) + '%'}`).join(' · ')
        : 'No own-launch sniper sample yet.';
    }
  } catch (err) {
    metaEl.textContent = 'Research unavailable.';
  }
}

async function saveExitLadder(enabled) {
  try {
    const res = await apiFetch('/api/research/exit-ladder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: Boolean(enabled) })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Exit ladder is simulation-only');
    showToast(enabled ? 'Sim exit ladder on' : 'Exit ladder off', 'info');
  } catch (err) {
    const box = document.getElementById('exitLadderEnabled');
    if (box) box.checked = false;
    showToast(err.message, 'error');
  }
}

async function blacklistCurrentDev() {
  if (!safetyCreator) return showToast('No creator is known for this coin', 'warning');
  try {
    const res = await apiFetch('/api/safety/blacklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: safetyCreator, reason: 'Manual from safety panel' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Blacklist failed');
    showToast('Dev blacklisted. New buys are blocked.', 'warning');
    if (state.activeToken) loadSafety(state.activeToken);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function loadChartCaFromInput() {
  const input = document.getElementById('chartManualCaInput');
  if (!input) return;
  const raw = input.value.trim();
  const ca = extractSolanaAddress(raw);
  if (!ca) return showToast('Please enter a Token Mint Address / CA or Pump.fun URL', 'warning');
  input.value = ca;
  const navInput = document.getElementById('navTrackCaInput');
  if (navInput) navInput.value = ca;
  setTrackedTokenFromNav();
}

async function setTrackedTokenFromNav() {
  const raw = document.getElementById('navTrackCaInput').value.trim();
  const mint = extractSolanaAddress(raw);
  if (!mint) return showToast('Please enter a Token Mint Address or Pump.fun URL', 'warning');
  document.getElementById('navTrackCaInput').value = mint;
  try {
    const res = await apiFetch('/api/trading/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mint })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false || !data.activeToken) {
      throw new Error(data.error || 'Failed to track CA');
    }
    state.activeToken = data.activeToken;
    updateActiveTokenUi(data.activeToken);
    loadLiveStats();
    showToast(`Tracking mint ${mint.slice(0, 8)}... as our launch`, 'success');
  } catch (e) {
    showToast('Failed to track CA: ' + e.message, 'error');
  }
}

// ==================== LAUNCHPAD & BUNDLER LOGIC ====================

function restoreLaunchPrefs() {
  const storedTip = Number(localStorage.getItem('selectedJitoTip'));
  if (storedTip > 0) state.selectedJitoTip = storedTip;
  const storedMode = localStorage.getItem('launchMode');
  if (storedMode === 'standard' || storedMode === 'bundle') state.launchMode = storedMode;
  const storedMin = Number(localStorage.getItem('vampMinMcap'));
  if (Number.isFinite(storedMin) && storedMin >= 0) state.vampMinMcap = storedMin;
  state.vampMaxMcap = storedOptionalNumber('vampMaxMcap');
  state.vampMinAge = storedOptionalNumber('vampMinAge');
  state.vampMaxAge = storedOptionalNumber('vampMaxAge');
  state.vampAgeUnit = localStorage.getItem('vampAgeUnit') === 'hours' ? 'hours' : 'minutes';
  state.vampMinVolume = storedOptionalNumber('vampMinVolume');
  state.vampMinLiquidity = storedOptionalNumber('vampMinLiquidity');
  state.vampSortTouched = localStorage.getItem('vampSortTouched') === '1';
  const storedSort = localStorage.getItem('vampSort');
  if (storedSort === 'closest' || storedSort === 'newest' || storedSort === 'biggest') state.vampSort = storedSort;
  state.vampShowUnknown = localStorage.getItem('vampShowUnknownMcap') === '1';
  paintVampFilters();
  try {
    state.bundleForm = bundleFormFromStorage(JSON.parse(localStorage.getItem('bundleForm') || 'null'));
  } catch (err) {
    state.bundleForm = emptyBundleForm();
  }
  paintBundleFields();
  paintJitoTips();
  paintLaunchMode();
  try {
    const draft = JSON.parse(localStorage.getItem('launchDraft') || 'null');
    if (draft && typeof draft === 'object') state.launchDraft = draft;
  } catch (err) {
    state.launchDraft = null;
  }
  paintLaunchDraft();
}

function persistBundleForm() {
  try { localStorage.setItem('bundleForm', JSON.stringify(state.bundleForm)); } catch (err) { /* storage can be blocked */ }
}

function captureBundleInput(el) {
  if (!el || !el.id) return;
  if (el.id === 'devSolBuy') state.bundleForm = rememberField(state.bundleForm, 'devSolBuy', el.value);
  else if (el.id === 'customJitoTip') state.bundleForm = rememberField(state.bundleForm, 'tip', el.value);
  else if (el.id.indexOf('subBuyInput-') === 0) {
    const key = el.dataset.wallet || el.id;
    state.bundleForm = rememberField(state.bundleForm, { buyKey: key }, el.value);
  } else return;
  persistBundleForm();
}

function paintBundleFields() {
  const dev = document.getElementById('devSolBuy');
  const devShown = displayValue(state.bundleForm, 'devSolBuy', { focused: document.activeElement === dev });
  if (dev && devShown.write) dev.value = devShown.value;
  const count = document.getElementById('subWalletCountSelect');
  const countShown = displayValue(state.bundleForm, 'walletCount', { focused: document.activeElement === count });
  if (count && countShown.write && Array.from(count.options).some(option => option.value === countShown.value)) count.value = countShown.value;
}

function currentLaunchAmounts() {
  const dev = document.getElementById('devSolBuy');
  if (dev) state.bundleForm = rememberField(state.bundleForm, 'devSolBuy', dev.value);
  const tip = document.getElementById('customJitoTip');
  if (tip && state.bundleForm.tipEdited) state.bundleForm = rememberField(state.bundleForm, 'tip', tip.value);
  (state.subWallets || []).forEach((wallet, index) => {
    const input = document.getElementById(`subBuyInput-${index}`);
    if (!input) return;
    const key = wallet.address || ('#' + index);
    state.bundleForm = rememberField(state.bundleForm, { buyKey: key }, input.value);
  });
  persistBundleForm();
  const amounts = launchAmounts(state.bundleForm, state.subWallets || []);
  if (!(amounts.jitoTipSol > 0)) amounts.jitoTipSol = Number(state.selectedJitoTip);
  return amounts;
}

function paintJitoTips() {
  const tip = Number(state.selectedJitoTip);
  const presets = [0.002, 0.005, 0.01];
  const labels = { 0.002: 'Fast', 0.005: 'Turbo', 0.01: 'Ultra' };
  presets.forEach(value => {
    const btn = document.getElementById(`tipBtn-${value}`);
    const label = document.getElementById(`tipLabel-${value}`);
    if (!btn) return;
    const selected = Math.abs(tip - value) < 1e-9;
    btn.style.border = selected ? '1px solid #00d4ff' : '1px solid #1a2338';
    btn.style.background = selected ? 'rgba(0,212,255,0.14)' : '#090d17';
    btn.style.color = selected ? '#a0e8ff' : '#cfd8dc';
    if (label) {
      label.textContent = selected ? `${labels[value]} ✓` : labels[value];
      label.style.color = selected ? '#00d4ff' : '#78909c';
      label.style.fontWeight = selected ? '800' : '600';
    }
  });
  const custom = document.getElementById('customJitoTip');
  const draft = displayValue(state.bundleForm, 'tip', { focused: document.activeElement === custom });
  if (custom && draft.write) custom.value = draft.value;
  else if (custom && document.activeElement !== custom) custom.value = String(tip);
}

function setJitoTip(amount) {
  const max = Number(state.maxJitoTipSol) > 0 ? Number(state.maxJitoTipSol) : 0.01;
  const tip = Number(typeof amount === 'string' ? amount.trim() : amount);
  if (!Number.isFinite(tip) || tip <= 0) {
    showToast('Enter a Jito tip greater than 0', 'warning');
    return;
  }
  state.selectedJitoTip = Math.min(tip, max);
  if (tip > max) showToast(`Tip clamped to ${max} SOL`, 'warning');
  state.bundleForm = noteAppliedTip(state.bundleForm, state.selectedJitoTip);
  persistBundleForm();
  try { localStorage.setItem('selectedJitoTip', String(state.selectedJitoTip)); } catch (err) { /* storage can be blocked */ }
  paintJitoTips();
}

function applyCustomJitoTip() {
  const input = document.getElementById('customJitoTip');
  setJitoTip(input ? input.value : '');
}

function paintLaunchMode() {
  const bundle = document.getElementById('launchModeBundle');
  const standard = document.getElementById('launchModeStandard');
  const tips = document.getElementById('jitoTipBlock');
  const fee = document.getElementById('priorityFeeBlock');
  const launch = document.getElementById('launchButtonLabel');
  const selected = state.launchMode === 'standard';
  [bundle, standard].forEach(btn => {
    if (!btn) return;
    const on = (btn.id === 'launchModeStandard') === selected;
    btn.style.border = on ? '1px solid #00d4ff' : '1px solid #1a2338';
    btn.style.background = on ? 'rgba(0,212,255,0.14)' : '#090d17';
    btn.style.color = on ? '#a0e8ff' : '#cfd8dc';
  });
  if (tips) tips.style.display = selected ? 'none' : 'block';
  if (fee) fee.style.display = selected ? 'block' : 'none';
  if (launch) launch.textContent = selected ? 'LAUNCH STANDARD (NO BUNDLE)' : 'LAUNCH ATOMIC JITO BUNDLE (SLOT 0)';
}

function setLaunchMode(mode) {
  state.launchMode = mode === 'standard' ? 'standard' : 'bundle';
  try { localStorage.setItem('launchMode', state.launchMode); } catch (err) { /* storage can be blocked */ }
  paintLaunchMode();
}

function storedOptionalNumber(key) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function readOptionalInput(id) {
  const value = Number(document.getElementById(id) && document.getElementById(id).value);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function effectiveVampSort() {
  if (state.vampSortTouched && (state.vampSort === 'closest' || state.vampSort === 'newest' || state.vampSort === 'biggest')) {
    return state.vampSort;
  }
  return (state.vampMinMcap > 0 || state.vampMaxMcap > 0) ? 'closest' : 'newest';
}

function paintVampFilters() {
  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = value > 0 ? String(value) : '';
  };
  const min = document.getElementById('vampMinMcap');
  if (min && document.activeElement !== min) min.value = String(state.vampMinMcap || 0);
  setValue('vampMaxMcap', state.vampMaxMcap);
  setValue('vampMinAge', state.vampMinAge);
  setValue('vampMaxAge', state.vampMaxAge);
  setValue('vampMinVolume', state.vampMinVolume);
  setValue('vampMinLiquidity', state.vampMinLiquidity);
  const unit = document.getElementById('vampAgeUnit');
  if (unit && document.activeElement !== unit) unit.value = state.vampAgeUnit === 'hours' ? 'hours' : 'minutes';
  const sort = document.getElementById('vampSort');
  if (sort && document.activeElement !== sort) sort.value = effectiveVampSort();
  const unknownBox = document.getElementById('vampShowUnknown');
  if (unknownBox) unknownBox.checked = state.vampShowUnknown;
}

function ageInputToMs(value) {
  if (!(value > 0)) return 0;
  return value * (state.vampAgeUnit === 'hours' ? 60 * 60 * 1000 : 60 * 1000);
}

function saveVampSort() {
  const sort = document.getElementById('vampSort');
  state.vampSort = sort && (sort.value === 'closest' || sort.value === 'newest' || sort.value === 'biggest') ? sort.value : 'newest';
  state.vampSortTouched = true;
  saveVampMinMcap();
}

function saveVampMinMcap() {
  state.vampMinMcap = readOptionalInput('vampMinMcap');
  state.vampMaxMcap = readOptionalInput('vampMaxMcap');
  state.vampMinAge = readOptionalInput('vampMinAge');
  state.vampMaxAge = readOptionalInput('vampMaxAge');
  state.vampMinVolume = readOptionalInput('vampMinVolume');
  state.vampMinLiquidity = readOptionalInput('vampMinLiquidity');
  const unit = document.getElementById('vampAgeUnit');
  state.vampAgeUnit = unit && unit.value === 'hours' ? 'hours' : 'minutes';
  const box = document.getElementById('vampShowUnknown');
  state.vampShowUnknown = Boolean(box && box.checked);
  if (!state.vampSortTouched) state.vampSort = effectiveVampSort();
  paintVampFilters();
  try {
    localStorage.setItem('vampMinMcap', String(state.vampMinMcap));
    localStorage.setItem('vampMaxMcap', String(state.vampMaxMcap));
    localStorage.setItem('vampMinAge', String(state.vampMinAge));
    localStorage.setItem('vampMaxAge', String(state.vampMaxAge));
    localStorage.setItem('vampAgeUnit', state.vampAgeUnit);
    localStorage.setItem('vampMinVolume', String(state.vampMinVolume));
    localStorage.setItem('vampMinLiquidity', String(state.vampMinLiquidity));
    localStorage.setItem('vampSort', effectiveVampSort());
    localStorage.setItem('vampSortTouched', state.vampSortTouched ? '1' : '0');
    localStorage.setItem('vampShowUnknownMcap', state.vampShowUnknown ? '1' : '0');
  } catch (err) { /* storage can be blocked */ }
  loadTrendingVampTokens();
}

function quickFillSubBuys(amount) {
  state.subWallets.forEach((wallet, idx) => {
    const key = wallet.address || ('#' + idx);
    state.bundleForm = rememberField(state.bundleForm, { buyKey: key }, amount);
    const el = document.getElementById(`subBuyInput-${idx}`);
    if (el) el.value = amount;
  });
  persistBundleForm();
  calculateBundleMetrics();
}

function randomizeSubBuys() {
  state.subWallets.forEach((wallet, idx) => {
    const base = 0.05;
    const jitter = (Math.random() * 0.16) - 0.08;
    const amount = Math.max(0.05, Number((base + jitter).toFixed(3)));
    const key = wallet.address || ('#' + idx);
    state.bundleForm = rememberField(state.bundleForm, { buyKey: key }, amount);
    const el = document.getElementById(`subBuyInput-${idx}`);
    if (el) el.value = amount;
  });
  persistBundleForm();
  calculateBundleMetrics();
}

function calculateBundleMetrics() {
  const devSol = parseFloat(document.getElementById('devSolBuy')?.value || '0');
  let totalSubSol = 0;
  state.subWallets.forEach((_, idx) => {
    const el = document.getElementById(`subBuyInput-${idx}`);
    if (el) totalSubSol += parseFloat(el.value || '0');
  });

  const totalBundleSol = devSol + totalSubSol;
  const tSolEl = document.getElementById('metricTotalSol');
  if (tSolEl) tSolEl.innerText = `${totalBundleSol.toFixed(2)} SOL`;

  const virtualSol = 30 + totalBundleSol;
  const k = 30 * 1073000000;
  const newTokens = k / virtualSol;
  const tokensOut = Math.max(0, 1073000000 - newTokens);
  const supplyPct = ((tokensOut / 1000000000) * 100).toFixed(2);

  const tTokEl = document.getElementById('metricTotalTokens');
  const sPctEl = document.getElementById('metricSupplyPct');
  if (tTokEl) tTokEl.innerText = `~${Math.floor(tokensOut).toLocaleString()}`;
  if (sPctEl) sPctEl.innerText = `${supplyPct}% (Slot 0)`;

  const devTokens = Math.floor(tokensOut * (devSol / (totalBundleSol || 1)));
  const devPct = ((devTokens / 1000000000) * 100).toFixed(2);
  const dTokEl = document.getElementById('devBuyTokensEst');
  if (dTokEl) dTokEl.innerText = `~${devTokens.toLocaleString()} tokens (${devPct}%)`;
}

async function runPreflightCheck() {
  const btn = document.getElementById('btnPreflight');
  btn.disabled = true;
  btn.innerText = 'Validating balances & compute budget...';

  try {
    const amounts = currentLaunchAmounts();
    const devSolBuy = amounts.devSolBuy;
    const subWalletBuys = amounts.subWalletBuys;

    const res = await apiFetch('/api/launch/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devSolBuy,
        subWalletBuys,
        jitoTipSol: amounts.jitoTipSol,
        launchMode: state.launchMode,
        priorityFeeSol: Number(document.getElementById('launchPriorityFee')?.value || '0')
      })
    });

    const data = await res.json();
    if (data.passed) {
      showToast(`Pre-flight Passed! Total: ${data.totalBundleSol} SOL (~${data.supplyPct}% supply)`, 'success');
      logTerminal(`[Pre-Flight] Verification Passed: ${data.totalBundleSol} SOL bundle ready for slot 0 inclusion.`);
    } else {
      showToast(`Pre-flight issues: ${data.issues[0]}`, 'warning');
      data.issues.forEach(iss => logTerminal(`⚠️ [Pre-Flight Warning] ${iss}`));
    }
  } catch (err) {
    showToast('Pre-flight error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="check-circle" class="w-3.5 h-3.5"></i><span>Pre-Flight Validation Check</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

async function executeLaunchBundle() {
  const btn = document.getElementById('btnLaunchBundle');
  const tokenName = document.getElementById('tokenName').value.trim();
  const tokenSymbol = document.getElementById('tokenSymbol').value.trim();
  const tokenDescription = document.getElementById('tokenDescription').value.trim();

  if (!tokenName || !tokenSymbol) {
    return showToast('Please enter Token Name and Symbol', 'warning');
  }

  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>PACKING JITO BUNDLE...</span>`;

  try {
    logTerminal(`[Metadata] Uploading ${tokenSymbol} metadata...`);
    const formData = new FormData();
    formData.append('name', tokenName);
    formData.append('symbol', tokenSymbol);
    formData.append('description', tokenDescription);
    formData.append('twitter', document.getElementById('tokenTwitter').value.trim());
    formData.append('telegram', document.getElementById('tokenTelegram').value.trim());
    formData.append('website', document.getElementById('tokenWebsite').value.trim());
    if (state.logoFile) {
      formData.append('logo', state.logoFile);
    } else if (state.vampedImageUrl) {
      formData.append('imageUrl', state.vampedImageUrl);
    }

    const metaRes = await apiFetch('/api/launch/upload-meta', { method: 'POST', body: formData });
    const metaData = await metaRes.json();
    const metadataUri = metaData.metadataUri;

    const amounts = currentLaunchAmounts();
    const devSolBuy = amounts.devSolBuy;
    const subWalletBuys = amounts.subWalletBuys;

    const launchRes = await apiFetch('/api/launch/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenName,
        tokenSymbol,
        tokenDescription,
        tokenMetadataUri: metadataUri,
        devSolBuy,
        subWalletBuys,
        jitoTipSol: amounts.jitoTipSol,
        launchMode: state.launchMode,
        priorityFeeSol: Number(document.getElementById('launchPriorityFee')?.value || '0'),
        subWalletDelaySec: state.subWalletDelaySec || parseFloat(document.getElementById('subWalletBuyDelayInput')?.value || '0')
      })
    });

    const launchData = await launchRes.json();
    if (launchData.success) {
      state.activeToken = launchData.mint;
      updateActiveTokenUi(launchData.mint);
      logTerminal(`🎉 [Success] Atomic Bundle Landed! CA: ${launchData.mint}`);
      showToast(`Token launched & bundled! CA: ${launchData.mint.slice(0, 8)}...`, 'success');
      loadLiveStats();
      switchTab('trading');
    } else {
      throw new Error(launchData.error || 'Launch failed');
    }
  } catch (err) {
    showToast(`Launch failed: ${err.message}`, 'error');
    logTerminal(`❌ [Launch Error] ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="flame" class="w-4 h-4"></i><span>LAUNCH ATOMIC JITO BUNDLE (SLOT 0)</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

// ==================== WALLET HELPERS ====================

function formatSolAmount(value) {
  return Number(value).toFixed(3);
}

function renderDualBalance(el, row) {
  if (!el || !row) return;
  const sim = Number(row.simBalance);
  const live = row.liveBalance;
  const liveKnown = live != null && Number.isFinite(Number(live));
  el.replaceChildren();
  const simEl = document.createElement('span');
  simEl.textContent = 'SIM ' + formatSolAmount(Number.isFinite(sim) ? sim : 0) + ' SOL';
  const sep = document.createElement('span');
  sep.textContent = ' / ';
  const liveEl = document.createElement('span');
  if (liveKnown) {
    liveEl.textContent = 'LIVE ' + formatSolAmount(live) + ' SOL';
    liveEl.title = 'On-chain balance (confirmed)';
  } else {
    liveEl.textContent = 'LIVE —';
    liveEl.title = row.liveError || 'Live balance unavailable';
  }
  const simMode = state.simulationMode !== false;
  const active = simMode ? simEl : liveEl;
  const quiet = simMode ? liveEl : simEl;
  active.style.fontWeight = '800';
  active.style.color = simMode ? '#00d4ff' : '#f04c5e';
  quiet.style.opacity = '0.45';
  el.append(simEl, sep, liveEl);
}

function totalsFromState() {
  const rows = [];
  if (state.masterWallet) rows.push(state.masterWallet);
  (state.subWallets || []).forEach(row => rows.push(row));
  if (!rows.length) return null;
  const simBalance = rows.reduce((sum, row) => sum + (Number(row.simBalance) || 0), 0);
  const liveKnown = rows.every(row => row.liveBalance != null && Number.isFinite(Number(row.liveBalance)));
  return {
    simBalance,
    liveBalance: liveKnown ? rows.reduce((sum, row) => sum + Number(row.liveBalance), 0) : null,
    liveError: rows.map(row => row.liveError).find(Boolean) || null
  };
}

function renderStoredBalances() {
  if (state.balanceTotals) renderDualBalance(document.getElementById('headerDevBalance'), state.balanceTotals);
  else renderDualBalance(document.getElementById('headerDevBalance'), totalsFromState());
  if (state.masterWallet) {
    renderDualBalance(document.getElementById('masterBalanceLine'), state.masterWallet);
    renderDualBalance(document.getElementById('disperseBalanceHint'), state.masterWallet);
  }
}

async function loadMasterWallet() {
  try {
    const res = await apiFetch('/api/wallets/master');
    const data = await res.json();
    if (data.master) {
      state.masterWallet = data.master;
      if (data.totals) state.balanceTotals = data.totals;
      renderStoredBalances();
      const addrIn = document.getElementById('masterAddressInput');
      const keyIn = document.getElementById('masterKeyInput');
      if (addrIn) addrIn.value = data.master.address;
      if (keyIn) {
        keyIn.value = '';
        keyIn.placeholder = 'Hidden. Private keys are only available from Export.';
      }
    }
  } catch (e) {
    console.error('Failed to load master wallet:', e);
  }
}

async function loadSubWallets() {
  try {
    const res = await apiFetch('/api/wallets/sub');
    const data = await res.json();
    if (data.subWallets) {
      state.subWallets = data.subWallets;
      if (data.totals) state.balanceTotals = data.totals;
      renderStoredBalances();
      renderSubWalletBuysInputs();
      renderSubWalletsTable();
      calculateBundleMetrics();
    }
  } catch (e) {
    console.error('Failed to load sub-wallets:', e);
  }
}

function subBuyKey(wallet, index) {
  return (wallet && wallet.address) || ('#' + index);
}

function renderSubWalletBuysInputs() {
  const container = document.getElementById('subWalletBuysContainer');
  if (!container) return;
  const wallets = state.subWallets || [];
  const countBadge = document.getElementById('subWalletCountBadge');
  if (countBadge) countBadge.textContent = `${wallets.length} Wallets`;
  const signature = wallets.map((wallet, index) => subBuyKey(wallet, index)).join(',');
  const existing = container.querySelectorAll('input[id^="subBuyInput-"]');
  if (container.dataset.wallets === signature && existing.length === wallets.length) {
    wallets.forEach((wallet, idx) => {
      const bal = document.getElementById(`subBuyBal-${idx}`);
      if (bal) renderDualBalance(bal, wallet);
      const input = document.getElementById(`subBuyInput-${idx}`);
      if (!input || document.activeElement === input) return;
      const shown = displayValue(state.bundleForm, { buyKey: subBuyKey(wallet, idx) }, { focused: false });
      if (shown.write) input.value = shown.value;
    });
    return;
  }
  const focused = document.activeElement;
  if (focused && focused.id && focused.id.indexOf('subBuyInput-') === 0 && focused.dataset.wallet) {
    state.bundleForm = rememberField(state.bundleForm, { buyKey: focused.dataset.wallet }, focused.value);
    persistBundleForm();
  }
  container.replaceChildren();
  container.dataset.wallets = signature;
  wallets.forEach((wallet, idx) => {
    const key = subBuyKey(wallet, idx);
    const shown = displayValue(state.bundleForm, { buyKey: key }, { focused: false });
    const div = document.createElement('div');
    div.className = 'bg-[#090d16] p-1.5 rounded border border-[#192235] space-y-1';
    const head = document.createElement('div');
    head.className = 'flex justify-between items-center text-[9px] text-slate-400';
    const label = document.createElement('span');
    label.className = 'font-bold';
    const address = String(wallet.address || '');
    label.textContent = `#${idx + 1} (${address.slice(0, 4)}...)`;
    const bal = document.createElement('span');
    bal.id = `subBuyBal-${idx}`;
    bal.className = 'sub-buy-bal font-mono';
    head.append(label, bal);
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.min = '0';
    input.max = '0.1';
    input.id = `subBuyInput-${idx}`;
    input.dataset.fn = 'bundleMetrics';
    input.dataset.evt = 'input';
    input.dataset.wallet = key;
    input.className = 'input-field py-0.5 px-1.5 text-xs font-mono font-bold text-center';
    input.value = shown.value;
    div.append(head, input);
    renderDualBalance(bal, wallet);
    container.appendChild(div);
    if (focused && focused.dataset && focused.dataset.wallet === key) input.focus();
  });
}

function renderSubWalletsTable() {
  const tbody = document.getElementById('subWalletsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  state.subWallets.forEach(w => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-[#192235]/60 hover:bg-[#131b2b]/50 transition-colors text-xs font-mono';
    const address = String(w.address || '');
    tr.dataset.wallet = address;
    tr.innerHTML = `
      <td class="py-2 px-2 text-slate-400">${escapeHtml(w.index)}</td>
      <td class="py-2 px-2 text-slate-200">
        <div class="flex items-center space-x-1.5">
          <span></span>
          <button type="button" class="text-slate-500 hover:text-cyan-400" data-copy-address="1">
            <i data-lucide="copy" class="w-3 h-3"></i>
          </button>
        </div>
      </td>
      <td class="py-2 px-2 text-right"><span class="sol-dual"></span></td>
      <td class="py-2 px-2 text-right text-[10px] text-slate-500">Export only</td>
    `;
    renderDualBalance(tr.querySelector('.sol-dual'), w);
    tr.querySelector('span').textContent = `${address.slice(0, 8)}...${address.slice(-6)}`;
    tr.querySelector('[data-copy-address]').addEventListener('click', () => {
      navigator.clipboard.writeText(address);
      showToast('Copied address', 'info');
    });
    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

async function executeDisperseSol() {
  const totalSol = parseFloat(document.getElementById('disperseTotalSol').value || '1.0');
  const randomize = document.getElementById('disperseRandomize').checked;

  try {
    showToast(`Dispersing ${totalSol} SOL to sub-wallets...`, 'info');
    const res = await apiFetch('/api/wallets/disperse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalSol, randomize })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Dispersed ${totalSol} SOL!`, 'success');
      loadMasterWallet();
      loadSubWallets();
    } else {
      throw new Error(data.error);
    }
  } catch (e) {
    showToast('Disperse error: ' + e.message, 'error');
  }
}

async function executeDrainSol() {
  if (!confirm('Drain all remaining SOL from all sub-wallets back to Master Dev wallet?')) return;
  try {
    showToast('Draining sub-wallets...', 'info');
    const res = await apiFetch('/api/wallets/drain', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Reclaimed ${data.drainedSol} SOL to Master!`, 'success');
      loadMasterWallet();
      loadSubWallets();
    }
  } catch (e) {
    showToast('Drain error: ' + e.message, 'error');
  }
}

async function confirmedWalletPost(url, body) {
  const send = (payload) => apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let res = await send(body);
  let data = await res.json().catch(() => ({}));
  if (res.status === 409) {
    const force = window.confirm(`${data.error || 'This wallet has a SOL balance.'}\n\nReplace it anyway? A backup is written, but funds on the old key do not move with it.`);
    if (!force) throw new Error(data.error || 'Replacement cancelled');
    res = await send(Object.assign({}, body, { force: true }));
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw new Error(data.error || 'Wallet request failed');
  return data;
}

async function regenerateSubWallets() {
  const select = document.getElementById('subWalletCountSelect');
  const count = parseInt(select.value, 10);
  state.bundleForm = rememberField(state.bundleForm, 'walletCount', select.value);
  persistBundleForm();
  if (!window.confirm('Replace the sub-wallets? A timestamped backup is saved under data/backups. Export the current keys first if they hold funds.')) return;
  try {
    await confirmedWalletPost('/api/wallets/sub/generate', { count });
    loadSubWallets();
    showToast(`Generated ${count} bundle sub-wallets`, 'info');
  } catch (e) {
    showToast('Failed to generate wallets: ' + e.message, 'error');
  }
}

function copyMasterAddress() {
  const val = document.getElementById('masterAddressInput').value;
  navigator.clipboard.writeText(val);
  showToast('Master Address Copied!', 'info');
}

function copyWalletSecret(secret) {
  navigator.clipboard.writeText(secret);
  showToast('Private key copied to clipboard!', 'info');
}

function toggleRevealMasterKey() {
  const input = document.getElementById('masterKeyInput');
  const btn = document.getElementById('btnRevealMasterKey');
  if (input.type === 'password') {
    input.type = 'text';
    btn.innerText = 'Hide';
  } else {
    input.type = 'password';
    btn.innerText = 'Reveal';
  }
}

async function exportAllWalletKeys() {
  if (!window.confirm('Export private keys to a JSON download? Anyone with that file controls the wallets.')) return;
  try {
    const res = await apiFetch('/api/wallets/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export refused');
    const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vamp_wallets_backup_${Date.now()}.json`;
    a.click();
    showToast('Wallet backup exported!', 'success');
  } catch (e) {
    showToast('Export failed: ' + e.message, 'error');
  }
}
window.exportSubWallets = exportAllWalletKeys;

async function generateNewMasterWallet() {
  if (!window.confirm('Generate a new Master Dev Wallet? A timestamped backup is saved, and the current key will stop being used. Export it first.')) return;
  try {
    await confirmedWalletPost('/api/wallets/master/generate', {});
    loadMasterWallet();
    showToast('New Master Dev Wallet generated!', 'success');
  } catch (e) {
    showToast('Error generating master wallet: ' + e.message, 'error');
  }
}

async function promptImportMasterKey() {
  if (!window.confirm('Importing a master key replaces the current one. A backup is written first. Continue only if the current key is backed up.')) return;
  const key = window.prompt('Paste the Solana master private key (base58 or a JSON byte array):');
  if (!key) return;
  try {
    await confirmedWalletPost('/api/wallets/master/import', { privateKey: key });
    loadMasterWallet();
    showToast('Master wallet imported successfully!', 'success');
  } catch (e) {
    showToast('Import error: ' + e.message, 'error');
  }
}


function externalMint(value) {
  const text = String(value || '').trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) ? text : '';
}

function addHttpsLink(parent, href, label) {
  const safe = typeof safeHttpsUrl === 'function' ? safeHttpsUrl(href) : '';
  if (!safe) return;
  const link = document.createElement('a');
  link.href = safe;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  link.style.cssText = 'color:#7dd3fc;font-size:10px;text-decoration:none;';
  parent.appendChild(link);
}

function fillTrendingCard(card, token) {
  const metrics = token.metrics || {};
  const mint = externalMint(token.tokenAddress);
  const icon = typeof safeHttpsUrl === 'function' ? safeHttpsUrl(token.icon) : '';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;gap:8px;align-items:center;';
  const dex = document.createElement('span');
  dex.style.cssText = 'font-family:monospace;font-size:9.5px;color:#64748b;text-transform:uppercase;';
  dex.textContent = String(metrics.dexId || 'Pump.fun');
  const socials = document.createElement('button');
  socials.type = 'button';
  socials.textContent = 'Socials';
  socials.style.cssText = 'background:none;border:1px solid rgba(0,212,255,0.25);color:#00d4ff;font-size:9.5px;border-radius:4px;padding:2px 6px;cursor:pointer;';
  socials.addEventListener('click', () => { if (mint) inspectAndPopupSocials(mint); });
  head.append(dex, socials);

  const identity = document.createElement('div');
  identity.style.cssText = 'display:flex;gap:8px;align-items:center;';
  const imgWrap = document.createElement('div');
  imgWrap.style.cssText = 'width:40px;height:40px;border-radius:8px;overflow:hidden;background:#090d16;border:1px solid #192235;display:flex;align-items:center;justify-content:center;color:#64748b;';
  if (icon) {
    const img = document.createElement('img');
    img.src = icon;
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    imgWrap.appendChild(img);
  } else {
    imgWrap.textContent = '◎';
  }
  const titles = document.createElement('div');
  const name = document.createElement('h4');
  name.className = 'font-bold text-xs text-slate-100 truncate';
  name.textContent = String(token.name || 'Unknown');
  const symbol = document.createElement('span');
  symbol.className = 'text-[11px] font-mono font-bold text-cyan-400 block';
  symbol.textContent = String(token.symbol || '');
  titles.append(name, symbol);
  identity.append(imgWrap, titles);

  const caRow = document.createElement('div');
  caRow.style.cssText = 'display:flex;justify-content:space-between;gap:6px;background:#060810;padding:3px 7px;border-radius:4px;border:1px solid #161f33;font-size:9.5px;font-family:monospace;';
  const caText = document.createElement('span');
  caText.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  caText.textContent = mint || 'Invalid address';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.style.cssText = 'background:none;border:none;color:#00d4ff;cursor:pointer;font-size:9.5px;';
  copy.addEventListener('click', () => copyToClipboard(mint, (token.symbol || 'token') + ' CA'));
  caRow.append(caText, copy);

  const desc = document.createElement('p');
  desc.className = 'text-[10px] text-slate-400 line-clamp-2';
  desc.textContent = String(token.description || 'No description provided.');

  const stats = document.createElement('div');
  stats.className = 'text-[9px] font-mono bg-[#090d16] p-1.5 rounded border border-[#192235]';
  const mcapText = token.mcapUnknown || metrics.mcap == null ? 'MCap unknown' : ('MCap $' + Number(metrics.mcap).toLocaleString());
  stats.textContent = mcapText + '   24h $' + Number(metrics.volume24h || 0).toLocaleString();

  const links = document.createElement('div');
  links.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  addHttpsLink(links, token.twitter || (token.socials && token.socials.twitter), 'Twitter');
  addHttpsLink(links, token.telegram || (token.socials && token.socials.telegram), 'Telegram');
  addHttpsLink(links, token.website || (token.socials && token.socials.website), 'Website');

  const actions = document.createElement('div');
  actions.className = 'flex gap-1.5 pt-1';
  const vamp = document.createElement('button');
  vamp.type = 'button';
  vamp.className = 'btn-primary text-[10px] flex-1 py-1';
  vamp.textContent = 'Vamp This';
  vamp.addEventListener('click', () => { if (mint) vampDirect(mint); });
  const spin = document.createElement('button');
  spin.type = 'button';
  spin.className = 'btn-secondary text-[10px] flex-1 py-1';
  spin.textContent = '2.0 Spin';
  spin.addEventListener('click', () => { if (mint) vampMutate2(mint); });
  actions.append(vamp, spin);
  card.append(head, identity, caRow, desc, stats, links, actions);
}

// ==================== VAMP CLONER AUXILIARIES ====================

async function loadTrendingVampTokens() {
  const container = document.getElementById('vampTokensGrid');
  if (container) {
    container.innerHTML = `<div class="col-span-full py-8 text-center text-xs text-slate-500 font-mono">Fetching trending tokens from DexScreener & Pump.fun...</div>`;
  }

  try {
    const params = new URLSearchParams();
    const filtering = state.vampMinMcap > 0 || state.vampMaxMcap > 0 || state.vampMinAge > 0 || state.vampMaxAge > 0 || state.vampMinVolume > 0 || state.vampMinLiquidity > 0;
    if (filtering) params.set('limit', '50');
    if (state.vampMinMcap > 0) params.set('minMcap', String(state.vampMinMcap));
    if (state.vampMaxMcap > 0) params.set('maxMcap', String(state.vampMaxMcap));
    if (ageInputToMs(state.vampMinAge) > 0) params.set('minAgeMs', String(ageInputToMs(state.vampMinAge)));
    if (ageInputToMs(state.vampMaxAge) > 0) params.set('maxAgeMs', String(ageInputToMs(state.vampMaxAge)));
    if (state.vampMinVolume > 0) params.set('minVolume', String(state.vampMinVolume));
    if (state.vampMinLiquidity > 0) params.set('minLiquidity', String(state.vampMinLiquidity));
    params.set('sort', effectiveVampSort());
    if (state.vampShowUnknown) params.set('showUnknown', '1');
    const query = params.toString();
    const res = await apiFetch(`/api/vamp/trending${query ? `?${query}` : ''}`);
    const data = await res.json();
    state.trendingTokens = data.tokens || [];
    const hiddenEl = document.getElementById('vampHiddenCount');
    if (hiddenEl) hiddenEl.textContent = Number(data.hidden) > 0 ? `${data.hidden} hidden by filters` : '';
    const summaryEl = document.getElementById('vampScanSummary');
    if (summaryEl) {
      const scanned = Number(data.scanned) || 0;
      const sources = Number(data.sources) || 0;
      const matched = Number(data.matched) || 0;
      const floor = Number(state.vampMinMcap) || 0;
      const cap = Number(state.vampMaxMcap) || 0;
      const minText = `$${floor.toLocaleString()}`;
      const maxText = cap > 0 ? `$${cap.toLocaleString()}` : 'any';
      summaryEl.textContent = `Scanned ${scanned} candidates from ${sources} sources · ${matched} match ${minText}–${maxText}`;
      summaryEl.style.fontSize = '10px';
      summaryEl.style.color = '#94a3b8';
    }

    // Render Top Movers on Dashboard
    renderTopMovers(state.trendingTokens);

    if (container) {
      container.innerHTML = '';
      (data.tokens || []).forEach(t => {
        const card = document.createElement('div');
        card.className = 'bento-card p-3 space-y-2 hover:border-cyan-500/50 transition-all';
        const m = t.metrics || {};
        const twitter = t.twitter || t.socials?.twitter || '';
        const telegram = t.telegram || t.socials?.telegram || '';
        const website = t.website || t.socials?.website || '';
        const hasSocials = !!(twitter || telegram || website);
        const socialCount = [twitter, telegram, website].filter(Boolean).length;

        fillTrendingCard(card, t);
        if (t.mcapUnknown) card.style.opacity = '0.55';
        container.appendChild(card);
      });
    }

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    if (container) {
      const fail = document.createElement('div');
      fail.className = 'col-span-full py-8 text-center text-xs text-rose-400';
      fail.textContent = 'Failed to load trending tokens: ' + err.message;
      container.replaceChildren(fail);
    }
  }
}

function renderTopMovers(tokens) {
  const panel = document.getElementById('topMoversPanel');
  if (!panel) return;

  const list = (tokens && tokens.length > 0) ? tokens : (state.trendingTokens || []);
  if (list.length === 0) {
    panel.innerHTML = `<div style="font-size:11px;color:#546e7a;text-align:center;padding:14px 0;">Scanning top Solana movers...</div>`;
    return;
  }

  // Sort by 24h price change percentage
  const sorted = [...list].sort((a, b) => {
    const chgA = parseFloat(a.metrics?.priceChange24h || 0);
    const chgB = parseFloat(b.metrics?.priceChange24h || 0);
    return chgB - chgA;
  }).slice(0, 5);

  panel.innerHTML = '';
  sorted.forEach(t => {
    const m = t.metrics || {};
    const parsedChange = m.priceChange24h == null || m.priceChange24h === '' ? null : parseFloat(m.priceChange24h);
    const change = Number.isFinite(parsedChange) ? parsedChange : null;
    const isUp = change != null && change >= 0;
    const color = isUp ? '#00c48c' : '#f04c5e';
    const bgSoft = isUp ? 'rgba(0,196,140,0.1)' : 'rgba(240,76,94,0.1)';
    const symbol = t.symbol || 'TOKEN';
    const name = t.name || t.tokenAddress?.slice(0, 6) || 'Meme';
    const price = Number(m.priceUsd) > 0 ? ('$' + (Number(m.priceUsd) < 0.001 ? Number(m.priceUsd).toFixed(6) : Number(m.priceUsd).toFixed(4))) : '—';
    const mcap = Number(m.mcap) > 0 ? ('$' + Math.round(Number(m.mcap)).toLocaleString()) : '—';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border-radius:6px;transition:all 0.15s;cursor:pointer;background:#090d17;border:1px solid #1a2338;gap:8px;';
    row.title = `Click to load and track ${symbol}`;
    row.onmouseenter = () => {
      row.style.background = '#0d1222';
      row.style.borderColor = '#00d4ff';
    };
    row.onmouseleave = () => {
      row.style.background = '#090d17';
      row.style.borderColor = '#1a2338';
    };
    row.onclick = () => {
      const mint = externalMint(t.tokenAddress);
      if (!mint) return;
      document.getElementById('navTrackCaInput').value = mint;
      setChartSymbol(String(symbol || ''));
      setTrackedTokenFromNav();
    };

    const icon = typeof safeHttpsUrl === 'function' ? safeHttpsUrl(t.icon) : '';
    const mint = externalMint(t.tokenAddress);
    const left = document.createElement('div');
    left.style.cssText = 'display:flex;align-items:center;gap:7px;min-width:0;overflow:hidden;';
    const badge = document.createElement('div');
    badge.style.cssText = 'width:22px;height:22px;border-radius:5px;background:#111827;border:1px solid #1a2338;overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:8.5px;font-weight:800;color:#00d4ff;';
    if (icon) {
      const img = document.createElement('img');
      img.src = icon;
      img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      badge.appendChild(img);
    } else {
      badge.textContent = String(symbol).slice(0, 2);
    }
    const meta = document.createElement('div');
    const title = document.createElement('div');
    title.style.cssText = 'font-size:11px;font-weight:800;color:#00d4ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    title.textContent = String(symbol) + '  ' + String(name);
    if (t.devBlacklisted) {
      const flag = document.createElement('span');
      flag.textContent = 'DEV BLACKLIST';
      flag.style.cssText = 'font-size:8px;font-weight:800;color:#fda4af;background:rgba(240,76,94,0.15);border:1px solid rgba(240,76,94,0.4);border-radius:4px;padding:1px 4px;margin-left:4px;';
      title.append(' ', flag);
    }
    const cap = document.createElement('div');
    cap.style.cssText = 'font-size:9px;color:#78909c;font-family:monospace;';
    cap.textContent = mcap;
    meta.append(title, cap);
    left.append(badge, meta);
    const right = document.createElement('div');
    right.style.cssText = 'text-align:right;flex-shrink:0;';
    const priceEl = document.createElement('div');
    priceEl.style.cssText = 'font-size:10px;font-weight:700;font-family:monospace;color:#cfd8dc;';
    priceEl.textContent = price;
    const changeRow = document.createElement('div');
    changeRow.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:4px;';
    const changeEl = document.createElement('span');
    changeEl.style.cssText = 'font-size:8.5px;font-weight:800;font-family:monospace;padding:1px 4px;border-radius:4px;background:' + bgSoft + ';color:' + color + ';';
    changeEl.textContent = change == null ? '—' : ((isUp ? '▲ +' : '▼ ') + Number(change).toFixed(1) + '%');
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.style.cssText = 'background:none;border:none;color:#78909c;cursor:pointer;font-size:9px;';
    copyBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      copyToClipboard(mint, String(symbol) + ' CA');
    });
    changeRow.append(changeEl, copyBtn);
    right.append(priceEl, changeRow);
    row.append(left, right);
        panel.appendChild(row);
  });
}
window.renderTopMovers = renderTopMovers;

// ==================== SOCIALS & TOKEN POPUP INSPECT ====================

async function inspectAndPopupSocials(address) {
  const modal = document.getElementById('socialInspectModal');
  const body = document.getElementById('socialInspectModalBody');
  if (!modal || !body) return;
  const mint = externalMint(address);
  modal.style.display = 'flex';
  body.replaceChildren();
  const loading = document.createElement('div');
  loading.style.cssText = 'padding:28px 0;text-align:center;font-size:11px;font-family:monospace;color:#78909c;';
  loading.textContent = 'Fetching metadata for ' + (mint ? mint.slice(0, 8) : 'an invalid address') + '...';
  body.appendChild(loading);
  if (!mint) return;

  try {
    const res = await apiFetch('/api/vamp/inspect/' + encodeURIComponent(mint));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Inspect failed');
    const token = data.token || {};
    body.replaceChildren();
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;gap:12px;align-items:center;margin-bottom:12px;';
    const iconWrap = document.createElement('div');
    iconWrap.style.cssText = 'width:48px;height:48px;border-radius:8px;background:#090d16;border:1px solid #1a253d;overflow:hidden;display:flex;align-items:center;justify-content:center;';
    const icon = typeof safeHttpsUrl === 'function' ? safeHttpsUrl(token.icon) : '';
    if (icon) {
      const img = document.createElement('img');
      img.src = icon;
      img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      iconWrap.appendChild(img);
    }
    const titles = document.createElement('div');
    const name = document.createElement('h3');
    name.style.cssText = 'font-size:14px;font-weight:800;color:#f1f5f9;margin:0 0 2px;';
    name.textContent = String(token.name || 'Unknown');
    const symbol = document.createElement('div');
    symbol.style.cssText = 'font-size:11.5px;font-weight:800;font-family:monospace;color:#00d4ff;';
    symbol.textContent = String(token.symbol || 'TOKEN') + '   MCap $' + Number(token.marketCap || 0).toLocaleString();
    titles.append(name, symbol);
    top.append(iconWrap, titles);

    const ca = document.createElement('div');
    ca.style.cssText = 'background:#090d16;padding:6px 9px;border-radius:6px;border:1px solid #1a253d;display:flex;justify-content:space-between;gap:8px;margin-bottom:12px;font-family:monospace;font-size:10.5px;';
    const caText = document.createElement('span');
    caText.textContent = mint;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.style.cssText = 'background:none;border:none;color:#00d4ff;cursor:pointer;font-size:10px;font-weight:700;';
    copy.addEventListener('click', () => copyToClipboard(mint, 'CA'));
    ca.append(caText, copy);

    const links = document.createElement('div');
    links.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;';
    addHttpsLink(links, token.twitter || (token.socials && token.socials.twitter), 'Twitter');
    addHttpsLink(links, token.telegram || (token.socials && token.socials.telegram), 'Telegram');
    addHttpsLink(links, token.website || (token.socials && token.socials.website), 'Website');
    if (!links.childNodes.length) {
      const none = document.createElement('div');
      none.style.cssText = 'font-size:11px;color:#64748b;';
      none.textContent = 'No https social links on this coin.';
      links.appendChild(none);
    }

    const description = document.createElement('div');
    description.style.cssText = 'background:#090d16;padding:8px 10px;border-radius:6px;border:1px solid #1a253d;font-size:10.5px;color:#94a3b8;max-height:80px;overflow-y:auto;margin-bottom:14px;';
    description.textContent = String(token.description || 'No description provided.');

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;';
    const vamp = document.createElement('button');
    vamp.type = 'button';
    vamp.className = 'btn-primary';
    vamp.style.cssText = 'flex:1;padding:8px;font-size:11px;font-weight:700;';
    vamp.textContent = 'Vamp into Launchpad';
    vamp.addEventListener('click', () => { closeSocialInspectModal(); vampDirect(mint); });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-secondary';
    close.style.cssText = 'padding:8px 14px;font-size:11px;';
    close.textContent = 'Close';
    close.addEventListener('click', () => closeSocialInspectModal());
    actions.append(vamp, close);
    body.append(top, ca, links, description, actions);
  } catch (err) {
    body.replaceChildren();
    const fail = document.createElement('div');
    fail.style.cssText = 'color:#f04c5e;font-size:11px;padding:12px;text-align:center;';
    fail.textContent = 'Failed to inspect socials: ' + err.message;
    body.appendChild(fail);
  }
}
window.inspectAndPopupSocials = inspectAndPopupSocials;

function closeSocialInspectModal() {
  const modal = document.getElementById('socialInspectModal');
  if (modal) modal.style.display = 'none';
}
window.closeSocialInspectModal = closeSocialInspectModal;

async function inspectCustomVampCa() {
  const raw = document.getElementById('vampCaInput').value.trim();
  const ca = extractSolanaAddress(raw);
  if (!ca) return showToast('Please enter a Solana CA or Pump.fun link', 'warning');
  document.getElementById('vampCaInput').value = ca;
  try {
    const res = await apiFetch(`/api/vamp/inspect/${ca}`);
    const data = await res.json();
    if (data.token) {
      applyVampToLaunchpad(data.token);
      showToast(`Loaded ${data.token.symbol} into Launchpad`, 'success');
      switchTab('launchpad');
    }
  } catch (e) {
    showToast('Failed to inspect CA: ' + e.message, 'error');
  }
}

async function vampDirect(address) {
  try {
    const res = await apiFetch(`/api/vamp/inspect/${address}`);
    const data = await res.json();
    applyVampToLaunchpad(data.token);
    showToast(`Vamped ${data.token.symbol}! Ready in Launchpad`, 'success');
    switchTab('launchpad');
  } catch (e) {
    showToast('Failed to vamp token: ' + e.message, 'error');
  }
}

async function vampMutate2(address) {
  try {
    const res = await apiFetch(`/api/vamp/inspect/${address}`);
    const data = await res.json();
    const mutateRes = await apiFetch('/api/vamp/mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenData: data.token, mode: 'v2' })
    });
    const mutated = await mutateRes.json();
    applyVampToLaunchpad(mutated.mutated);
    showToast(`Spawned ${mutated.mutated.symbol} 2.0 in Launchpad!`, 'success');
    switchTab('launchpad');
  } catch (e) {
    showToast('Failed to spin 2.0: ' + e.message, 'error');
  }
}

function copyToClipboard(text, label = 'CA') {
  if (!text) return showToast('No address to copy', 'warning');
  const clean = extractSolanaAddress(text) || text;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(clean).then(() => {
      showToast(`Copied ${label} to clipboard!`, 'info');
    }).catch(() => fallbackCopyText(clean, label));
  } else {
    fallbackCopyText(clean, label);
  }
}
window.copyToClipboard = copyToClipboard;

function fallbackCopyText(text, label) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(`Copied ${label} to clipboard!`, 'info');
  } catch(e) {
    showToast('Failed to copy', 'error');
  }
}

async function inspectCustomVampCaFromLaunchpad() {
  const raw = document.getElementById('launchpadVampedCa').value.trim();
  const ca = extractSolanaAddress(raw);
  if (!ca) return showToast('Please enter a Solana CA or Pump.fun URL', 'warning');
  document.getElementById('launchpadVampedCa').value = ca;
  try {
    const res = await apiFetch(`/api/vamp/inspect/${ca}`);
    const data = await res.json();
    if (data.token) {
      applyVampToLaunchpad(data.token);
      showToast(`Vamped ${data.token.symbol}! Ready in Launchpad`, 'success');
    }
  } catch (e) {
    showToast('Failed to inspect token: ' + e.message, 'error');
  }
}
window.inspectCustomVampCaFromLaunchpad = inspectCustomVampCaFromLaunchpad;

function captureLaunchDraft(el) {
  if (!state.launchDraft || !el) return;
  const map = {
    tokenName: 'name',
    tokenSymbol: 'symbol',
    tokenDescription: 'description',
    tokenTwitter: 'twitter',
    tokenTelegram: 'telegram',
    tokenWebsite: 'website'
  };
  const key = map[el.id];
  if (!key) return;
  state.launchDraft[key] = el.value;
  try { localStorage.setItem('launchDraft', JSON.stringify(state.launchDraft)); } catch (err) { /* storage can be blocked */ }
}

function paintLaunchDraft() {
  const draft = state.launchDraft;
  if (!draft) return;
  const write = (id, value) => {
    const el = document.getElementById(id);
    if (!el || document.activeElement === el) return;
    el.value = value == null ? '' : String(value);
  };
  write('tokenName', draft.name);
  write('tokenSymbol', draft.symbol);
  write('tokenDescription', draft.description);
  write('tokenTwitter', draft.twitter);
  write('tokenTelegram', draft.telegram);
  write('tokenWebsite', draft.website);
  const note = document.getElementById('logoMissingNote');
  if (note) {
    const missing = Array.isArray(draft.missing) ? draft.missing : [];
    note.textContent = missing.includes('logo') ? 'logo not found' : (missing.length ? `${missing.join(', ')} not found` : '');
    note.style.display = note.textContent ? 'block' : 'none';
    note.style.color = '#fbbf24';
    note.style.fontSize = '10px';
  }
  if (state.logoFile) return;
  const iconUrl = typeof safeHttpsUrl === 'function' ? safeHttpsUrl(draft.icon || '') : '';
  state.vampedImageUrl = iconUrl || null;
  const preview = document.getElementById('logoPreview');
  const placeholder = document.getElementById('logoIconPlaceholder');
  if (preview) {
    preview.src = iconUrl || '';
    preview.style.display = iconUrl ? 'block' : 'none';
  }
  if (placeholder) placeholder.style.display = iconUrl ? 'none' : 'block';
}

function applyVampToLaunchpad(token) {
  if (!token) return;
  const iconUrl = typeof safeHttpsUrl === 'function' ? safeHttpsUrl(token.icon || token.imageUrl || token.image || '') : '';
  state.logoFile = null;
  const linkOf = (needles) => (token.links || []).find(link => needles.some(needle => (link.url || '').includes(needle)));
  state.launchDraft = {
    name: token.name || '',
    symbol: token.symbol || '',
    description: token.description || '',
    twitter: token.twitter || (token.socials && token.socials.twitter) || (linkOf(['x.com', 'twitter']) || {}).url || '',
    telegram: token.telegram || (token.socials && token.socials.telegram) || (linkOf(['t.me']) || {}).url || '',
    website: token.website || (token.socials && token.socials.website) || '',
    icon: iconUrl,
    missing: Array.isArray(token.missing) ? token.missing : (iconUrl ? [] : ['logo'])
  };
  try { localStorage.setItem('launchDraft', JSON.stringify(state.launchDraft)); } catch (err) { /* storage can be blocked */ }

  // 1. Name, Symbol & Description
  document.getElementById('tokenName').value = state.launchDraft.name;
  document.getElementById('tokenSymbol').value = state.launchDraft.symbol;
  document.getElementById('tokenDescription').value = state.launchDraft.description;

  // 2. Source / Vamped Token CA window
  const ca = externalMint(token.address || token.tokenAddress || '');
  const caInput = document.getElementById('launchpadVampedCa');
  if (caInput) caInput.value = ca;
  const pumpLink = document.getElementById('launchpadPumpLink');
  if (pumpLink && ca) {
    pumpLink.href = `https://pump.fun/coin/${ca}`;
    pumpLink.style.display = 'inline-block';
  }

  document.getElementById('tokenTwitter').value = state.launchDraft.twitter;
  document.getElementById('tokenTelegram').value = state.launchDraft.telegram;
  document.getElementById('tokenWebsite').value = state.launchDraft.website;
  paintLaunchDraft();
}

function handleLogoSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  state.logoFile = file;
  state.vampedImageUrl = null;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const preview = document.getElementById('logoPreview');
    const placeholder = document.getElementById('logoIconPlaceholder');
    if (preview) {
      preview.src = ev.target.result;
      preview.style.display = 'block';
    }
    if (placeholder) {
      placeholder.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
}

function paintBumper(payload, running) {
  const badge = document.getElementById('bumperActiveBadge');
  const cycles = document.getElementById('bumperCycles');
  const volume = document.getElementById('bumperVolume');
  const last = document.getElementById('bumperLast');
  const net = document.getElementById('bumperNet');
  if (cycles) cycles.textContent = String(payload.cycles || 0);
  if (volume) volume.textContent = Number(payload.volumeSol || 0).toFixed(4);
  if (net) net.textContent = Number(payload.netSolCost || 0).toFixed(4);
  const session = document.getElementById('bumperSession');
  if (session && payload.sessionSpentSol != null) {
    const cap = Number(payload.sessionCapSol) > 0 ? ` / ${Number(payload.sessionCapSol).toFixed(2)}` : '';
    session.textContent = `${Number(payload.sessionSpentSol).toFixed(4)}${cap}`;
  }
  if (last) {
    const tx = payload.lastTx ? ` · ${payload.lastTx.slice(0, 8)}…` : '';
    last.textContent = `${payload.lastError || payload.lastAction || (running ? 'Running' : 'Idle')}${payload.lastError ? '' : tx}`;
    last.style.color = payload.lastError ? '#fb7185' : '#cbd5e1';
  }
  if (!badge) return;
  const active = running !== false && !payload.stopped;
  badge.textContent = active ? 'BUMPING ACTIVE' : 'STOPPED';
  badge.className = active
    ? 'text-[10px] px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono font-bold animate-pulse'
    : 'text-[10px] px-1.5 py-0.2 rounded bg-[#131a29] text-slate-400 font-mono';
}

function logBumpTick(payload) {
  const wallet = payload.wallet ? `${payload.wallet.slice(0, 4)}...${payload.wallet.slice(-4)}` : 'wallet';
  if (payload.error) {
    logTerminal(`[Bump] ${payload.lastAction || 'Cycle failed'}: ${payload.error}`);
    showToast(`Bump failed: ${payload.error}`, 'error');
    return;
  }
  const mode = payload.simulated ? 'SIM' : 'LIVE';
  logTerminal(`[Bump] ${mode} cycle ${payload.cycles}: ${payload.lastAction || 'trade'} via ${wallet}. Volume ${Number(payload.volumeSol || 0).toFixed(4)} SOL, net ${Number(payload.netSolCost || 0).toFixed(4)} SOL`);
  const rows = (payload.actions || []).flatMap(action => (action.result && action.result.results) || []);
  rows.forEach(row => {
    if (row && row.txSignature) logTerminal(`[Bump] Confirmed https://solscan.io/tx/${row.txSignature}`);
  });
}

async function toggleVolumeBumper(start) {
  try {
    if (start) {
      const num = (id, fallback) => {
        const raw = document.getElementById(id);
        const value = raw ? parseFloat(raw.value) : fallback;
        return Number.isFinite(value) ? value : fallback;
      };
      const solAmount = num('bumpAmountInput', 0.01);
      const res = await apiFetch('/api/trading/bumper/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          solAmount,
          strategy: (document.getElementById('bumpStrategyInput') || {}).value || 'random',
          maxOpen: num('bumpMaxOpenInput', 4),
          maxPerTrade: num('bumpMaxTradeInput', 0.01),
          sessionBudget: num('bumpBudgetInput', 0.05),
          maxCycles: num('bumpMaxCyclesInput', 10),
          reserveSol: num('bumpReserveInput', 0.02),
          minDelaySeconds: num('bumpMinDelayInput', 3),
          maxDelaySeconds: num('bumpMaxDelayInput', 10),
          maxErrors: num('bumpMaxErrorsInput', 3)
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || 'Volume bumper did not start');
      paintBumper(data, true);
      showToast(data.simulated ? 'Volume bumper started in simulation' : 'Volume bumper started. Live round trips are capped.', 'success');
    } else {
      const res = await apiFetch('/api/trading/bumper/stop', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || 'Volume bumper did not stop');
      paintBumper(data, false);
      showToast('Volume bumper stopped', 'info');
    }
  } catch (err) {
    const last = document.getElementById('bumperLast');
    if (last) {
      last.textContent = err.message;
      last.style.color = '#fb7185';
    }
    logTerminal(`[Bump] ${err.message}`);
    showToast('Bumper error: ' + err.message, 'error');
  }
}

function logTerminal(message) {
  const term = document.getElementById('terminalLogs');
  if (!term) return;
  const div = document.createElement('div');
  const time = document.createElement('span');
  time.className = 'text-slate-500';
  time.textContent = `[${new Date().toLocaleTimeString()}] `;
  const body = document.createElement('span');
  body.textContent = String(message);
  div.append(time, body);
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
}

function clearTerminalLogs() {
  const term = document.getElementById('terminalLogs');
  if (term) term.innerHTML = `<div class="text-slate-500">[System] Logs cleared.</div>`;
}

function showToast(text, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const colors = {
    info: 'border-cyan-500/40 bg-[#0f1420]/95 text-cyan-300',
    success: 'border-emerald-500/40 bg-[#0f1420]/95 text-emerald-300',
    warning: 'border-amber-500/40 bg-[#0f1420]/95 text-amber-300',
    error: 'border-rose-500/40 bg-[#0f1420]/95 text-rose-300'
  };

  const toast = document.createElement('div');
  toast.className = `p-2.5 rounded-lg border shadow-xl text-xs font-semibold backdrop-blur pointer-events-auto transition-all duration-300 opacity-0 translate-y-2 ${colors[type] || colors.info}`;
  toast.innerText = text;

  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove('opacity-0', 'translate-y-2');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ==================== RENT & CREATOR REWARDS RECLAMATION ====================

async function reclaimRentAndRewards() {
  const mint = state.activeToken || (document.getElementById('chartManualCaInput')?.value.trim()) || '';
  logTerminal(`🧹 [Rent & Rewards] Scanning 0-balance token accounts to reclaim SOL rent and creator rewards...`);
  showToast('Scanning token accounts for rent reclamation...', 'info');

  try {
    const res = await apiFetch('/api/wallets/reclaim-rent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mint })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to reclaim rent');
    }

    logTerminal(`✨ [Rent Reclaimed] Success! Closed ${data.closedCount} token accounts, recovered +${data.reclaimedSol} SOL rent + ${data.creatorRewardsSol} SOL Pump.fun rewards to Master (${data.masterAddress ? data.masterAddress.slice(0, 8) + '...' : ''})`);
    showToast(`Reclaimed +${data.totalReclaimedSol} SOL to Master Wallet!`, 'success');
    loadMasterWallet();
    loadSubWallets();
    loadLiveStats();
  } catch (err) {
    logTerminal(`❌ [Rent Reclaim Error] ${err.message}`);
    showToast('Rent claim: ' + err.message, 'error');
  }
}

// ==================== LIVE PUBLIC TRADE STREAM ====================

function priceFromTrade(trade) {
  const supply = 1000000000;
  const mcap = Number(trade.marketCapSol);
  if (Number.isFinite(mcap) && mcap > 0) return mcap / supply;
  const sol = Number(trade.solAmount);
  const tokens = Number(trade.tokenAmount);
  if (sol > 0 && tokens > 0) return sol / tokens;
  return null;
}

function renderTradeTape(trades) {
  clearLiveTradeTape();
  (trades || []).forEach((trade) => {
    renderTradeTick(Object.assign({}, trade, { _replay: true }));
  });
}

function applyPublicTradePrice(trade, mint) {
  if (!mint) return;
  const tradePrice = ChartBook.publicTradePrice(trade);
  if (!(tradePrice > 0)) return;
  noteChartScale(mint, trade);
  const epoch = mint === state.chartToken ? state.chartEpoch : null;
  pushChartTick(tradePrice, trade.priceOnly ? 0 : (Number(trade.solAmount) || 0), epoch, mint);
  if (trade.priceOnly) state.lastChartTickAt = Date.now();
}

function tradeIsOwn(trade) {
  if (!trade) return false;
  if (trade.own) return true;
  const who = String(trade.traderPublicKey || trade.user || '');
  if (!who) return false;
  if (state.masterWallet && who === state.masterWallet.address) return true;
  return (state.subWallets || []).some(row => row.address === who);
}

function ownMarkerLabel(trade) {
  if (trade && trade.label) return String(trade.label);
  const who = state.masterWallet && trade && trade.traderPublicKey === state.masterWallet.address ? 'DEV' : 'BOT';
  const side = trade && trade.txType === 'sell' ? 'SELL' : 'BUY';
  return `${who} ${side} ${Number(trade && trade.solAmount || 0).toFixed(4)}`;
}

function visibleTradeMarkers() {
  const series = state.chartToken ? chartBook.peek(state.chartToken) : null;
  const tfMs = TIMEFRAME_MS[state.chartTimeframe] || 5000;
  const prepared = ((series && series.trades) || []).map(trade => {
    const own = tradeIsOwn(trade);
    return Object.assign({}, trade, { own, label: own ? ownMarkerLabel(trade) : '' });
  });
  return ChartBook.buildMarkers(prepared, { tfMs, minSol: ChartBook.MIN_PUBLIC_SOL });
}

function drawTradeMarkers(ctx, view) {
  const markers = visibleTradeMarkers();
  if (!markers.length || !view.candles.length) return;
  const index = new Map();
  view.candles.forEach((candle, i) => index.set(candle.time, i));
  const stacks = new Map();
  markers.forEach(marker => {
    const slot = index.get(marker.bucket);
    if (slot == null) return;
    const key = `${slot}:${marker.txType}:${marker.own ? 'own' : 'pub'}`;
    const n = stacks.get(key) || 0;
    stacks.set(key, n + 1);
    const candle = view.candles[slot];
    const cx = slot * view.slotW + (view.slotW / 2);
    const anchor = marker.txType === 'sell' ? candle.high : candle.low;
    const y = 15 + ((view.maxP - anchor) / view.effectiveRange) * view.priceHeight;
    const shift = n * (marker.own ? 14 : 8);
    const tip = marker.txType === 'sell' ? y - 8 - shift : y + 8 + shift;
    const size = marker.own ? 7 : 4;
    ctx.beginPath();
    if (marker.txType === 'buy') {
      ctx.moveTo(cx, tip + size);
      ctx.lineTo(cx - size, tip - size);
      ctx.lineTo(cx + size, tip - size);
    } else {
      ctx.moveTo(cx, tip - size);
      ctx.lineTo(cx - size, tip + size);
      ctx.lineTo(cx + size, tip + size);
    }
    ctx.closePath();
    ctx.fillStyle = marker.own
      ? (marker.txType === 'buy' ? '#fbbf24' : '#fb7185')
      : (marker.txType === 'buy' ? '#34d399' : '#f87171');
    ctx.fill();
    if (marker.own && marker.label) {
      ctx.font = 'bold 9px JetBrains Mono, monospace';
      const width = ctx.measureText(marker.label).width + 8;
      const boxY = marker.txType === 'sell' ? tip - 16 : tip + 4;
      ctx.fillStyle = 'rgba(8, 12, 22, 0.92)';
      ctx.fillRect(cx - width / 2, boxY, width, 13);
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(marker.label, cx - width / 2 + 4, boxY + 10);
    }
  });
}

function renderTradeTick(trade) {
  if (!trade) return;
  const mint = trade.mint || null;
  if (trade.priceOnly) {
    if (mint) applyPublicTradePrice(trade, mint);
    return;
  }
  if (!trade._replay) {
    if (state.chartToken && (!mint || mint !== state.chartToken)) {
      if (mint) {
        chartBook.pushTrade(mint, trade);
        applyPublicTradePrice(trade, mint);
      }
      return;
    }
    if (mint) chartBook.pushTrade(mint, trade);
  }
  const isBuy = trade.txType === 'buy';
  const color = isBuy ? '#00c48c' : '#f04c5e';
  const badgeBg = isBuy ? 'rgba(0,196,140,0.12)' : 'rgba(240,76,94,0.12)';
  const borderCol = isBuy ? 'rgba(0,196,140,0.3)' : 'rgba(240,76,94,0.3)';
  const timeStr = new Date(trade.timestamp || Date.now()).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const traderShort = (trade.traderPublicKey || 'anon').slice(0, 4) + '..' + (trade.traderPublicKey || 'anon').slice(-4);
  const solFormatted = (trade.solAmount || 0).toFixed(trade.solAmount >= 1 ? 2 : 3);

  // 1. Chart bar chip
  const chartBar = document.getElementById('chartLiveTradesBar');
  if (chartBar) {
    // If it currently shows the placeholder text, clear it
    if (chartBar.innerText.includes('Streaming live trades')) {
      chartBar.innerHTML = '';
    }
    const chip = document.createElement('div');
    chip.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:4px;background:${badgeBg};border:1px solid ${borderCol};font-size:10px;flex-shrink:0;`;
    chip.innerHTML = `
      <strong style="color:${color};font-weight:800;">${isBuy ? '▲ BUY' : '▼ SELL'}</strong>
      <span style="color:#e2e8f0;font-weight:700;">${escapeHtml(solFormatted)} SOL</span>
      <span style="color:#64748b;font-size:9.5px;">(${escapeHtml(traderShort)})</span>
    `;
    chartBar.prepend(chip);
    while (chartBar.children.length > 12) {
      chartBar.removeChild(chartBar.lastChild);
    }
  }

  // 2. Tx Tape Panel row (Recent Transactions below desk)
  const tapePanel = document.getElementById('txTapePanel');
  if (tapePanel) {
    // If placeholder
    if (tapePanel.innerText.includes('No transactions yet')) {
      tapePanel.innerHTML = '';
    }
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid #161b2e;font-size:11px;font-family:'JetBrains Mono',monospace;`;
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="color:#64748b;font-size:10px;">${timeStr}</span>
        <span style="display:inline-block;padding:1px 5px;border-radius:3px;font-size:9.5px;font-weight:800;background:${badgeBg};color:${color};border:1px solid ${borderCol};">
          ${isBuy ? 'BUY' : 'SELL'}
        </span>
        <span style="color:#e2e8f0;font-weight:600;">${solFormatted} SOL</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="color:#94a3b8;font-size:10px;">${escapeHtml(Number(trade.tokenAmount) || 0)} tokens</span>
        ${externalMint(trade.traderPublicKey) ? `<a href="https://solscan.io/account/${externalMint(trade.traderPublicKey)}" target="_blank" rel="noopener noreferrer" style="color:#00d4ff;font-size:10px;text-decoration:none;">${escapeHtml(traderShort)}</a>` : `<span style="color:#00d4ff;font-size:10px;">${escapeHtml(traderShort)}</span>`}
      </div>
    `;
    tapePanel.prepend(row);
    while (tapePanel.children.length > 30) {
      tapePanel.removeChild(tapePanel.lastChild);
    }
  }

  if (!trade._replay) applyPublicTradePrice(trade, mint || state.chartToken);
  if (!trade._replay && (!mint || mint === state.chartToken)) renderCandlestickChart();
}
