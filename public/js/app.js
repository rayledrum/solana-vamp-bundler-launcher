// Frontend State Management & API Client
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
  ws: null
};

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();
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

// Setup WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    logTerminal('[WebSocket] Connected to real-time event pipeline');
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

// Handle Real-Time WS Messages
function handleWsMessage(msg) {
  switch (msg.type) {
    case 'HEARTBEAT':
      state.currentSlot = msg.payload.slot;
      document.getElementById('slotDisplay').innerText = `Slot: ${msg.payload.slot.toLocaleString()}`;
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
      break;

    case 'LAUNCH_FAILED':
      logTerminal(`❌ [Bundle Failed] Error: ${msg.payload.error}`);
      showToast(`Launch failed: ${msg.payload.error}`, 'error');
      break;

    case 'BUY_EXECUTED':
      logTerminal(`🟢 [Manual Buy] Bought tokens for ${msg.payload.totalSpentSol} SOL across ${msg.payload.resultsCount} wallets`);
      showToast(`Bought tokens (+${msg.payload.totalSpentSol} SOL)`, 'success');
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'SELL_EXECUTED':
      logTerminal(`🔴 [Manual Sell] Sold ${msg.payload.pct}% | Recv: +${msg.payload.totalReceivedSol} SOL`);
      showToast(`Sold ${msg.payload.pct}% across bundle wallets (+${msg.payload.totalReceivedSol} SOL)`, 'warning');
      loadLiveStats();
      loadMasterWallet();
      loadSubWallets();
      break;

    case 'CASCADE_STEP':
      logTerminal(`🌊 [Cascade Exit] Step ${msg.payload.step}/${msg.payload.total} executed for ${msg.payload.address.slice(0, 6)}...`);
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
      break;
  }
}

// Switch UI Tabs
function switchTab(tabId) {
  state.currentTab = tabId;
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active', 'text-cyan-400', 'bg-surface-800/60', 'border', 'border-cyan-500/30');
    btn.classList.add('text-slate-400');
  });

  const pane = document.getElementById(`tabContent-${tabId}`);
  const btn = document.getElementById(`tabBtn-${tabId}`);

  if (pane) pane.classList.remove('hidden');
  if (btn) {
    btn.classList.add('active', 'text-cyan-400', 'bg-surface-800/60', 'border', 'border-cyan-500/30');
    btn.classList.remove('text-slate-400');
  }

  if (window.lucide) lucide.createIcons();
}

// Load System Status
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

// Toggle Simulation Mode
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
    simBtn.className = 'px-2.5 py-1 text-xs font-semibold rounded-lg transition-all bg-cyan-500/20 text-cyan-400 border border-cyan-500/30';
    liveBtn.className = 'px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-400 hover:text-rose-400 transition-all';
    banner.classList.remove('hidden');
  } else {
    liveBtn.className = 'px-2.5 py-1 text-xs font-semibold rounded-lg transition-all bg-rose-500/20 text-rose-400 border border-rose-500/30';
    simBtn.className = 'px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-400 hover:text-cyan-400 transition-all';
    banner.classList.add('hidden');
  }
}

// Load Master Dev Wallet
async function loadMasterWallet() {
  try {
    const res = await fetch('/api/wallets/master');
    const data = await res.json();
    if (data.master) {
      state.masterWallet = data.master;
      document.getElementById('headerDevBalance').innerText = `${data.master.balance.toFixed(3)} SOL`;
      document.getElementById('masterAddressInput').value = data.master.address;
      document.getElementById('masterKeyInput').value = data.master.privateKey;
    }
  } catch (e) {
    console.error('Failed to load master wallet:', e);
  }
}

// Load Sub-Wallets Matrix
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

// Render Sub-Wallet Buys inside Launchpad
function renderSubWalletBuysInputs() {
  const container = document.getElementById('subWalletBuysContainer');
  document.getElementById('subWalletCountBadge').innerText = `${state.subWallets.length} Wallets`;
  container.innerHTML = '';

  state.subWallets.forEach((w, idx) => {
    const div = document.createElement('div');
    div.className = 'bg-surface-900 p-2 rounded-lg border border-surface-800 space-y-1';
    div.innerHTML = `
      <div class="flex justify-between items-center text-[10px] text-slate-400">
        <span class="font-bold">#${idx + 1} (${w.address.slice(0, 4)}...)</span>
        <span class="font-mono text-cyan-400">${w.solBalance.toFixed(2)} SOL</span>
      </div>
      <input type="number" step="0.05" min="0" value="0.2" id="subBuyInput-${idx}" oninput="calculateBundleMetrics()" class="input-field py-1 px-2 text-xs font-mono font-bold text-center">
    `;
    container.appendChild(div);
  });
}

