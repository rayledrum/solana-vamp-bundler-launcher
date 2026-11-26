const STOP = new Set(['the', 'and', 'for', 'coin', 'token', 'sol', 'solana', 'pump', 'fun', 'inu', 'official', 'with', 'from', 'your', 'this', 'that', 'new']);

function keywords(text) {
  const found = String(text || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
  return [...new Set(found.filter(word => !STOP.has(word)))];
}

function windowMs(name) {
  if (name === '1h') return 60 * 60 * 1000;
  if (name === '6h') return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function trendingThemes(events, now = Date.now()) {
  const windows = ['1h', '6h', '24h'];
  const out = {};
  for (const name of windows) {
    const span = windowMs(name);
    const scores = new Map();
    for (const event of events || []) {
      const at = Number(event.at);
      if (!Number.isFinite(at) || now - at > span || now < at) continue;
      const climb = Number(event.mcapUsd);
      const prev = Number(event.prevMcapUsd);
      const climbed = Number.isFinite(climb) && Number.isFinite(prev) && prev > 0 ? (climb - prev) / prev : 0;
      const fast = event.graduated === true || climbed >= 0.5;
      if (!fast) continue;
      const weight = (event.graduated === true ? 3 : 1) + Math.min(2, Math.max(0, climbed));
      for (const word of keywords(`${event.name || ''} ${event.description || ''}`)) {
        const slot = scores.get(word) || { theme: word, count: 0, momentum: 0 };
        slot.count += 1;
        slot.momentum += weight;
        scores.set(word, slot);
      }
    }
    out[name] = [...scores.values()].sort((a, b) => b.momentum - a.momentum || b.count - a.count).slice(0, 12);
  }
  return { generatedAt: new Date(now).toISOString(), windows: out, external: [] };
}

function eventsFromResearch(launches, snapshots) {
  const byMint = new Map();
  for (const row of snapshots || []) {
    if (!row || !row.mint) continue;
    const list = byMint.get(row.mint) || [];
    list.push(row);
    byMint.set(row.mint, list);
  }
  const events = [];
  for (const launch of launches || []) {
    const series = (byMint.get(launch.mint) || []).slice().sort((a, b) => a.atMin - b.atMin);
    if (!series.length || !launch.launchedAt) continue;
    const last = series[series.length - 1];
    const first = series[0];
    events.push({
      mint: launch.mint,
      name: launch.name,
      description: launch.description,
      at: new Date(launch.launchedAt).getTime() + (Number(last.atMin) || 0) * 60000,
      mcapUsd: last.mcapUsd,
      prevMcapUsd: first.mcapUsd,
      graduated: last.graduated === true
    });
  }
  return events;
}

async function loadMeta({ store, now, externalTrends }) {
  const launches = store ? store.readJsonl('launches.jsonl') : [];
  const snapshots = store ? store.readJsonl('snapshots.jsonl') : [];
  const report = trendingThemes(eventsFromResearch(launches, snapshots), now || Date.now());
  if (typeof externalTrends === 'function') {
    const extra = await externalTrends();
    report.external = Array.isArray(extra) ? extra : [];
  }
  return report;
}

module.exports = { keywords, trendingThemes, eventsFromResearch, loadMeta };
