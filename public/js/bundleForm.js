(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.emptyBundleForm = api.emptyBundleForm;
    root.bundleFormFromStorage = api.bundleFormFromStorage;
    root.rememberField = api.rememberField;
    root.noteAppliedTip = api.noteAppliedTip;
    root.displayValue = api.displayValue;
    root.launchAmounts = api.launchAmounts;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function emptyBundleForm() {
    return {
      devSolBuy: '0.05',
      devEdited: false,
      tipDraft: '',
      tipEdited: false,
      walletCount: '6',
      countEdited: false,
      buys: {}
    };
  }

  function cloneForm(form) {
    const source = form || emptyBundleForm();
    const buys = {};
    for (const [key, row] of Object.entries(source.buys || {})) {
      if (!key || !row) continue;
      buys[key] = { value: String(row.value), edited: row.edited === true };
    }
    return {
      devSolBuy: source.devSolBuy == null ? '0.05' : String(source.devSolBuy),
      devEdited: source.devEdited === true,
      tipDraft: source.tipDraft == null ? '' : String(source.tipDraft),
      tipEdited: source.tipEdited === true,
      walletCount: source.walletCount == null ? '6' : String(source.walletCount),
      countEdited: source.countEdited === true,
      buys
    };
  }

  function bundleFormFromStorage(raw) {
    if (!raw || typeof raw !== 'object') return emptyBundleForm();
    return cloneForm(raw);
  }

  function rememberField(form, field, value) {
    const next = cloneForm(form);
    const text = value == null ? '' : String(value);
    if (field === 'devSolBuy') {
      next.devSolBuy = text;
      next.devEdited = true;
      return next;
    }
    if (field === 'tip') {
      next.tipDraft = text;
      next.tipEdited = true;
      return next;
    }
    if (field === 'walletCount') {
      next.walletCount = text;
      next.countEdited = true;
      return next;
    }
    const key = field && field.buyKey;
    if (key) next.buys[key] = { value: text, edited: true };
    return next;
  }

  function noteAppliedTip(form, value) {
    const next = cloneForm(form);
    next.tipDraft = value == null ? '' : String(value);
    next.tipEdited = false;
    return next;
  }

  function displayValue(form, field, options) {
    const focused = Boolean(options && options.focused);
    if (focused) return { write: false, value: null };
    const current = cloneForm(form);
    if (field === 'devSolBuy') return { write: true, value: current.devSolBuy };
    if (field === 'walletCount') {
      return current.countEdited
        ? { write: true, value: current.walletCount }
        : { write: false, value: null };
    }
    if (field === 'tip') {
      return current.tipEdited
        ? { write: true, value: current.tipDraft }
        : { write: false, value: null };
    }
    const key = field && field.buyKey;
    const row = key && current.buys[key];
    if (row) return { write: true, value: row.value };
    return { write: true, value: '0' };
  }

  function launchAmounts(form, wallets) {
    const current = cloneForm(form);
    const dev = Number(current.devSolBuy);
    const buys = (wallets || []).map((wallet, index) => {
      const key = wallet && (wallet.address || wallet.pubkey) ? (wallet.address || wallet.pubkey) : ('#' + index);
      const row = current.buys[key];
      const amount = Number(row ? row.value : '0');
      return Number.isFinite(amount) && amount >= 0 ? amount : 0;
    });
    const tip = current.tipEdited ? Number(current.tipDraft) : null;
    return {
      devSolBuy: Number.isFinite(dev) && dev >= 0 ? dev : 0,
      subWalletBuys: buys,
      jitoTipSol: tip != null && Number.isFinite(tip) && tip > 0 ? tip : null
    };
  }

  return {
    emptyBundleForm,
    bundleFormFromStorage,
    rememberField,
    noteAppliedTip,
    displayValue,
    launchAmounts
  };
});