// Render Sub-Wallets Management Table
function renderSubWalletsTable() {
  const tbody = document.getElementById('subWalletsTableBody');
  document.getElementById('subWalletsSummaryText').innerText = `${state.subWallets.length} sub-wallets configured`;
  tbody.innerHTML = '';

  state.subWallets.forEach(w => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-surface-800/60 hover:bg-surface-900/50 transition-colors';
    tr.innerHTML = `
      <td class="py-2.5 px-3 text-slate-400">${w.index}</td>
      <td class="py-2.5 px-3 text-slate-200">
        <div class="flex items-center space-x-1.5">
          <span>${w.address.slice(0, 8)}...${w.address.slice(-6)}</span>
          <button onclick="navigator.clipboard.writeText('${w.address}'); showToast('Copied address', 'info')" class="text-slate-500 hover:text-cyan-400">
            <i data-lucide="copy" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </td>
      <td class="py-2.5 px-3 text-right font-bold text-cyan-400">${w.solBalance.toFixed(4)} SOL</td>
      <td class="py-2.5 px-3 text-right">
        <button onclick="copyWalletSecret('${w.privateKey}')" class="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded bg-surface-800">
          Copy Key
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

// Calculate Anti-Sniper Bundle Metrics
function calculateBundleMetrics() {
  const devSol = parseFloat(document.getElementById('devSolBuy').value || '0');
  let totalSubSol = 0;
  state.subWallets.forEach((_, idx) => {
    const el = document.getElementById(`subBuyInput-${idx}`);
    if (el) totalSubSol += parseFloat(el.value || '0');
  });

  const totalBundleSol = devSol + totalSubSol;
  document.getElementById('metricTotalSol').innerText = `${totalBundleSol.toFixed(2)} SOL`;

  const virtualSol = 30 + totalBundleSol;
  const k = 30 * 1073000000;
  const newTokens = k / virtualSol;
  const tokensOut = Math.max(0, 1073000000 - newTokens);
  const supplyPct = ((tokensOut / 1000000000) * 100).toFixed(2);

  document.getElementById('metricTotalTokens').innerText = `~${Math.floor(tokensOut).toLocaleString()}`;
  document.getElementById('metricSupplyPct').innerText = `${supplyPct}% (Sniper-Proof)`;
  document.getElementById('metricTxCount').innerText = `${state.subWallets.length + 2} Txs (Create + ${state.subWallets.length} Buys + Tip)`;
  
  const devTokens = Math.floor(tokensOut * (devSol / (totalBundleSol || 1)));
  const devPct = ((devTokens / 1000000000) * 100).toFixed(2);
  document.getElementById('devBuyTokensEst').innerText = `Est. ~${devTokens.toLocaleString()} tokens (${devPct}%)`;
}

// Set Jito Tip
function setJitoTip(amount) {
  state.selectedJitoTip = amount;
  document.querySelectorAll('.tip-btn').forEach(btn => btn.classList.remove('active', 'border-cyan-500', 'bg-cyan-950/40'));
  const activeBtn = document.getElementById(`tipBtn-${amount}`);
  if (activeBtn) activeBtn.classList.add('active', 'border-cyan-500', 'bg-cyan-950/40');
}

// Quick Fill / Randomize Sub-wallet buys
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

// Pre-flight check
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
    btn.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4"></i><span>Run Pre-Flight Validation Check</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

// Execute Atomic Jito Launch Bundle
async function executeLaunchBundle() {
  const btn = document.getElementById('btnLaunchBundle');
  const tokenName = document.getElementById('tokenName').value.trim();
  const tokenSymbol = document.getElementById('tokenSymbol').value.trim();
  const tokenDescription = document.getElementById('tokenDescription').value.trim();

  if (!tokenName || !tokenSymbol) {
    return showToast('Please enter Token Name and Symbol', 'warning');
  }

  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader" class="w-5 h-5 animate-spin"></i><span>PACKING ATOMIC JITO BUNDLE...</span>`;

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

    const metaRes = await fetch('/api/launch/upload-meta', {
      method: 'POST',
      body: formData
    });
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
    btn.innerHTML = `<i data-lucide="flame" class="w-5 h-5"></i><span>LAUNCH ATOMIC JITO BUNDLE (SLOT 0)</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

// Update Active Token UI elements
function updateActiveTokenUi(mint) {
  if (!mint) return;
  document.getElementById('deskActiveTokenMintDisplay').innerText = mint;
  document.getElementById('navTrackCaInput').value = mint;
  const link = document.getElementById('deskPumpLink');
  link.href = `https://pump.fun/coin/${mint}`;
  link.innerText = `View on Pump.fun (${mint.slice(0, 6)}...)`;
}

// Track CA from Nav input
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
    showToast(`Tracking token: ${mint.slice(0, 8)}...`, 'success');
  } catch (e) {
    showToast('Failed to track CA: ' + e.message, 'error');
  }
}

