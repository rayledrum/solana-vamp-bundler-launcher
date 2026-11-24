// Institutional Solana Memecoin Bundler & Trading Terminal
const state = {
  currentTab: 'trading',
  simulationMode: true,
  currentSlot: null,
  masterWallet: null,
  subWallets: [],
  selectedJitoTip: 0.005,
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
  lastPrice: 0.000034,
  curveProgressPct: 0,
  hoverCandle: null,

  // Sub-wallet execution settings
  subWalletDelaySec: 0,
  trendingTokens: []
};

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();
  initChart();
  connectWebSocket();
  loadStatus();
  loadMasterWallet();
  loadSubWallets();
  loadTrendingVampTokens();
  loadLiveStats();

  // Periodic polling for stats & balances (every 3 seconds)
  setInterval(() => {
    loadLiveStats();
  }, 3000);
});

// ==================== REAL-TIME WEBSOCKET PIPELINE ====================

function connectWebSocket() {
  const isHttp = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = (isHttp && window.location.host) ? window.location.host : 'localhost:3000';
  const wsUrl = `${protocol}//${host}`;

  try {
    state.ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('WebSocket init error:', err);
    setTimeout(connectWebSocket, 3000);
    return;
  }

  state.ws.onopen = () => {
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
    logTerminal('[WebSocket] Connection closed. Reconnecting in 3s...');
    setTimeout(connectWebSocket, 3000);
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'HEARTBEAT':
      state.currentSlot = msg.payload.slot;
      document.getElementById('slotDisplay').innerText = `Slot: ${msg.payload.slot.toLocaleString()}`;
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
      applyDeskTradeTick(msg.payload.mint, msg.payload.totalSpentSol, (base) => base * (1 + (msg.payload.totalSpentSol * 0.05)));
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'SELL_EXECUTED':
      logTerminal(`🔴 [Manual Sell] Sold ${msg.payload.pct}% | Recv: +${msg.payload.totalReceivedSol} SOL`);
      showToast(`Sold ${msg.payload.pct}% across bundle (+${msg.payload.totalReceivedSol} SOL)`, 'warning');
      applyDeskTradeTick(msg.payload.mint, msg.payload.totalReceivedSol, (base) => base * (1 - (msg.payload.pct * 0.002)));
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'CASCADE_STEP':
      logTerminal(`🌊 [Cascade] Step ${msg.payload.step}/${msg.payload.total} executed for ${msg.payload.address.slice(0, 6)}...`);
      applyDeskTradeTick(msg.payload.mint, 0.2, (base) => base * 0.985);
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

    case 'BUMP_TICK':
      logTerminal(`⚡ [Bump Bot] Micro trade on ${msg.payload.wallet} (${msg.payload.solAmount} SOL)`);
      applyDeskTradeTick(msg.payload.mint, msg.payload.solAmount, (base) => base * (1 + (Math.random() * 0.02 - 0.01)));
      break;

    case 'TOKEN_TRACKED':
      state.activeToken = msg.payload.mint;
      updateActiveTokenUi(msg.payload.mint);
      loadLiveStats();
      break;

    case 'PUBLIC_TRADE':
      renderTradeTick(msg.payload);
      break;
  }
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
  if (Number.isFinite(series.lastPrice)) state.lastPrice = series.lastPrice;
}

function priceBaseFor(mint) {
  if (mint && mint === state.chartToken && state.lastPrice > 0) return state.lastPrice;
  const series = mint ? chartBook.peek(mint) : null;
  if (series && series.lastPrice > 0) return series.lastPrice;
  return 0;
}

// Desk buy/sell/cascade/bump ticks. Missing mint, or a mint that is not on
// screen, must not move the visible series. A known other mint keeps the
// sample on its own slot.
function applyDeskTradeTick(mint, volume, priceFromBase) {
  if (!mint || typeof priceFromBase !== 'function') return;
  const base = priceBaseFor(mint);
  if (!(base > 0)) return;
  const epoch = mint === state.chartToken ? state.chartEpoch : null;
  pushChartTick(priceFromBase(base), volume || 0, epoch, mint);
}

