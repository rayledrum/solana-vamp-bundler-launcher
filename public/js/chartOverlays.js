// Which chart overlays are drawn. Stored apart from the candle series,
// so a token switch or a chart reset does not turn them back on.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ChartOverlays = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STORAGE_KEY = 'chartOverlays';
  const IDS = ['volume', 'ma', 'priceLine', 'markers'];

  function defaults() {
    return { volume: true, ma: true, priceLine: true, markers: true };
  }

  function normalize(raw) {
    const next = defaults();
    if (!raw || typeof raw !== 'object') return next;
    IDS.forEach(id => {
      if (typeof raw[id] === 'boolean') next[id] = raw[id];
    });
    return next;
  }

  function load(storage) {
    try {
      const raw = storage && storage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      return normalize(JSON.parse(raw));
    } catch (err) {
      return defaults();
    }
  }

  function save(storage, overlays) {
    if (!storage || typeof storage.setItem !== 'function') return normalize(overlays);
    const next = normalize(overlays);
    try { storage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (err) { /* storage can be blocked */ }
    return next;
  }

  function toggle(overlays, id) {
    const next = normalize(overlays);
    if (!Object.prototype.hasOwnProperty.call(next, id)) return next;
    next[id] = !next[id];
    return next;
  }

  return { STORAGE_KEY, IDS, defaults, normalize, load, save, toggle };
});