function copyActiveMintAddress() {
  if (state.activeToken) {
    navigator.clipboard.writeText(state.activeToken);
    showToast('Copied CA to clipboard', 'info');
  }
}

// ==================== MANUAL TRADING CONTROLS (GREEN BUY / RED SELL) ====================

function setManualBuyAmount(amt) {
  document.getElementById('manualBuySolInput').value = amt;
}

function setManualSellPct(pct) {
  document.getElementById('manualSellPctInput').value = pct;
}

// Get selected target wallet addresses
function getTargetAddresses(targetMode) {
  if (targetMode === 'dev') {
    return state.masterWallet ? [state.masterWallet.address] : [];
  }
  if (targetMode === 'selected') {
    const checked = Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => cb.value);
    return checked;
  }
  // 'all'
  const all = [];
  if (state.masterWallet) all.push(state.masterWallet.address);
  state.subWallets.forEach(w => all.push(w.address));
  return all;
}

// Execute Manual Buy (Green / Up)
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
  btn.innerHTML = `<i data-lucide="loader" class="w-5 h-5 animate-spin"></i><span>EXECUTING BUY...</span>`;

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
    btn.innerHTML = `<i data-lucide="arrow-up" class="w-5 h-5"></i><span>▲ BUY TOKENS (GREEN UP)</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

// Execute Manual Sell (Red / Down)
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
  btn.innerHTML = `<i data-lucide="loader" class="w-5 h-5 animate-spin"></i><span>EXECUTING SELL...</span>`;

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
    btn.innerHTML = `<i data-lucide="arrow-down" class="w-5 h-5"></i><span>▼ SELL TOKENS (RED DOWN)</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

// Execute Inline Quick Buy for a single wallet
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

// Execute Inline Quick Sell for a single wallet
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

// Cascade Exit
async function executeCascadeExit() {
  if (!confirm('CASCADE EXIT: Smoothly sell holdings across sub-wallets with staggered delays?')) return;
  try {
    showToast('Starting Cascade Exit...', 'info');
    const res = await fetch('/api/trading/cascade-sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delayMs: 800, pct: 100 })
    });
    const data = await res.json();
    showToast('Cascade exit successfully completed', 'success');
    loadLiveStats();
  } catch (err) {
    showToast('Cascade error: ' + err.message, 'error');
  }
}

// Panic Dump All
async function executePanicDumpAll() {
  if (!confirm('PANIC DUMP ALL: Emergency exit 100% of all tokens across Dev & Sub-wallets immediately?')) return;
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

// Multi-select table checkboxes
function selectAllTableRows(select) {
  document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = select);
  const masterCb = document.getElementById('checkAllRows');
  if (masterCb) masterCb.checked = select;
}

function toggleSelectAllRows(checked) {
  document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = checked);
}

// ==================== LIVE STATS & TABLE RENDER ====================