function initChart() {
  generateInitialCandles();
  renderCandlestickChart();
  renderGauge(state.curveProgressPct);
  renderSparkline();
  renderDonutChart(3.2, 7.1, 89.7);

  // Resize listener
  window.addEventListener('resize', () => {
    renderCandlestickChart();
    renderGauge(state.curveProgressPct);
    renderSparkline();
    renderDonutChart(3.2, 7.1, 89.7);
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

function formatChartPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 0.01) return n.toFixed(4);
  if (abs >= 0.0001) return n.toFixed(6);
  if (abs >= 0.00000001) return n.toFixed(10);
  return n.toExponential(2);
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
    const res = await fetch(`/api/chart/candles?mint=${encodeURIComponent(mint)}&tf=${encodeURIComponent(requestedTf)}`);
    const data = await res.json();
    if (seq !== chartLoadSeq || state.chartToken !== mint) return;
    if (!res.ok) throw new Error(data.error || 'Candle request failed');
    const candles = Array.isArray(data.candles) ? data.candles : [];
    if (candles.length === 0) throw new Error('No candles');
    chartBook.replaceSeries(mint, {
      samples: candles.map(copyChartSample),
      sampleMs: TIMEFRAME_MS[data.servedRes] || TIMEFRAME_MS[requestedTf] || 60000,
      lastPrice: candles[candles.length - 1].close,
      source: data.source || '',
      symbol: data.symbol || null
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
    const price = 30 / 1073000000;
    const now = Date.now();
    chartBook.replaceSeries(mint, {
      samples: [{ time: now, open: price, high: price, low: price, close: price, volume: 0 }],
      sampleMs: TIMEFRAME_MS[requestedTf] || 5000,
      lastPrice: price,
      source: 'seed'
    });
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
  const tfMs = TIMEFRAME_MS[state.chartTimeframe] || 5000;
  const count = 40;
  const now = Date.now();
  let basePrice = 0.000030;
  const samples = [];
  for (let i = count; i >= 0; i--) {
    const time = now - (i * tfMs);
    const delta = (Math.random() - 0.48) * 0.000002;
    const open = basePrice;
    const close = Math.max(0.00001, open + delta);
    const high = Math.max(open, close) + (Math.random() * 0.0000015);
    const low = Math.min(open, close) - (Math.random() * 0.0000015);
    const volume = Math.random() * 0.8 + 0.1;
    samples.push({ time, open, high, low, close, volume });
    basePrice = close;
  }
  state.chartSamples = samples;
  state.lastPrice = basePrice;
  rebuildDisplayCandles();
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
  if (pDisplay) pDisplay.innerText = `${formatChartPrice(state.lastPrice)} SOL`;

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
    ctx.fillText(formatChartPrice(pVal), chartRight + 6, y + 3);
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
  ctx.fillText(formatChartPrice(state.lastPrice), chartRight + 4, curY + 4);

  // Hover Tooltip / Crosshair
  if (state.hoverCandle) {
    const hc = state.hoverCandle;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.fillRect(10, 8, 280, 24);
    ctx.strokeRect(10, 8, 280, 24);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '9px JetBrains Mono';
    ctx.fillText(`O:${formatChartPrice(hc.open)} H:${formatChartPrice(hc.high)} L:${formatChartPrice(hc.low)} C:${formatChartPrice(hc.close)}`, 14, 23);
  }
}

// ==================== RADIAL SPEEDOMETER GAUGE (SENTIMENT / BONDING) ====================

function renderGauge(percentage = 0) {
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
  const effectivePct = percentage > 0 ? percentage : 75;
  const pct = Math.min(100, Math.max(0, effectivePct)) / 100;
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
  if (pillEl) {
    if (effectivePct > 70) {
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

function renderDonutChart(devPct = 3.2, subPct = 7.1, curvePct = 89.7) {
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
  }

  if (window.lucide) {
    setTimeout(() => lucide.createIcons(), 10);
  }
}

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    state.simulationMode = data.simulationMode;
    updateSimulationUi(state.simulationMode);
    if (data.currentSlot) {
      document.getElementById('slotDisplay').innerText = `Slot: ${data.currentSlot.toLocaleString()}`;
    }
  } catch (err) {
    console.error('Failed to load status:', err);
  }
}

async function toggleSimulation(enable) {
  try {
    const res = await fetch('/api/settings/simulation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enable })
    });
    const data = await res.json();
    state.simulationMode = data.simulationMode;
    updateSimulationUi(state.simulationMode);
    loadMasterWallet();
    loadSubWallets();
    loadLiveStats();
    showToast(`Switched to ${enable ? 'SIMULATION MODE' : 'LIVE MAINNET'}`, enable ? 'info' : 'warning');
  } catch (e) {
    showToast('Failed to toggle mode: ' + e.message, 'error');
  }
}

function updateSimulationUi(isSim) {
  const simBtn = document.getElementById('modeSimBtn');
  const liveBtn = document.getElementById('modeLiveBtn');
  const banner = document.getElementById('simBanner');

  if (isSim) {
    simBtn.className = 'px-2 py-0.5 text-[11px] font-semibold rounded transition-all bg-cyan-500/20 text-cyan-400 border border-cyan-500/30';
    liveBtn.className = 'px-2 py-0.5 text-[11px] font-semibold rounded text-slate-400 hover:text-rose-400 transition-all';
    banner.classList.remove('hidden');
  } else {
    liveBtn.className = 'px-2 py-0.5 text-[11px] font-semibold rounded transition-all bg-rose-500/20 text-rose-400 border border-rose-500/30';
    simBtn.className = 'px-2 py-0.5 text-[11px] font-semibold rounded text-slate-400 hover:text-cyan-400 transition-all';
    banner.classList.add('hidden');
  }
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

  try {
    const res = await fetch('/api/trading/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ solAmount, walletAddresses })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Buy Executed! Spent ${data.totalSpentSol} SOL across ${data.results.length} wallets`, 'success');
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`Buy error: ${err.message}`, 'error');
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

  try {
    const res = await fetch('/api/trading/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pct, walletAddresses })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Sold ${pct}%: gained +${data.totalReceivedSol} SOL`, 'warning');
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`Sell error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="arrow-down" class="w-4 h-4"></i><span>▼ SELL TOKENS (RED DOWN)</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

async function executeInlineBuy(address, solAmount = 0.1) {
  try {
    showToast(`Buying ${solAmount} SOL for ${address.slice(0, 6)}...`, 'info');
    const res = await fetch('/api/trading/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ solAmount, walletAddresses: [address] })
    });
    const data = await res.json();
    showToast(`Bought tokens (+${solAmount} SOL)`, 'success');
    loadLiveStats();
  } catch (err) {
    showToast('Inline buy error: ' + err.message, 'error');
  }
}

async function executeInlineSell(address, pct = 100) {
  try {
    showToast(`Selling ${pct}% from ${address.slice(0, 6)}...`, 'info');
    const res = await fetch('/api/trading/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pct, walletAddresses: [address] })
    });
    const data = await res.json();
    showToast(`Sold ${pct}% (+${data.totalReceivedSol} SOL)`, 'warning');
    loadLiveStats();
  } catch (err) {
    showToast('Inline sell error: ' + err.message, 'error');
  }
}

async function executeCascadeExit() {
  if (!confirm('CASCADE EXIT: Staggered sell across sub-wallets with delays?')) return;
  try {
    showToast('Starting Cascade Exit...', 'info');
    const res = await fetch('/api/trading/cascade-sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delayMs: 800, pct: 100 })
    });
    await res.json();
    showToast('Cascade exit successfully completed', 'success');
    loadLiveStats();
  } catch (err) {
    showToast('Cascade error: ' + err.message, 'error');
  }
}

async function executePanicDumpAll() {
  if (!confirm('PANIC DUMP ALL: Emergency exit 100% of all tokens across all wallets immediately?')) return;
  try {
    showToast('PANIC DUMPING ALL HOLDINGS...', 'warning');
    const res = await fetch('/api/trading/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pct: 100 })
    });
    const data = await res.json();
    showToast(`Panic dumped all! Received +${data.totalReceivedSol} SOL`, 'success');
    loadLiveStats();
  } catch (err) {
    showToast('Dump error: ' + err.message, 'error');
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
      logTerminal(`[Multi-Buy] Dev wallet executing ${solAmount} SOL in 1st block...`);
      showToast(`Dev buy sent! Delaying ${delaySec}s before sub-wallets buy...`, 'info');
      await fetch('/api/trading/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solAmount, walletAddresses: [state.masterWallet.address] })
      });
      loadLiveStats();

      // Step 2: Delay countdown
      await new Promise(r => setTimeout(r, delaySec * 1000));

      // Step 3: Sub-wallets buy
      logTerminal(`[Multi-Buy] Firing ${subTargets.length} sub-wallets buy after ${delaySec}s delay...`);
      const res = await fetch('/api/trading/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solAmount, walletAddresses: subTargets })
      });
      const data = await res.json();
      showToast(`Delayed Multi-Buy Complete! (+${data.totalTokensBought || ''} tokens)`, 'success');
    } else {
      // Simultaneous buy across all target wallets
      const res = await fetch('/api/trading/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solAmount, walletAddresses })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Multi-Buy Success! Bought with ${walletAddresses.length} wallets (+${data.totalTokensBought || ''} tokens)`, 'success');
      } else {
        throw new Error(data.error);
      }
    }
    loadLiveStats();
    loadMasterWallet();
    loadSubWallets();
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
    const res = await fetch('/api/trading/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pct, walletAddresses })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Multi-Sell Success! Sold ${pct}% from ${walletAddresses.length} wallets (+${data.totalReceivedSol} SOL)`, 'warning');
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`Multi-Sell error: ${err.message}`, 'error');
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
    const res = await fetch(`/api/trading/stats${qs}`);
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
      renderGauge(s.curveProgressPct);

      document.getElementById('deskSolValueDisplay').innerText = `${s.currentSolValue} SOL`;
      document.getElementById('deskInvestedDisplay').innerText = `${s.totalSolInvested} SOL`;

      const pnlPrefix = s.pnlSol >= 0 ? '+' : '';
      const pnlDisplay = document.getElementById('deskPnlDisplay');
      const pnlBadge = document.getElementById('deskPnlStatusBadge');

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

      if (s.dexInfo) {
        document.getElementById('deskMcapDisplay').innerText = `$${(s.dexInfo.marketCap || 0).toLocaleString()}`;
      } else {
        document.getElementById('deskMcapDisplay').innerText = `$${Math.round((s.curveProgressPct * 690)).toLocaleString()}`;
      }
    }

    if (s.wallets && s.wallets.length > 0) {
      renderTradingWalletsTable(s.wallets);
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

    const pnlSol = w.pnlSol !== undefined ? w.pnlSol : 0;
    const pnlPct = w.pnlPct !== undefined ? w.pnlPct : 0;
    const pnlPrefix = pnlSol >= 0 ? '+' : '';
    const pnlClass = pnlSol >= 0 ? 'badge-pnl-green' : 'badge-pnl-red';
    const pnlSymbol = pnlSol >= 0 ? '▲' : '▼';
    const isChecked = isInitial ? true : prevChecked.has(w.address);

    tr.innerHTML = `
      <td class="py-2 px-2" style="width:26px;">
        <input type="checkbox" value="${w.address}" class="row-checkbox" onchange="updateSelectedCount()" ${isChecked ? 'checked' : ''} style="accent-color:#00d4ff;width:13px;height:13px;cursor:pointer;">
      </td>
      <td class="py-2 px-2">
        <div style="display:flex;align-items:center;gap:5px;">
          <span class="font-bold ${isDev ? 'text-amber-400' : 'text-slate-300'}" style="font-size:11px;">${w.role}</span>
          <span style="color:#546e7a;font-size:10px;">${w.address.slice(0, 4)}...${w.address.slice(-4)}</span>
          <button onclick="navigator.clipboard.writeText('${w.address}'); showToast('Copied ${w.role} address', 'info')" style="background:none;border:none;color:#546e7a;cursor:pointer;padding:1px;display:flex;align-items:center;" title="Copy Address">
            <i data-lucide="copy" style="width:11px;height:11px;"></i>
          </button>
          <a href="https://solscan.io/account/${w.address}" target="_blank" rel="noopener" style="color:#546e7a;display:flex;align-items:center;text-decoration:none;" title="View on Solscan">
            <i data-lucide="external-link" style="width:10px;height:10px;"></i>
          </a>
        </div>
      </td>
      <td class="py-2 px-2 text-right font-bold text-cyan-400">${(w.solBalance || 0).toFixed(3)}</td>
      <td class="py-2 px-2 text-right text-slate-200">${(w.tokens || 0).toLocaleString()}</td>
      <td class="py-2 px-2 text-right text-slate-400">${(w.solInvested || 0).toFixed(3)}</td>
      <td class="py-2 px-2 text-right font-semibold text-slate-200">${(w.currentValue || 0).toFixed(3)}</td>
      <td class="py-2 px-2 text-center">
        <span class="${pnlClass} text-[10px] font-mono">
          ${pnlSymbol} ${pnlPrefix}${pnlSol.toFixed(3)} (${pnlPrefix}${pnlPct.toFixed(1)}%)
        </span>
      </td>
      <td class="py-2 px-2 text-right">
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:5px;">
          <!-- Svarog Quick Buy Chips -->
          <div style="display:flex;align-items:center;gap:2px;background:rgba(0,196,140,0.06);padding:2px 3px;border-radius:5px;border:1px solid rgba(0,196,140,0.2);">
            <span style="font-size:8px;font-weight:800;color:#00c48c;padding:0 2px;">BUY</span>
            <button onclick="executeInlineBuy('${w.address}', 0.05)" class="btn-quick-buy" style="font-size:9px;padding:1px 4px;" title="Buy 0.05 SOL">+0.05</button>
            <button onclick="executeInlineBuy('${w.address}', 0.1)"  class="btn-quick-buy" style="font-size:9px;padding:1px 4px;" title="Buy 0.10 SOL">+0.1</button>
            <button onclick="executeInlineBuy('${w.address}', 0.25)" class="btn-quick-buy" style="font-size:9px;padding:1px 4px;" title="Buy 0.25 SOL">+0.25</button>
          </div>
          <!-- Svarog Quick Sell Chips -->
          <div style="display:flex;align-items:center;gap:2px;background:rgba(240,76,94,0.06);padding:2px 3px;border-radius:5px;border:1px solid rgba(240,76,94,0.2);">
            <span style="font-size:8px;font-weight:800;color:#f04c5e;padding:0 2px;">SELL</span>
            <button onclick="executeInlineSell('${w.address}', 25)"  class="btn-quick-sell" style="font-size:9px;padding:1px 4px;" title="Sell 25%">25%</button>
            <button onclick="executeInlineSell('${w.address}', 50)"  class="btn-quick-sell" style="font-size:9px;padding:1px 4px;" title="Sell 50%">50%</button>
            <button onclick="executeInlineSell('${w.address}', 75)"  class="btn-quick-sell" style="font-size:9px;padding:1px 4px;" title="Sell 75%">75%</button>
            <button onclick="executeInlineSell('${w.address}', 100)" class="btn-quick-sell" style="font-size:9px;padding:1px 4px;background:rgba(240,76,94,0.22);font-weight:800;" title="Dump 100%">100%</button>
          </div>
        </div>
      </td>
    `;
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
    link.href = `https://pump.fun/coin/${mint}`;
    link.innerText = `Pump.fun (${mint.slice(0, 4)}...) ↗`;
  }
  if (mint !== state.chartToken) {
    loadCandlesForToken(mint);
  }
}

function extractSolanaAddress(input) {
  if (!input) return '';
  const match = String(input).trim().match(/[1-9A-HJ-NP-za-km-z]{32,44}/);
  return match ? match[0] : String(input).trim();
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
    const res = await fetch('/api/trading/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mint })
    });
    const data = await res.json();
    state.activeToken = data.activeToken;
    updateActiveTokenUi(data.activeToken);
    loadLiveStats();
    showToast(`Tracking: ${mint.slice(0, 8)}...`, 'success');
  } catch (e) {
    showToast('Failed to track CA: ' + e.message, 'error');
  }
}

