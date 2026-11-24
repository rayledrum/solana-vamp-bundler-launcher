const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function presentedToken(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  if (req.url) {
    try {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      return parsed.searchParams.get('token') || '';
    } catch (err) {
      return '';
    }
  }
  return '';
}

function tokenAccepted(req, token) {
  if (!token) return false;
  return safeEqual(presentedToken(req), token);
}

function createAuthMiddleware(token) {
  return function requireApiToken(req, res, next) {
    if (!tokenAccepted(req, token)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  };
}

function loadOrCreateApiToken({ envToken, filePath, log = console.log } = {}) {
  const fromEnv = String(envToken || '').trim();
  if (fromEnv) {
    log('API authentication is using API_TOKEN from the environment.');
    return { token: fromEnv, source: 'env' };
  }

  const target = filePath || path.join(__dirname, '..', 'data', 'api-token');
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8').trim();
    if (existing) {
      log(`API token loaded from ${target}. It is not printed again.`);
      return { token: existing, source: 'file' };
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  try { fs.chmodSync(path.dirname(target), 0o700); } catch (err) { /* parent may be owned elsewhere */ }
  log('Generated a new API token. It is stored with mode 0600 and printed only this once:');
  log(token);
  return { token, source: 'generated' };
}

module.exports = {
  safeEqual,
  presentedToken,
  tokenAccepted,
  createAuthMiddleware,
  loadOrCreateApiToken
};
