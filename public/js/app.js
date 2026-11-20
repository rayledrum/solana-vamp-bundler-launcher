// Institutional Solana Memecoin Bundler & Trading Terminal
const state = {
  currentTab: 'trading',
  simulationMode: true,
  currentSlot: null,
  masterWallet: null,
  subWallets: [],
  selectedJitoTip: 0.005,
  activeToken: null,
  logoFile: null,
  logoUrl: null,
  isBumping: false,
  ws: null,

  // Charting state (Ultra-fast timeframes down to 1s / 5s)
  chartTimeframe: '5s', // '1s', '5s', '15s', '30s', '1m', '5m'
  candles: [],
  currentCandle: null,
  lastPrice: 0.000034,
  curveProgressPct: 0,
  hoverCandle: null
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
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  state.ws = new WebSocket(wsUrl);

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
      // In simulation mode, add small organic tick to chart
      if (state.simulationMode) {
        const jitter = (Math.random() - 0.48) * 0.0000005;
        const newPrice = Math.max(0.000005, state.lastPrice + jitter);
        pushChartTick(newPrice, Math.random() * 0.1);
      }
      break;

    case 'LAUNCH_STARTED':
      logTerminal(`🚀 [Bundle Launch] Started for ${msg.payload.tokenSymbol}...`);
      showToast(`Launching ${msg.payload.tokenSymbol} atomic bundle...`, 'info');
      break;

    case 'LAUNCH_SUCCESS':
      logTerminal(`✅ [Bundle Landed] Mint: ${msg.payload.mint} | Slot: ${msg.payload.slot} | Jito Tip: ${msg.payload.jitoTipSol} SOL`);
      showToast(`Landed! Mint: ${msg.payload.mint.slice(0, 8)}...`, 'success');
      state.activeToken = msg.payload.mint;
      updateActiveTokenUi(msg.payload.mint);
      loadSubWallets();
      loadLiveStats();
      switchTab('trading');
      // Surge price candle on launch
      pushChartTick(state.lastPrice * 1.35, 1.7);
      break;

    case 'LAUNCH_FAILED':
      logTerminal(`❌ [Bundle Failed] Error: ${msg.payload.error}`);
      showToast(`Launch failed: ${msg.payload.error}`, 'error');
      break;

    case 'BUY_EXECUTED':
      logTerminal(`🟢 [Manual Buy] Bought tokens for ${msg.payload.totalSpentSol} SOL across ${msg.payload.resultsCount} wallets`);
      showToast(`Bought tokens (+${msg.payload.totalSpentSol} SOL)`, 'success');
      const buyPrice = state.lastPrice * (1 + (msg.payload.totalSpentSol * 0.05));
      pushChartTick(buyPrice, msg.payload.totalSpentSol);
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'SELL_EXECUTED':
      logTerminal(`🔴 [Manual Sell] Sold ${msg.payload.pct}% | Recv: +${msg.payload.totalReceivedSol} SOL`);
      showToast(`Sold ${msg.payload.pct}% across bundle (+${msg.payload.totalReceivedSol} SOL)`, 'warning');
      const sellPrice = state.lastPrice * (1 - (msg.payload.pct * 0.002));
      pushChartTick(sellPrice, msg.payload.totalReceivedSol);
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'CASCADE_STEP':
      logTerminal(`🌊 [Cascade] Step ${msg.payload.step}/${msg.payload.total} executed for ${msg.payload.address.slice(0, 6)}...`);
      pushChartTick(state.lastPrice * 0.985, 0.2);
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
      pushChartTick(state.lastPrice * (1 + (Math.random() * 0.02 - 0.01)), msg.payload.solAmount);
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
  if (!TIMEFRAME_MS[tf]) return;
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

  generateInitialCandles();
  renderCandlestickChart();
  showToast(`Chart timeframe set to ${tf}`, 'info');
}

function generateInitialCandles() {
  const tfMs = TIMEFRAME_MS[state.chartTimeframe] || 5000;
  const count = 40;
  const now = Date.now();
  let basePrice = 0.000030;
  state.candles = [];

  for (let i = count; i >= 0; i--) {
    const time = now - (i * tfMs);
    const delta = (Math.random() - 0.48) * 0.000002;
    const open = basePrice;
    const close = Math.max(0.00001, open + delta);
    const high = Math.max(open, close) + (Math.random() * 0.0000015);
    const low = Math.min(open, close) - (Math.random() * 0.0000015);
    const volume = Math.random() * 0.8 + 0.1;

    state.candles.push({ time, open, high, low, close, volume });
    basePrice = close;
  }

  state.lastPrice = basePrice;
  state.currentCandle = state.candles[state.candles.length - 1];
  updateChartHeaders();
}

