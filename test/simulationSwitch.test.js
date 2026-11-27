const test = require('node:test');
const assert = require('node:assert/strict');
const { simulationSwitchStyles, simulationModeFromUpdate, MODE_COLORS } = require('../public/js/simulationSwitch');

test('live paints rose on the live button and a LIVE badge, sim paints cyan', () => {
  const live = simulationSwitchStyles(false);
  assert.equal(live.live.pressed, true);
  assert.equal(live.sim.pressed, false);
  assert.deepEqual(
    { background: live.live.background, color: live.live.color, border: live.live.border },
    MODE_COLORS.live
  );
  assert.deepEqual(
    { background: live.sim.background, color: live.sim.color, border: live.sim.border },
    MODE_COLORS.muted
  );
  assert.equal(live.badge.display, 'inline-flex');
  assert.equal(live.badge.text, 'LIVE');
  assert.equal(live.badge.background, MODE_COLORS.live.background);
  assert.equal(live.badge.color, MODE_COLORS.live.color);
  assert.equal(live.badge.border, MODE_COLORS.live.border);
  assert.equal(live.simBanner, 'none');
  assert.equal(live.liveBanner, 'block');

  const sim = simulationSwitchStyles(true);
  assert.equal(sim.sim.pressed, true);
  assert.equal(sim.live.pressed, false);
  assert.deepEqual(
    { background: sim.sim.background, color: sim.sim.color, border: sim.sim.border },
    MODE_COLORS.sim
  );
  assert.deepEqual(
    { background: sim.live.background, color: sim.live.color, border: sim.live.border },
    MODE_COLORS.muted
  );
  assert.equal(sim.badge.display, 'none');
  assert.equal(sim.badge.text, '');
  assert.equal(sim.simBanner, 'flex');
  assert.equal(sim.liveBanner, 'none');
  assert.equal(simulationSwitchStyles(undefined).badge.display, 'none');
});

test('CONNECTED, SIMULATION_TOGGLED, and status all yield the same mode flag', () => {
  assert.equal(simulationModeFromUpdate({ type: 'CONNECTED', payload: { simulation: false } }), false);
  assert.equal(simulationModeFromUpdate({ type: 'SIMULATION_TOGGLED', payload: { simulation: false } }), false);
  assert.equal(simulationModeFromUpdate({ type: 'CONNECTED', payload: { simulation: true } }), true);
  assert.equal(simulationModeFromUpdate({ type: 'HEARTBEAT', payload: { simulation: false, slot: 1 } }), false);
  assert.equal(simulationModeFromUpdate({ simulationMode: false }), false);
  assert.equal(simulationModeFromUpdate({ success: true, simulationMode: true }), true);
  assert.equal(simulationModeFromUpdate({ type: 'CONNECTED', payload: {} }), null);
  assert.equal(simulationModeFromUpdate({ type: 'SIMULATION_TOGGLED', payload: { simulation: 'false' } }), null);
  assert.equal(simulationModeFromUpdate({ success: true }), null);
  assert.equal(simulationModeFromUpdate(null), null);
});
