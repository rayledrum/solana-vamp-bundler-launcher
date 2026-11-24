const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAuthMiddleware, loadOrCreateApiToken, tokenAccepted } = require('../src/auth');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('api middleware requires the bearer token on every request', () => {
  const middleware = createAuthMiddleware('secret-token');
  const denied = mockRes();
  let nextCalled = false;
  middleware({ headers: {}, url: '/' }, denied, () => { nextCalled = true; });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.body.error, 'Unauthorized');
  assert.equal(nextCalled, false);

  const stringFalse = mockRes();
  middleware({ headers: { authorization: 'Bearer false' }, url: '/' }, stringFalse, () => { nextCalled = true; });
  assert.equal(stringFalse.statusCode, 401);

  const allowed = mockRes();
  middleware({ headers: { authorization: 'Bearer secret-token' }, url: '/api/status' }, allowed, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(allowed.statusCode, 200);
});

test('websocket upgrade can present the same token in the query string', () => {
  assert.equal(tokenAccepted({ headers: {}, url: '/?token=secret-token' }, 'secret-token'), true);
  assert.equal(tokenAccepted({ headers: { authorization: 'Bearer secret-token' }, url: '/' }, 'secret-token'), true);
  assert.equal(tokenAccepted({ headers: {}, url: '/?token=nope' }, 'secret-token'), false);
  assert.equal(tokenAccepted({ headers: {}, url: '/' }, ''), false);
});

test('a missing API_TOKEN is generated once and stored mode 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-token-'));
  const filePath = path.join(dir, 'api-token');
  const logs = [];
  const created = loadOrCreateApiToken({ filePath, log: (line) => logs.push(line) });
  assert.equal(created.source, 'generated');
  assert.equal(created.token.length, 64);
  assert.equal((fs.statSync(filePath).mode & 0o777), 0o600);
  assert.equal(logs.some(line => line === created.token), true);

  const againLogs = [];
  const again = loadOrCreateApiToken({ filePath, log: (line) => againLogs.push(line) });
  assert.equal(again.source, 'file');
  assert.equal(again.token, created.token);
  assert.equal(againLogs.some(line => line === created.token), false);

  const fromEnv = loadOrCreateApiToken({ envToken: 'from-env', filePath, log: () => {} });
  assert.equal(fromEnv.token, 'from-env');
  assert.equal(fromEnv.source, 'env');
});
