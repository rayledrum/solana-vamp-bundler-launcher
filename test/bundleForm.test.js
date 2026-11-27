const test = require('node:test');
const assert = require('node:assert/strict');
const {
  emptyBundleForm,
  bundleFormFromStorage,
  rememberField,
  noteAppliedTip,
  displayValue,
  launchAmounts
} = require('../public/js/bundleForm');

test('typed sub-wallet buys survive a re-render and are what launch sends', () => {
  let form = emptyBundleForm();
  form = rememberField(form, { buyKey: 'WalletA' }, '0.04');
  form = rememberField(form, { buyKey: 'WalletB' }, '0.02');
  form = rememberField(form, 'devSolBuy', '0.08');
  form = rememberField(form, 'tip', '0.004');
  form = rememberField(form, 'walletCount', '2');

  const shown = displayValue(form, { buyKey: 'WalletA' }, { focused: false });
  assert.equal(shown.write, true);
  assert.equal(shown.value, '0.04');
  assert.equal(displayValue(form, { buyKey: 'WalletA' }, { focused: true }).write, false);
  assert.equal(displayValue(form, 'devSolBuy', { focused: true }).write, false);
  assert.equal(displayValue(form, 'tip', { focused: true }).write, false);
  assert.deepEqual(displayValue(form, 'walletCount', { focused: false }), { write: true, value: '2' });
  assert.equal(displayValue(form, { buyKey: 'WalletC' }, { focused: false }).value, '0');

  const launch = launchAmounts(form, [{ address: 'WalletA' }, { address: 'WalletB' }]);
  assert.equal(launch.devSolBuy, 0.08);
  assert.deepEqual(launch.subWalletBuys, [0.04, 0.02]);
  assert.equal(launch.jitoTipSol, 0.004);

  const stored = bundleFormFromStorage(JSON.parse(JSON.stringify(form)));
  assert.deepEqual(launchAmounts(stored, [{ address: 'WalletA' }, { address: 'WalletB' }]), launch);

  const applied = noteAppliedTip(stored, '0.005');
  assert.equal(displayValue(applied, 'tip', { focused: false }).write, false);
  assert.equal(launchAmounts(applied, [{ address: 'WalletA' }]).jitoTipSol, null);
  assert.equal(launchAmounts(applied, [{ address: 'WalletA' }]).subWalletBuys[0], 0.04);
});
