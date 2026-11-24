const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  ignoredModeEnv,
  ignoredModeMessage,
  applySimulationChange
} = require('../src/simulationMode');

test('switching to live requires confirm and a configured RPC and loaded wallets', () => {
  assert.throws(
    () => applySimulationChange({ enabled: false, confirm: false, heliusConfigured: true, hasWallets: true }),
    /confirm: true/
  );
  assert.throws(
    () => applySimulationChange({ enabled: false, confirm: null, heliusConfigured: true, hasWallets: true }),
    /confirm: true/
  );
  assert.throws(
    () => applySimulationChange({ enabled: false, confirm: true, heliusConfigured: false, hasWallets: true }),
    /without an RPC/
  );
  assert.throws(
    () => applySimulationChange({ enabled: false, confirm: true, heliusConfigured: true, hasWallets: false }),
    /no wallets are loaded/
  );

  const live = applySimulationChange({ enabled: false, confirm: true, heliusConfigured: true, hasWallets: true });
  assert.equal(live.simulationMode, false);

  const back = applySimulationChange({ enabled: true, confirm: false, heliusConfigured: false, hasWallets: false });
  assert.equal(back.simulationMode, true);
});

test('LIVE_TRADING and SIMULATION_MODE are ignored and do not select a mode', () => {
  assert.deepEqual(ignoredModeEnv({}), []);
  assert.deepEqual(ignoredModeEnv({ LIVE_TRADING: 'true', SIMULATION_MODE: 'false' }), ['LIVE_TRADING', 'SIMULATION_MODE']);
  assert.match(ignoredModeMessage({ LIVE_TRADING: 'true' }), /Ignoring LIVE_TRADING/);
  assert.equal(ignoredModeMessage({}), '');
});

test('a fresh process always starts in simulation even when live env flags are set', () => {
  const script = `
    process.env.LIVE_TRADING = 'true';
    process.env.SIMULATION_MODE = 'false';
    delete process.env.HELIUS_API_KEY;
    delete process.env.HELIUS_RPC_URL;
    const config = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))});
    if (config.SIMULATION_MODE !== true) process.exit(2);
    if (config.LIVE_TRADING) process.exit(3);
    if (!config.ignoredModeEnv.includes('LIVE_TRADING') || !config.ignoredModeEnv.includes('SIMULATION_MODE')) process.exit(4);
    process.stdout.write('sim');
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sim/);
});
