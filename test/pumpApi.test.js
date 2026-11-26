const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `pump-api-wallets-${process.pid}.json`);

const { fetchPumpJson, pumpApiBase, BROWSER_HEADERS } = require('../src/pumpApi');
const { coinsPollUrl, pollNewCoins } = require('../src/research/collector');
const { createStore } = require('../src/research/store');
const { runCollect, runCollectLoop, WATCH_BACKOFF_CAP_MS } = require('../src/research/collect');

function tempStore() {
  return createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pump-api-')));
}

describe('pump frontend api', { concurrency: 1 }, () => {

test('the client prefers v3, sends browser headers, and falls back on 530 and 403', async () => {
  const calls = [];
  const body = await fetchPumpJson('/coins?offset=0&limit=1', {
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      const host = new URL(url).host;
      if (host === 'frontend-api-v3.pump.fun') return { ok: false, status: 530 };
      if (host === 'frontend-api-v2.pump.fun') return { ok: false, status: 403 };
      return { ok: true, status: 200, json: async () => [{ mint: 'MintA' }] };
    }
  });
  assert.equal(body[0].mint, 'MintA');
  assert.deepEqual(calls.map(call => new URL(call.url).host), [
    'frontend-api-v3.pump.fun',
    'frontend-api-v2.pump.fun',
    'frontend-api.pump.fun'
  ]);
  assert.equal(calls[0].headers.origin, 'https://pump.fun');
  assert.equal(calls[0].headers.referer, 'https://pump.fun/');
  assert.equal(calls[0].headers['user-agent'], BROWSER_HEADERS['user-agent']);
  assert.equal(calls[0].url.startsWith(pumpApiBase()), true);
});

test('a 404 names the host and does not try another host', async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchPumpJson('/coins/missing', {
      fetch: async () => {
        calls += 1;
        return { ok: false, status: 404 };
      }
    }),
    /HTTP 404 from frontend-api-v3\.pump\.fun/
  );
  assert.equal(calls, 1);
});

test('PUMP_API_BASE is tried first and a 5xx still names every host', async () => {
  const previous = process.env.PUMP_API_BASE;
  process.env.PUMP_API_BASE = 'https://frontend-api.pump.fun';
  const hosts = [];
  try {
    await assert.rejects(
      () => fetchPumpJson('/coins?offset=0&limit=40', {
        fetch: async (url) => {
          hosts.push(new URL(url).host);
          return { ok: false, status: 500 };
        }
      }),
      /HTTP 500 from frontend-api\.pump\.fun/
    );
  } finally {
    if (previous == null) delete process.env.PUMP_API_BASE;
    else process.env.PUMP_API_BASE = previous;
  }
  assert.equal(hosts[0], 'frontend-api.pump.fun');
  assert.ok(hosts.includes('frontend-api-v3.pump.fun'));
  assert.equal(coinsPollUrl(), 'https://frontend-api-v3.pump.fun/coins?offset=0&limit=40&sort=created_timestamp&order=DESC&includeNsfw=false');
});

test('poll requests the configured coins URL', async () => {
  let seen = null;
  const rows = await pollNewCoins(async (url) => {
    seen = url;
    return [{ mint: 'MintA' }];
  });
  assert.equal(rows.length, 1);
  assert.equal(seen, coinsPollUrl());
  assert.match(seen, /^https:\/\/frontend-api-v3\.pump\.fun\/coins\?/);
});

test('watch logs a failed poll and retries with backoff instead of exiting', async () => {
  const waits = [];
  const errors = [];
  let calls = 0;
  const result = await runCollectLoop({
    once: false,
    interval: 1000,
    backoffStart: 15000,
    backoffCap: WATCH_BACKOFF_CAP_MS,
    sleep: async (ms) => { waits.push(ms); },
    log: { error(line) { errors.push(line); }, log() {} },
    stop: () => calls >= 3,
    collect: async () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('HTTP 530 from frontend-api.pump.fun');
        err.host = 'frontend-api.pump.fun';
        throw err;
      }
      return { added: 1 };
    }
  });
  assert.equal(result.added, 1);
  assert.deepEqual(waits, [15000, 30000]);
  assert.match(errors[0], /frontend-api\.pump\.fun/);
  assert.match(errors[1], /retrying in 15000ms/);
  assert.equal(WATCH_BACKOFF_CAP_MS, 300000);
});

test('backoff caps at five minutes', async () => {
  const waits = [];
  let calls = 0;
  await runCollectLoop({
    once: false,
    backoffStart: 200000,
    backoffCap: WATCH_BACKOFF_CAP_MS,
    sleep: async (ms) => { waits.push(ms); },
    log: { error() {}, log() {} },
    stop: () => calls >= 3,
    collect: async () => {
      calls += 1;
      if (calls < 3) throw new Error('HTTP 503 from frontend-api-v3.pump.fun');
      return { added: 0 };
    }
  });
  assert.deepEqual(waits, [200000, 300000]);
});

test('one mint failing does not abort the rest of the pass', async () => {
  const store = tempStore();
  const seen = [];
  const now = Date.now();
  const result = await runCollect({
    store,
    now,
    listCoins: async () => [
      { mint: 'MintBad', name: 'Bad', creator: 'Dev', created_timestamp: now - 10 * 60 * 1000 },
      { mint: 'MintOk', name: 'Ok', creator: 'Dev', created_timestamp: now - 10 * 60 * 1000 }
    ],
    enrich: async () => ({ safetyScore: null, devHistory: null }),
    earlyTrades: async (coin) => {
      if (coin.mint === 'MintBad') {
        const err = new Error('HTTP 530 from frontend-api-v3.pump.fun');
        err.host = 'frontend-api-v3.pump.fun';
        throw err;
      }
      return { trades: [], dev: 'Dev', createTime: now, supply: 1 };
    },
    readTape: async (mint) => {
      if (mint === 'MintBad') {
        const err = new Error('HTTP 530 from frontend-api-v3.pump.fun');
        err.host = 'frontend-api-v3.pump.fun';
        throw err;
      }
      return { trades: [], createSlot: 1, createTime: now, supply: 1 };
    },
    observe: async (mint) => {
      seen.push(mint);
      if (mint === 'MintBad') {
        const err = new Error('HTTP 530 from frontend-api-v3.pump.fun');
        err.host = 'frontend-api-v3.pump.fun';
        throw err;
      }
      return { mcapUsd: 1000 };
    }
  });
  assert.equal(result.added, 2);
  assert.ok(seen.includes('MintOk'));
  const state = store.readState().mints;
  assert.ok((state.MintOk.snapshots || []).length > 0);
  assert.equal((state.MintBad.snapshots || []).length, 0);
  assert.equal(state.MintOk.tape, true);
  assert.equal(state.MintBad.tape, undefined);
  assert.ok(store.readJsonl('snipers.jsonl').some(row => row.mint === 'MintOk'));
  assert.equal(store.readJsonl('snipers.jsonl').some(row => row.mint === 'MintBad'), false);
});

});