// ==================== LAUNCHPAD & BUNDLER LOGIC ====================

function setJitoTip(amount) {
  state.selectedJitoTip = amount;
  document.querySelectorAll('.tip-btn').forEach(btn => btn.classList.remove('active', 'border-cyan-500', 'bg-cyan-950/40'));
  const activeBtn = document.getElementById(`tipBtn-${amount}`);
  if (activeBtn) activeBtn.classList.add('active', 'border-cyan-500', 'bg-cyan-950/40');
}

function quickFillSubBuys(amount) {
  state.subWallets.forEach((_, idx) => {
    const el = document.getElementById(`subBuyInput-${idx}`);
    if (el) el.value = amount;
  });
  calculateBundleMetrics();
}

function randomizeSubBuys() {
  state.subWallets.forEach((_, idx) => {
    const el = document.getElementById(`subBuyInput-${idx}`);
    if (el) {
      const base = 0.2;
      const jitter = (Math.random() * 0.16) - 0.08;
      el.value = Math.max(0.05, Number((base + jitter).toFixed(3)));
    }
  });
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
    const devSolBuy = parseFloat(document.getElementById('devSolBuy').value || '0.5');
    const subWalletBuys = state.subWallets.map((_, i) => parseFloat(document.getElementById(`subBuyInput-${i}`)?.value || '0'));

    const res = await fetch('/api/launch/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devSolBuy,
        subWalletBuys,
        jitoTipSol: state.selectedJitoTip
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

    const metaRes = await fetch('/api/launch/upload-meta', { method: 'POST', body: formData });
    const metaData = await metaRes.json();
    const metadataUri = metaData.metadataUri;

    const devSolBuy = parseFloat(document.getElementById('devSolBuy').value || '0.5');
    const subWalletBuys = state.subWallets.map((_, i) => parseFloat(document.getElementById(`subBuyInput-${i}`)?.value || '0'));

    const launchRes = await fetch('/api/launch/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenName,
        tokenSymbol,
        tokenDescription,
        tokenMetadataUri: metadataUri,
        devSolBuy,
        subWalletBuys,
        jitoTipSol: state.selectedJitoTip,
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

async function loadMasterWallet() {
  try {
    const res = await fetch('/api/wallets/master');
    const data = await res.json();
    if (data.master) {
      state.masterWallet = data.master;
      document.getElementById('headerDevBalance').innerText = `${data.master.balance.toFixed(3)} SOL`;
      const addrIn = document.getElementById('masterAddressInput');
      const keyIn = document.getElementById('masterKeyInput');
      if (addrIn) addrIn.value = data.master.address;
      if (keyIn) keyIn.value = data.master.privateKey;
    }
  } catch (e) {
    console.error('Failed to load master wallet:', e);
  }
}

async function loadSubWallets() {
  try {
    const res = await fetch('/api/wallets/sub');
    const data = await res.json();
    if (data.subWallets) {
      state.subWallets = data.subWallets;
      renderSubWalletBuysInputs();
      renderSubWalletsTable();
      calculateBundleMetrics();
    }
  } catch (e) {
    console.error('Failed to load sub-wallets:', e);
  }
}

function renderSubWalletBuysInputs() {
  const container = document.getElementById('subWalletBuysContainer');
  if (!container) return;
  const countBadge = document.getElementById('subWalletCountBadge');
  if (countBadge) countBadge.innerText = `${state.subWallets.length} Wallets`;
  container.innerHTML = '';

  state.subWallets.forEach((w, idx) => {
    const div = document.createElement('div');
    div.className = 'bg-[#090d16] p-1.5 rounded border border-[#192235] space-y-1';
    div.innerHTML = `
      <div class="flex justify-between items-center text-[9px] text-slate-400">
        <span class="font-bold">#${idx + 1} (${w.address.slice(0, 4)}...)</span>
        <span class="font-mono text-cyan-400">${w.solBalance.toFixed(2)} SOL</span>
      </div>
      <input type="number" step="0.05" min="0" value="0.2" id="subBuyInput-${idx}" oninput="calculateBundleMetrics()" class="input-field py-0.5 px-1.5 text-xs font-mono font-bold text-center">
    `;
    container.appendChild(div);
  });
}

function renderSubWalletsTable() {
  const tbody = document.getElementById('subWalletsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  state.subWallets.forEach(w => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-[#192235]/60 hover:bg-[#131b2b]/50 transition-colors text-xs font-mono';
    tr.innerHTML = `
      <td class="py-2 px-2 text-slate-400">${w.index}</td>
      <td class="py-2 px-2 text-slate-200">
        <div class="flex items-center space-x-1.5">
          <span>${w.address.slice(0, 8)}...${w.address.slice(-6)}</span>
          <button onclick="navigator.clipboard.writeText('${w.address}'); showToast('Copied address', 'info')" class="text-slate-500 hover:text-cyan-400">
            <i data-lucide="copy" class="w-3 h-3"></i>
          </button>
        </div>
      </td>
      <td class="py-2 px-2 text-right font-bold text-cyan-400">${w.solBalance.toFixed(4)} SOL</td>
      <td class="py-2 px-2 text-right">
        <button onclick="copyWalletSecret('${w.privateKey}')" class="text-[10px] text-slate-400 hover:text-slate-200 px-2 py-0.5 rounded bg-[#131a29]">
          Copy Key
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

async function executeDisperseSol() {
  const totalSol = parseFloat(document.getElementById('disperseTotalSol').value || '1.0');
  const randomize = document.getElementById('disperseRandomize').checked;

  try {
    showToast(`Dispersing ${totalSol} SOL to sub-wallets...`, 'info');
    const res = await fetch('/api/wallets/disperse', {
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
    const res = await fetch('/api/wallets/drain', { method: 'POST' });
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

async function regenerateSubWallets() {
  const count = parseInt(document.getElementById('subWalletCountSelect').value, 10);
  try {
    const res = await fetch('/api/wallets/sub/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count })
    });
    await res.json();
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
  try {
    const res = await fetch('/api/wallets/export');
    const data = await res.json();
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
  if (!confirm('Generate a new Master Dev Wallet? Make sure you backed up the current key!')) return;
  try {
    const res = await fetch('/api/wallets/master/generate', { method: 'POST' });
    await res.json();
    loadMasterWallet();
    showToast('New Master Dev Wallet generated!', 'success');
  } catch (e) {
    showToast('Error generating master wallet: ' + e.message, 'error');
  }
}

async function promptImportMasterKey() {
  const key = prompt('Paste your Solana Master Dev Wallet Private Key (Base58 or JSON Byte Array):');
  if (!key) return;
  try {
    const res = await fetch('/api/wallets/master/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ privateKey: key })
    });
    const data = await res.json();
    if (data.success) {
      loadMasterWallet();
      showToast('Master wallet imported successfully!', 'success');
    } else {
      throw new Error(data.error);
    }
  } catch (e) {
    showToast('Import error: ' + e.message, 'error');
  }
}

// ==================== VAMP CLONER AUXILIARIES ====================

async function loadTrendingVampTokens() {
  const container = document.getElementById('vampTokensGrid');
  if (container) {
    container.innerHTML = `<div class="col-span-full py-8 text-center text-xs text-slate-500 font-mono">Fetching trending tokens from DexScreener & Pump.fun...</div>`;
  }

  try {
    const res = await fetch('/api/vamp/trending');
    const data = await res.json();
    state.trendingTokens = data.tokens || [];

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

        card.innerHTML = `
          <!-- Top Card Status & Socials Badge -->
          <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:5px;border-bottom:1px solid #161f33;font-size:9.5px;">
            <span style="font-family:monospace;font-weight:700;color:#64748b;text-transform:uppercase;">${m.dexId || 'Pump.fun'}</span>
            ${hasSocials ? `
              <div class="relative group" style="cursor:pointer;" onclick="inspectAndPopupSocials('${t.tokenAddress}')">
                <div style="display:flex;align-items:center;gap:4px;padding:2px 6px;border-radius:4px;background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.25);font-size:9.5px;color:#00d4ff;font-weight:700;">
                  <i data-lucide="share-2" style="width:10px;height:10px;"></i>
                  <span>Socials (${socialCount})</span>
                  <div style="display:flex;align-items:center;gap:3px;margin-left:2px;">
                    ${twitter ? `<span title="Twitter / X: ${twitter}" style="color:#38bdf8;font-size:9.5px;font-weight:800;">𝕏</span>` : ''}
                    ${telegram ? `<span title="Telegram: ${telegram}" style="color:#00d4ff;font-size:9.5px;">✈</span>` : ''}
                    ${website ? `<span title="Website: ${website}" style="color:#a78bfa;font-size:9.5px;">🌐</span>` : ''}
                  </div>
                </div>
                <!-- Hover Dropdown -->
                <div class="hidden group-hover:flex absolute right-0 top-full mt-1 z-30 flex-col gap-1.5 p-2 rounded-lg bg-[#0d1322] border border-[#233554] shadow-2xl min-w-[200px] text-[10.5px] font-mono pointer-events-auto backdrop-blur" onclick="event.stopPropagation()">
                  <div style="font-size:9px;font-weight:800;text-transform:uppercase;color:#78909c;letter-spacing:0.06em;padding-bottom:3px;border-bottom:1px solid #1a253d;display:flex;align-items:center;justify-content:space-between;">
                    <span>Verified Socials</span>
                    <span style="color:#00d4ff;">${socialCount} Active</span>
                  </div>
                  ${twitter ? `
                    <a href="${twitter}" target="_blank" style="display:flex;align-items:center;justify-content:space-between;color:#38bdf8;text-decoration:none;padding:3px 6px;border-radius:4px;background:#090e1a;border:1px solid #1c2b45;font-size:10px;">
                      <span style="display:flex;align-items:center;gap:5px;"><strong>𝕏</strong> Twitter / X</span>
                      <span style="font-size:9px;color:#64748b;">Visit ↗</span>
                    </a>` : ''}
                  ${telegram ? `
                    <a href="${telegram}" target="_blank" style="display:flex;align-items:center;justify-content:space-between;color:#00d4ff;text-decoration:none;padding:3px 6px;border-radius:4px;background:#090e1a;border:1px solid #1c2b45;font-size:10px;">
                      <span style="display:flex;align-items:center;gap:5px;"><strong>✈</strong> Telegram</span>
                      <span style="font-size:9px;color:#64748b;">Join ↗</span>
                    </a>` : ''}
                  ${website ? `
                    <a href="${website}" target="_blank" style="display:flex;align-items:center;justify-content:space-between;color:#a78bfa;text-decoration:none;padding:3px 6px;border-radius:4px;background:#090e1a;border:1px solid #1c2b45;font-size:10px;">
                      <span style="display:flex;align-items:center;gap:5px;"><strong>🌐</strong> Website</span>
                      <span style="font-size:9px;color:#64748b;">Open ↗</span>
                    </a>` : ''}
                  <button onclick="inspectAndPopupSocials('${t.tokenAddress}')" style="margin-top:2px;width:100%;padding:4px;border-radius:4px;background:#141f36;border:1px solid #233554;color:#cfd8dc;font-size:9.5px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;">
                    <i data-lucide="eye" style="width:10px;height:10px;"></i> Full Inspect Popup
                  </button>
                </div>
              </div>
            ` : `
              <div class="relative group" style="cursor:pointer;" onclick="inspectAndPopupSocials('${t.tokenAddress}')">
                <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:rgba(100,116,139,0.08);border:1px solid rgba(100,116,139,0.2);font-size:9px;color:#64748b;" title="No social links detected on this coin (click to inspect)">
                  <span style="width:5px;height:5px;border-radius:50%;background:#64748b;display:inline-block;"></span> No Socials
                </span>
              </div>
            `}
          </div>

          <div class="flex items-center space-x-2.5">
            <div class="w-10 h-10 rounded-lg bg-[#090d16] border border-[#192235] flex items-center justify-center overflow-hidden flex-shrink-0">
              ${t.icon ? `<img src="${t.icon}" class="w-full h-full object-cover">` : `<i data-lucide="coins" class="w-5 h-5 text-slate-500"></i>`}
            </div>
            <div class="overflow-hidden flex-1">
              <h4 class="font-bold text-xs text-slate-100 truncate">${t.name}</h4>
              <span class="text-[11px] font-mono font-bold text-cyan-400 block">${t.symbol}</span>
            </div>
          </div>

          <!-- Token CA Display with 1-Click Copy -->
          <div style="display:flex;align-items:center;justify-content:space-between;background:#060810;padding:3px 7px;border-radius:4px;border:1px solid #161f33;font-size:9.5px;font-family:'JetBrains Mono',monospace;">
            <span style="color:#78909c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:175px;" title="${t.tokenAddress}">${t.tokenAddress}</span>
            <button onclick="copyToClipboard('${t.tokenAddress}', '${t.symbol} CA')" style="background:none;border:none;color:#00d4ff;cursor:pointer;display:flex;align-items:center;gap:3px;font-size:9.5px;padding:1px 4px;font-weight:700;" title="1-Click Copy CA">
              <i data-lucide="copy" style="width:11px;height:11px;"></i> Copy
            </button>
          </div>

          <p class="text-[10px] text-slate-400 line-clamp-2 h-7">${t.description || 'No description provided.'}</p>
          <div class="grid grid-cols-2 gap-1.5 text-[9px] font-mono bg-[#090d16] p-1.5 rounded border border-[#192235]">
            <div><span class="text-slate-500">MCap:</span> <span class="text-slate-200 font-bold">$${(m.mcap || 0).toLocaleString()}</span></div>
            <div><span class="text-slate-500">24h Vol:</span> <span class="text-slate-200 font-bold">$${(m.volume24h || 0).toLocaleString()}</span></div>
          </div>
          <div class="flex gap-1.5 pt-1">
            <button onclick="vampDirect('${t.tokenAddress}')" class="btn-primary text-[10px] flex-1 py-1 flex items-center justify-center space-x-1">
              <i data-lucide="skull" class="w-3 h-3"></i><span>Vamp This</span>
            </button>
            <button onclick="vampMutate2('${t.tokenAddress}')" class="btn-secondary text-[10px] flex-1 py-1 flex items-center justify-center space-x-1">
              <span>2.0 Spin</span>
            </button>
          </div>
        `;
        container.appendChild(card);
      });
    }

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    if (container) {
      container.innerHTML = `<div class="col-span-full py-8 text-center text-xs text-rose-400">Failed to load trending tokens: ${err.message}</div>`;
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
    const change = m.priceChange24h !== undefined ? parseFloat(m.priceChange24h) : 12.5;
    const isUp = change >= 0;
    const color = isUp ? '#00c48c' : '#f04c5e';
    const bgSoft = isUp ? 'rgba(0,196,140,0.1)' : 'rgba(240,76,94,0.1)';
    const symbol = t.symbol || 'TOKEN';
    const name = t.name || t.tokenAddress?.slice(0, 6) || 'Meme';
    const price = m.priceUsd ? `$${Number(m.priceUsd) < 0.001 ? Number(m.priceUsd).toFixed(6) : Number(m.priceUsd).toFixed(4)}` : `$0.000034`;
    const mcap = m.mcap ? `$${Math.round(m.mcap).toLocaleString()}` : '$35.2K';

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
      if (t.tokenAddress) {
        document.getElementById('navTrackCaInput').value = t.tokenAddress;
        setChartSymbol(symbol);
        setTrackedTokenFromNav();
      }
    };

    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:7px;min-width:0;overflow:hidden;">
        <div style="width:22px;height:22px;border-radius:5px;background:#111827;border:1px solid #1a2338;overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;">
          ${t.icon ? `<img src="${t.icon}" style="width:100%;height:100%;object-fit:cover;" onerror="this.remove()">` : `<span style="font-size:8.5px;font-weight:800;color:#00d4ff;">${symbol.slice(0, 2)}</span>`}
        </div>
        <div style="min-width:0;overflow:hidden;">
          <div style="font-size:11px;font-weight:800;color:#cfd8dc;line-height:1.2;display:flex;align-items:center;gap:4px;white-space:nowrap;">
            <span style="color:#00d4ff;">${symbol}</span>
            <span style="font-size:9px;color:#546e7a;font-weight:400;overflow:hidden;text-overflow:ellipsis;">${name}</span>
          </div>
          <div style="font-size:9px;color:#78909c;font-family:monospace;">${mcap}</div>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div style="font-size:10px;font-weight:700;font-family:monospace;color:#cfd8dc;">${price}</div>
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;">
          <span style="font-size:8.5px;font-weight:800;font-family:monospace;padding:1px 4px;border-radius:4px;background:${bgSoft};color:${color};">
            ${isUp ? '▲ +' : '▼ '}${Number(change).toFixed(1)}%
          </span>
          <button onclick="event.stopPropagation(); copyToClipboard('${t.tokenAddress}', '${symbol} CA')" style="background:none;border:none;color:#78909c;cursor:pointer;padding:1px 2px;display:flex;align-items:center;" title="Copy ${symbol} CA">
            <i data-lucide="copy" style="width:11px;height:11px;"></i>
          </button>
        </div>
      </div>
    `;
    panel.appendChild(row);
  });
}
window.renderTopMovers = renderTopMovers;

// ==================== SOCIALS & TOKEN POPUP INSPECT ====================

async function inspectAndPopupSocials(address) {
  const modal = document.getElementById('socialInspectModal');
  const body = document.getElementById('socialInspectModalBody');
  if (!modal || !body) return;

  modal.style.display = 'flex';
  body.innerHTML = `
    <div style="padding:28px 0;text-align:center;font-size:11px;font-family:monospace;color:#78909c;">
      <i data-lucide="loader" style="width:18px;height:18px;margin:0 auto 10px;display:block;" class="animate-spin"></i>
      Fetching live socials &amp; metadata for ${address.slice(0, 8)}...
    </div>
  `;
  if (window.lucide) lucide.createIcons();

  try {
    const res = await fetch(`/api/vamp/inspect/${address}`);
    const data = await res.json();
    const token = data.token || {};

    const twitter = token.twitter || token.socials?.twitter || '';
    const telegram = token.telegram || token.socials?.telegram || '';
    const website = token.website || token.socials?.website || '';
    const hasSocials = !!(twitter || telegram || website);

    body.innerHTML = `
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
        <div style="width:48px;height:48px;border-radius:8px;background:#090d16;border:1px solid #1a253d;overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;">
          ${token.icon ? `<img src="${token.icon}" style="width:100%;height:100%;object-fit:cover;">` : `<i data-lucide="coins" style="width:20px;height:20px;color:#546e7a;"></i>`}
        </div>
        <div style="min-width:0;flex:1;">
          <h3 style="font-size:14px;font-weight:800;color:#f1f5f9;margin:0 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${token.name || 'Unknown'}</h3>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11.5px;font-weight:800;font-family:monospace;color:#00d4ff;">${token.symbol || 'TOKEN'}</span>
            <span style="font-size:10px;color:#64748b;font-family:monospace;">MCap: $${Number(token.marketCap || 0).toLocaleString()}</span>
          </div>
        </div>
      </div>

      <!-- Contract Address -->
      <div style="background:#090d16;padding:6px 9px;border-radius:6px;border:1px solid #1a253d;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;font-family:monospace;font-size:10.5px;">
        <span style="color:#78909c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;">${address}</span>
        <button onclick="copyToClipboard('${address}', 'CA')" style="background:none;border:none;color:#00d4ff;cursor:pointer;font-size:10px;font-weight:700;display:flex;align-items:center;gap:3px;">
          <i data-lucide="copy" style="width:11px;height:11px;"></i> Copy
        </button>
      </div>

      <!-- Socials List -->
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;color:#78909c;margin-bottom:6px;">
          Verified Social Media Channels
        </label>
        ${hasSocials ? `
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${twitter ? `
              <div style="display:flex;align-items:center;justify-content:space-between;background:#090d16;padding:7px 10px;border-radius:6px;border:1px solid #1a253d;">
                <div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#e2e8f0;">
                  <strong style="color:#38bdf8;font-size:12px;">𝕏</strong>
                  <span>Twitter / X</span>
                </div>
                <a href="${twitter}" target="_blank" style="color:#38bdf8;font-size:10.5px;text-decoration:none;font-weight:700;display:flex;align-items:center;gap:3px;">
                  Open Link ↗
                </a>
              </div>` : ''}
            ${telegram ? `
              <div style="display:flex;align-items:center;justify-content:space-between;background:#090d16;padding:7px 10px;border-radius:6px;border:1px solid #1a253d;">
                <div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#e2e8f0;">
                  <strong style="color:#00d4ff;font-size:12px;">✈</strong>
                  <span>Telegram</span>
                </div>
                <a href="${telegram}" target="_blank" style="color:#00d4ff;font-size:10.5px;text-decoration:none;font-weight:700;display:flex;align-items:center;gap:3px;">
                  Join Channel ↗
                </a>
              </div>` : ''}
            ${website ? `
              <div style="display:flex;align-items:center;justify-content:space-between;background:#090d16;padding:7px 10px;border-radius:6px;border:1px solid #1a253d;">
                <div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#e2e8f0;">
                  <strong style="color:#a78bfa;font-size:12px;">🌐</strong>
                  <span>Official Website</span>
                </div>
                <a href="${website}" target="_blank" style="color:#a78bfa;font-size:10.5px;text-decoration:none;font-weight:700;display:flex;align-items:center;gap:3px;">
                  Visit Site ↗
                </a>
              </div>` : ''}
          </div>
        ` : `
          <div style="background:#090d16;padding:10px;border-radius:6px;border:1px dashed #1a253d;font-size:11px;color:#64748b;text-align:center;">
            No official socials detected. (Stealth launch / community takeover candidate)
          </div>
        `}
      </div>

      <!-- Description -->
      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;color:#78909c;margin-bottom:4px;">
          Narrative / Description
        </label>
        <div style="background:#090d16;padding:8px 10px;border-radius:6px;border:1px solid #1a253d;font-size:10.5px;color:#94a3b8;max-height:80px;overflow-y:auto;line-height:1.4;">
          ${token.description || 'No description provided.'}
        </div>
      </div>

      <!-- Actions -->
      <div style="display:flex;gap:8px;">
        <button onclick="closeSocialInspectModal(); vampDirect('${address}')" class="btn-primary" style="flex:1;padding:8px;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:5px;">
          <i data-lucide="skull" style="width:12px;height:12px;"></i> Vamp into Launchpad
        </button>
        <button onclick="closeSocialInspectModal()" class="btn-secondary" style="padding:8px 14px;font-size:11px;">
          Close
        </button>
      </div>
    `;

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    body.innerHTML = `<div style="color:#f04c5e;font-size:11px;padding:12px;text-align:center;">Failed to inspect socials: ${err.message}</div>`;
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
    const res = await fetch(`/api/vamp/inspect/${ca}`);
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
    const res = await fetch(`/api/vamp/inspect/${address}`);
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
    const res = await fetch(`/api/vamp/inspect/${address}`);
    const data = await res.json();
    const mutateRes = await fetch('/api/vamp/mutate', {
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
    const res = await fetch(`/api/vamp/inspect/${ca}`);
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

function applyVampToLaunchpad(token) {
  if (!token) return;

  // 1. Name, Symbol & Description
  document.getElementById('tokenName').value = token.name || '';
  document.getElementById('tokenSymbol').value = token.symbol || '';
  document.getElementById('tokenDescription').value = token.description || '';

  // 2. Source / Vamped Token CA window
  const ca = token.address || token.tokenAddress || '';
  const caInput = document.getElementById('launchpadVampedCa');
  if (caInput) caInput.value = ca;
  const pumpLink = document.getElementById('launchpadPumpLink');
  if (pumpLink && ca) {
    pumpLink.href = `https://pump.fun/coin/${ca}`;
    pumpLink.style.display = 'inline-block';
  }

  // 3. Socials
  const twitter = token.twitter || token.socials?.twitter || (token.links || []).find(l => (l.url || '').includes('x.com') || (l.url || '').includes('twitter'))?.url || '';
  const telegram = token.telegram || token.socials?.telegram || (token.links || []).find(l => (l.url || '').includes('t.me'))?.url || '';
  const website = token.website || token.socials?.website || (token.links || []).find(l => !(l.url || '').includes('twitter') && !(l.url || '').includes('t.me') && !(l.url || '').includes('x.com'))?.url || '';

  document.getElementById('tokenTwitter').value = twitter;
  document.getElementById('tokenTelegram').value = telegram;
  document.getElementById('tokenWebsite').value = website;

  // 4. Logo Picture Display & Storage
  const iconUrl = token.icon || token.imageUrl || token.image || '';
  state.vampedImageUrl = iconUrl;
  const preview = document.getElementById('logoPreview');
  const placeholder = document.getElementById('logoIconPlaceholder');

  if (iconUrl) {
    if (preview) {
      preview.src = iconUrl;
      preview.style.display = 'block';
    }
    if (placeholder) {
      placeholder.style.display = 'none';
    }
  } else {
    if (preview) {
      preview.src = '';
      preview.style.display = 'none';
    }
    if (placeholder) {
      placeholder.style.display = 'block';
    }
  }
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

async function toggleVolumeBumper(start) {
  try {
    const badge = document.getElementById('bumperActiveBadge');
    if (start) {
      const solAmount = parseFloat(document.getElementById('bumpAmountInput').value || '0.01');
      const intervalSeconds = parseInt(document.getElementById('bumpIntervalInput').value || '20', 10);
      await fetch('/api/trading/bumper/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solAmount, intervalSeconds })
      });
      badge.innerText = 'BUMPING ACTIVE';
      badge.className = 'text-[10px] px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono font-bold animate-pulse';
      showToast('Volume bumper started', 'success');
    } else {
      await fetch('/api/trading/bumper/stop', { method: 'POST' });
      badge.innerText = 'STOPPED';
      badge.className = 'text-[10px] px-1.5 py-0.2 rounded bg-[#131a29] text-slate-400 font-mono';
      showToast('Volume bumper stopped', 'info');
    }
  } catch (err) {
    showToast('Bumper error: ' + err.message, 'error');
  }
}

function logTerminal(message) {
  const term = document.getElementById('terminalLogs');
  if (!term) return;
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.innerHTML = `<span class="text-slate-500">[${time}]</span> ${message}`;
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
    const res = await fetch('/api/wallets/reclaim-rent', {
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
  if (!mint || !(Number(trade.solAmount) > 0)) return;
  const isBuy = trade.txType === 'buy';
  const epoch = mint === state.chartToken ? state.chartEpoch : null;
  if (trade.simulated || String(trade.signature || '').startsWith('sim_')) {
    const base = priceBaseFor(mint);
    if (!(base > 0)) return;
    const delta = isBuy ? (trade.solAmount * 0.002) : -(trade.solAmount * 0.002);
    pushChartTick(Math.max(1e-12, base * (1 + delta)), trade.solAmount, epoch, mint);
  } else {
    const tradePrice = priceFromTrade(trade);
    if (tradePrice) pushChartTick(tradePrice, trade.solAmount, epoch, mint);
  }
}

function renderTradeTick(trade) {
  if (!trade) return;
  const mint = trade.mint || null;
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
      <span style="color:#e2e8f0;font-weight:700;">${solFormatted} SOL</span>
      <span style="color:#64748b;font-size:9.5px;">(${traderShort})</span>
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
        <span style="color:#94a3b8;font-size:10px;">${(trade.tokenAmount || 0).toLocaleString()} tokens</span>
        <a href="https://solscan.io/account/${trade.traderPublicKey}" target="_blank" style="color:#00d4ff;font-size:10px;text-decoration:none;">${traderShort}</a>
      </div>
    `;
    tapePanel.prepend(row);
    while (tapePanel.children.length > 30) {
      tapePanel.removeChild(tapePanel.lastChild);
    }
  }

  if (!trade._replay) applyPublicTradePrice(trade, mint || state.chartToken);
}