async function loadLiveStats() {
  try {
    const res = await fetch('/api/trading/stats');
    const data = await res.json();
    const s = data.stats;
    if (!s) return;

    if (s.activeToken) {
      state.activeToken = s.activeToken;
      updateActiveTokenUi(s.activeToken);

      document.getElementById('deskTotalTokensDisplay').innerText = s.totalTokens.toLocaleString();
      const pctOfSupply = ((s.totalTokens / 1000000000) * 100).toFixed(2);
      document.getElementById('deskTokensPctDisplay').innerText = `${pctOfSupply}% of supply owned`;

      document.getElementById('deskSolValueDisplay').innerText = `${s.currentSolValue} SOL`;
      document.getElementById('deskInvestedDisplay').innerText = `${s.totalSolInvested} SOL`;

      // Aggregate PnL Display (Green Up / Red Down)
      const pnlPrefix = s.pnlSol >= 0 ? '+' : '';
      const pnlText = `${pnlPrefix}${s.pnlSol} SOL (${pnlPrefix}${s.pnlPct}%)`;
      const pnlDisplay = document.getElementById('deskPnlDisplay');
      const pnlBadge = document.getElementById('deskPnlStatusBadge');

      pnlDisplay.innerText = pnlText;
      if (s.pnlSol >= 0) {
        pnlDisplay.className = 'text-2xl font-mono font-extrabold text-emerald-400';
        pnlBadge.className = 'badge-pnl-green';
        pnlBadge.innerText = '▲ IN PROFIT';
      } else {
        pnlDisplay.className = 'text-2xl font-mono font-extrabold text-rose-400';
        pnlBadge.className = 'badge-pnl-red';
        pnlBadge.innerText = '▼ DRAWDOWN';
      }

      // Curve progress
      document.getElementById('curveProgressBar').style.width = `${s.curveProgressPct}%`;
      document.getElementById('curveProgressText').innerText = `${s.curveProgressPct}% / 100% (Raydium Migration @ 85 SOL)`;

      // Dex metrics
      if (s.dexInfo) {
        document.getElementById('deskMcapDisplay').innerText = `$${(s.dexInfo.marketCap || 0).toLocaleString()}`;
        document.getElementById('deskPriceDisplay').innerText = `Price: $${s.dexInfo.priceUsd}`;
      } else {
        document.getElementById('deskMcapDisplay').innerText = `$${Math.round((s.curveProgressPct * 690)).toLocaleString()}`;
      }

      renderTradingWalletsTable(s.wallets);
    }
  } catch (e) {
    // ignore
  }
}

