// Time and price window for the candlestick chart.
// rightGap is how many newer bars sit to the right of the window.
// Zero means the view is on the latest bar and should follow new candles.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ChartView = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MIN_SPAN = 8;

  function create() {
    return { span: null, rightGap: 0, priceMin: null, priceMax: null };
  }

  function windowOf(view, count) {
    const total = Math.max(0, Number(count) || 0);
    if (total === 0) return { start: 0, end: 0, span: 0, following: true };
    const requested = view && Number(view.span) > 1 ? Number(view.span) : total;
    const span = Math.max(1, Math.min(total, requested));
    let gap = view && Number(view.rightGap) > 0 ? Number(view.rightGap) : 0;
    const maxGap = Math.max(0, total - span);
    if (gap > maxGap) gap = maxGap;
    const end = total - gap;
    const start = Math.max(0, end - span);
    return { start, end, span: end - start, following: gap <= 1e-6 };
  }

  function applyWindow(view, count, start, end) {
    const total = Math.max(0, Number(count) || 0);
    let nextStart = Math.max(0, Math.min(Number(start) || 0, total));
    let nextEnd = Math.max(nextStart, Math.min(Number(end) || 0, total));
    if (nextEnd - nextStart < 1 && total > 0) nextEnd = Math.min(total, nextStart + 1);
    const span = Math.max(0, nextEnd - nextStart);
    view.span = span >= total - 1e-6 ? null : span;
    view.rightGap = Math.max(0, total - nextEnd);
    if (view.rightGap < 1e-6) view.rightGap = 0;
    return view;
  }

  function zoomTime(view, count, factor, anchorRatio) {
    const total = Math.max(0, Number(count) || 0);
    if (total < 2) return view;
    const win = windowOf(view, total);
    const zoom = Number(factor) > 0 ? Number(factor) : 1;
    const ratio = Math.max(0, Math.min(1, Number.isFinite(Number(anchorRatio)) ? Number(anchorRatio) : 0.5));
    const nextSpan = Math.max(Math.min(MIN_SPAN, total), Math.min(total, win.span / zoom));
    const anchor = win.start + (win.span * ratio);
    let start = anchor - nextSpan * ratio;
    let end = start + nextSpan;
    if (start < 0) {
      end -= start;
      start = 0;
    }
    if (end > total) {
      start -= end - total;
      end = total;
    }
    if (start < 0) start = 0;
    return applyWindow(view, total, start, end);
  }

  function panTime(view, count, bars) {
    const total = Math.max(0, Number(count) || 0);
    const win = windowOf(view, total);
    const delta = Number(bars) || 0;
    return applyWindow(view, total, win.start + delta, win.end + delta);
  }

  function noteBarsAppended(view, added) {
    const n = Number(added) || 0;
    if (n > 0 && view && view.rightGap > 0) view.rightGap += n;
    return view;
  }

  function scalePrice(view, min, max, factor, anchorRatio) {
    const lo = Number(min);
    const hi = Number(max);
    const zoom = Number(factor);
    if (!(hi > lo) || !(zoom > 0)) return view;
    const ratio = Math.max(0, Math.min(1, Number.isFinite(Number(anchorRatio)) ? Number(anchorRatio) : 0.5));
    const anchor = lo + (hi - lo) * ratio;
    const next = (hi - lo) / zoom;
    view.priceMin = anchor - next * ratio;
    view.priceMax = view.priceMin + next;
    return view;
  }

  function panPrice(view, min, max, fraction) {
    const lo = Number(min);
    const hi = Number(max);
    const range = hi - lo;
    const shift = Number(fraction) || 0;
    if (!(range > 0)) return view;
    view.priceMin = lo + range * shift;
    view.priceMax = hi + range * shift;
    return view;
  }

  function priceRange(view, fittedMin, fittedMax) {
    const lo = Number(view && view.priceMin);
    const hi = Number(view && view.priceMax);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return { min: lo, max: hi, fitted: false };
    return { min: Number(fittedMin), max: Number(fittedMax), fitted: true };
  }

  function reset(view) {
    const target = view || create();
    target.span = null;
    target.rightGap = 0;
    target.priceMin = null;
    target.priceMax = null;
    return target;
  }

  return { create, windowOf, zoomTime, panTime, noteBarsAppended, scalePrice, panPrice, priceRange, reset, MIN_SPAN };
});