function pushChartTick(price, volume = 0.1) {
  state.lastPrice = price;
  const tfMs = TIMEFRAME_MS[state.chartTimeframe] || 5000;
  const now = Date.now();

  if (!state.currentCandle || now - state.currentCandle.time >= tfMs) {
    state.currentCandle = {
      time: now,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: volume
    };
    state.candles.push(state.currentCandle);
    if (state.candles.length > 60) state.candles.shift();
  } else {
    state.currentCandle.high = Math.max(state.currentCandle.high, price);
    state.currentCandle.low = Math.min(state.currentCandle.low, price);
    state.currentCandle.close = price;
    state.currentCandle.volume += volume;
  }

  updateChartHeaders();
  renderCandlestickChart();
  renderSparkline();
}

function updateChartHeaders() {
  const pDisplay = document.getElementById('chartPriceDisplay');
  const cDisplay = document.getElementById('chartChangeDisplay');
  if (pDisplay) pDisplay.innerText = `${state.lastPrice.toFixed(6)} SOL`;

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
  const chartRight = w - 65;
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
    ctx.fillText(pVal.toFixed(6), chartRight + 6, y + 3);
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
  ctx.fillRect(chartRight + 2, curY - 8, 60, 16);
  ctx.fillStyle = '#0a0d14';
  ctx.font = 'bold 9px JetBrains Mono';
  ctx.fillText(state.lastPrice.toFixed(6), chartRight + 4, curY + 4);

  // Hover Tooltip / Crosshair
  if (state.hoverCandle) {
    const hc = state.hoverCandle;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.fillRect(10, 8, 220, 24);
    ctx.strokeRect(10, 8, 220, 24);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '9px JetBrains Mono';
    ctx.fillText(`O:${hc.open.toFixed(6)} H:${hc.high.toFixed(6)} L:${hc.low.toFixed(6)} C:${hc.close.toFixed(6)}`, 14, 23);
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
      pillEl.innerText = 'BULLISH ▲';
      pillEl.className = 'text-[10px] font-bold text-emerald-400 font-mono';
    } else {
      pillEl.innerText = 'BONDING';
      pillEl.className = 'text-[10px] font-bold text-slate-400 font-mono';
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
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active', 'text-cyan-400', 'bg-[#131b2c]');
    btn.classList.add('text-[#94a3b8]');
  });

  const pane = document.getElementById(`tabContent-${tabId}`);
  const btn = document.getElementById(`tabBtn-${tabId}`);

  if (pane) pane.classList.remove('hidden');
  if (btn) {
    btn.classList.add('active');
  }

  if (tabId === 'trading') {
    setTimeout(() => {
      renderCandlestickChart();
      renderGauge(state.curveProgressPct);
      renderSparkline();
      renderDonutChart();
    }, 50);
  }

  if (window.lucide) lucide.createIcons();
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
}

function toggleSelectAllRows(checked) {
  document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = checked);
}

// ==================== LIVE STATS & TABLE SYNC ====================

async function loadLiveStats() {
  try {
    const res = await fetch('/api/trading/stats');
    const data = await res.json();
    const s = data.stats;
    if (!s) return;

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

      renderTradingWalletsTable(s.wallets);
    }
  } catch (e) {
    // ignore
  }
}

