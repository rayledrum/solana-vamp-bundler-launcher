function present(value) {
  return String(value || '').trim() !== '';
}

// LIVE_TRADING and SIMULATION_MODE never select the startup mode.
function ignoredModeEnv(env = process.env) {
  const ignored = [];
  if (present(env.LIVE_TRADING)) ignored.push('LIVE_TRADING');
  if (present(env.SIMULATION_MODE)) ignored.push('SIMULATION_MODE');
  return ignored;
}

function ignoredModeMessage(env = process.env) {
  const ignored = ignoredModeEnv(env);
  if (!ignored.length) return '';
  return `Ignoring ${ignored.join(' and ')}; the desk always starts in simulation. Live mode is only the dashboard switch and is not saved across restarts.`;
}

// enabled true keeps simulation. enabled false is the live switch.
function applySimulationChange({ enabled, confirm, heliusConfigured, quicknodeConfigured, hasWallets }) {
  if (enabled !== true && enabled !== false) {
    const err = new Error('enabled must be a boolean (true or false)');
    err.statusCode = 400;
    throw err;
  }
  if (enabled === false) {
    if (confirm !== true) {
      const err = new Error('Switching to live mode requires confirm: true');
      err.statusCode = 400;
      throw err;
    }
    if (!heliusConfigured && !quicknodeConfigured) {
      const err = new Error('Cannot switch to live mode without an RPC. Set HELIUS_RPC_URL, HELIUS_API_KEY, or QUICKNODE_RPC_URL in .env and restart.');
      err.statusCode = 400;
      throw err;
    }
    if (!hasWallets) {
      const err = new Error('Cannot switch to live mode because no wallets are loaded.');
      err.statusCode = 400;
      throw err;
    }
  }
  return { simulationMode: enabled };
}

module.exports = {
  ignoredModeEnv,
  ignoredModeMessage,
  applySimulationChange
};