// Render Multi-Wallet Table with Green/Red PnL badges & inline buttons
function renderTradingWalletsTable(wallets) {
  const tbody = document.getElementById('tradingWalletsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  (wallets || []).forEach(w => {
    const isDev = w.role === 'Master Dev';
    const tr = document.createElement('tr');
    tr.className = 'border-b border-surface-800/60 hover:bg-surface-900/50 transition-colors';

    const pnlSol = w.pnlSol !== undefined ? w.pnlSol : 0;
    const pnlPct = w.pnlPct !== undefined ? w.pnlPct : 0;
    const pnlPrefix = pnlSol >= 0 ? '+' : '';
    const pnlClass = pnlSol >= 0 ? 'badge-pnl-green' : 'badge-pnl-red';
    const pnlSymbol = pnlSol >= 0 ? '▲' : '▼';

    tr.innerHTML = `
      <td class="py-2.5 px-3">
        <input type="checkbox" value="${w.address}" class="row-checkbox rounded border-surface-700 bg-surface-900 text-cyan-500">
      </td>
      <td class="py-2.5 px-3">
        <div class="flex items-center space-x-1.5">
          <span class="font-bold ${isDev ? 'text-amber-400' : 'text-slate-300'}">${w.role}</span>
          <span class="text-slate-500">${w.address.slice(0, 4)}...${w.address.slice(-4)}</span>
          <button onclick="navigator.clipboard.writeText('${w.address}'); showToast('Copied address', 'info')" class="text-slate-500 hover:text-cyan-400">
            <i data-lucide="copy" class="w-3 h-3"></i>
          </button>
        </div>
      </td>
      <td class="py-2.5 px-3 font-bold text-cyan-400">${(w.solBalance || 0).toFixed(3)} SOL</td>
      <td class="py-2.5 px-3 text-slate-200">${(w.tokens || 0).toLocaleString()}</td>
      <td class="py-2.5 px-3 text-slate-400">${(w.solInvested || 0).toFixed(3)} SOL</td>
      <td class="py-2.5 px-3 font-semibold text-slate-200">${(w.currentValue || 0).toFixed(3)} SOL</td>
      <td class="py-2.5 px-3 text-center">
        <span class="${pnlClass} text-[11px] font-mono">
          ${pnlSymbol} ${pnlPrefix}${pnlSol.toFixed(3)} SOL (${pnlPrefix}${pnlPct.toFixed(1)}%)
        </span>
      </td>
      <td class="py-2.5 px-3 text-right">
        <div class="flex items-center justify-end space-x-1">
          <button onclick="executeInlineBuy('${w.address}', 0.1)" class="btn-quick-buy text-[10px] py-1 px-1.5" title="Quick Buy 0.1 SOL">
            ▲ Buy
          </button>
          <button onclick="executeInlineSell('${w.address}', 50)" class="btn-quick-sell text-[10px] py-1 px-1.5" title="Sell 50%">
            ▼ 50%
          </button>
          <button onclick="executeInlineSell('${w.address}', 100)" class="btn-quick-sell text-[10px] py-1 px-1.5 bg-rose-950/60" title="Sell 100%">
            ▼ 100%
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

// ==================== VAMP & WALLET AUXILIARIES ====================

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
      card.className = 'card p-4 space-y-3 hover:border-cyan-500/50 transition-all';
      const m = t.metrics || {};
      card.innerHTML = `
        <div class="flex items-center space-x-3">
          <div class="w-12 h-12 rounded-xl bg-surface-900 border border-surface-700 flex items-center justify-center overflow-hidden flex-shrink-0">
            ${t.icon ? `<img src="${t.icon}" class="w-full h-full object-cover">` : `<i data-lucide="coins" class="w-6 h-6 text-slate-500"></i>`}
          </div>
          <div class="overflow-hidden flex-1">
            <h4 class="font-bold text-sm text-slate-100 truncate">${t.name}</h4>
            <span class="text-xs font-mono font-bold text-cyan-400 block">${t.symbol}</span>
          </div>
        </div>
        <p class="text-[11px] text-slate-400 line-clamp-2 h-8">${t.description || 'No description provided.'}</p>
        <div class="grid grid-cols-2 gap-2 text-[10px] font-mono bg-surface-900 p-2 rounded-lg border border-surface-800">
          <div><span class="text-slate-500">MCap:</span> <span class="text-slate-200 font-bold">$${(m.mcap || 0).toLocaleString()}</span></div>
          <div><span class="text-slate-500">24h Vol:</span> <span class="text-slate-200 font-bold">$${(m.volume24h || 0).toLocaleString()}</span></div>
        </div>
        <div class="flex gap-2 pt-1">
          <button onclick="vampDirect('${t.tokenAddress}')" class="btn-primary text-xs flex-1 py-1.5 flex items-center justify-center space-x-1">
            <i data-lucide="skull" class="w-3.5 h-3.5"></i>
            <span>Vamp This</span>
          </button>
          <button onclick="vampMutate2('${t.tokenAddress}')" class="btn-secondary text-xs flex-1 py-1.5 flex items-center justify-center space-x-1">
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

// Bumper Controls
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
      badge.className = 'text-xs px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono font-bold animate-pulse';
      showToast('Volume bumper started', 'success');
    } else {
      await fetch('/api/trading/bumper/stop', { method: 'POST' });
      badge.innerText = 'STOPPED';
      badge.className = 'text-xs px-2 py-0.5 rounded bg-surface-800 text-slate-400 font-mono';
      showToast('Volume bumper stopped', 'info');
    }
  } catch (err) {
    showToast('Bumper error: ' + err.message, 'error');
  }
}

// Disperse & Drain
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
    const data = await res.json();
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
    info: 'border-cyan-500/40 bg-surface-900/95 text-cyan-300',
    success: 'border-emerald-500/40 bg-surface-900/95 text-emerald-300',
    warning: 'border-amber-500/40 bg-surface-900/95 text-amber-300',
    error: 'border-rose-500/40 bg-surface-900/95 text-rose-300'
  };

  const toast = document.createElement('div');
  toast.className = `p-3 rounded-xl border shadow-xl text-xs font-semibold backdrop-blur pointer-events-auto transition-all duration-300 opacity-0 translate-y-2 ${colors[type] || colors.info}`;
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