function renderTradingWalletsTable(wallets) {
  const tbody = document.getElementById('tradingWalletsTableBody');
  if (!tbody) return;
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

    tr.innerHTML = `
      <td class="py-2 px-2">
        <input type="checkbox" value="${w.address}" class="row-checkbox rounded border-slate-700 bg-[#090d16] text-cyan-500">
      </td>
      <td class="py-2 px-2">
        <div class="flex items-center space-x-1.5">
          <span class="font-bold ${isDev ? 'text-amber-400' : 'text-slate-300'}">${w.role}</span>
          <span class="text-slate-500">${w.address.slice(0, 4)}...${w.address.slice(-4)}</span>
          <button onclick="navigator.clipboard.writeText('${w.address}'); showToast('Copied address', 'info')" class="text-slate-500 hover:text-cyan-400">
            <i data-lucide="copy" class="w-3 h-3"></i>
          </button>
        </div>
      </td>
      <td class="py-2 px-2 font-bold text-cyan-400">${(w.solBalance || 0).toFixed(3)} SOL</td>
      <td class="py-2 px-2 text-slate-200">${(w.tokens || 0).toLocaleString()}</td>
      <td class="py-2 px-2 text-slate-400">${(w.solInvested || 0).toFixed(3)} SOL</td>
      <td class="py-2 px-2 font-semibold text-slate-200">${(w.currentValue || 0).toFixed(3)} SOL</td>
      <td class="py-2 px-2 text-center">
        <span class="${pnlClass} text-[10px] font-mono">
          ${pnlSymbol} ${pnlPrefix}${pnlSol.toFixed(3)} SOL (${pnlPrefix}${pnlPct.toFixed(1)}%)
        </span>
      </td>
      <td class="py-2 px-2 text-right">
        <div class="flex items-center justify-end space-x-1">
          <button onclick="executeInlineBuy('${w.address}', 0.1)" class="btn-quick-buy text-[10px] py-0.5 px-1.5" title="Quick Buy 0.1 SOL">▲ Buy</button>
          <button onclick="executeInlineSell('${w.address}', 50)" class="btn-quick-sell text-[10px] py-0.5 px-1.5" title="Sell 50%">▼ 50%</button>
          <button onclick="executeInlineSell('${w.address}', 100)" class="btn-quick-sell text-[10px] py-0.5 px-1.5 bg-rose-950/60" title="Sell 100%">▼ 100%</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

function updateActiveTokenUi(mint) {
  if (!mint) return;
  document.getElementById('navTrackCaInput').value = mint;
  const link = document.getElementById('deskPumpLink');
  if (link) {
    link.href = `https://pump.fun/coin/${mint}`;
    link.innerText = `Pump.fun (${mint.slice(0, 4)}...) ↗`;
  }
}

async function setTrackedTokenFromNav() {
  const mint = document.getElementById('navTrackCaInput').value.trim();
  if (!mint) return showToast('Please enter a Token Mint Address', 'warning');
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
        jitoTipSol: state.selectedJitoTip
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
  if (!container) return;
  container.innerHTML = `<div class="col-span-full py-8 text-center text-xs text-slate-500 font-mono">Fetching trending tokens from DexScreener & Pump.fun...</div>`;

  try {
    const res = await fetch('/api/vamp/trending');
    const data = await res.json();
    container.innerHTML = '';

    (data.tokens || []).forEach(t => {
      const card = document.createElement('div');
      card.className = 'bento-card p-3 space-y-2 hover:border-cyan-500/50 transition-all';
      const m = t.metrics || {};
      card.innerHTML = `
        <div class="flex items-center space-x-2.5">
          <div class="w-10 h-10 rounded-lg bg-[#090d16] border border-[#192235] flex items-center justify-center overflow-hidden flex-shrink-0">
            ${t.icon ? `<img src="${t.icon}" class="w-full h-full object-cover">` : `<i data-lucide="coins" class="w-5 h-5 text-slate-500"></i>`}
          </div>
          <div class="overflow-hidden flex-1">
            <h4 class="font-bold text-xs text-slate-100 truncate">${t.name}</h4>
            <span class="text-[11px] font-mono font-bold text-cyan-400 block">${t.symbol}</span>
          </div>
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

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    container.innerHTML = `<div class="col-span-full py-8 text-center text-xs text-rose-400">Failed to load trending tokens: ${err.message}</div>`;
  }
}

async function inspectCustomVampCa() {
  const ca = document.getElementById('vampCaInput').value.trim();
  if (!ca) return showToast('Please enter a Solana CA', 'warning');
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

function applyVampToLaunchpad(token) {
  document.getElementById('tokenName').value = token.name;
  document.getElementById('tokenSymbol').value = token.symbol;
  document.getElementById('tokenDescription').value = token.description;
  if (token.twitter) document.getElementById('tokenTwitter').value = token.twitter;
  if (token.telegram) document.getElementById('tokenTelegram').value = token.telegram;
  if (token.website) document.getElementById('tokenWebsite').value = token.website;

  if (token.icon) {
    const preview = document.getElementById('logoPreview');
    preview.src = token.icon;
    preview.classList.remove('hidden');
    document.getElementById('logoIconPlaceholder').classList.add('hidden');
  }
}

function handleLogoSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  state.logoFile = file;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const preview = document.getElementById('logoPreview');
    preview.src = ev.target.result;
    preview.classList.remove('hidden');
    document.getElementById('logoIconPlaceholder').classList.add('hidden');
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
