const DEFAULT_HOSTS = [
  'https://frontend-api-v3.pump.fun',
  'https://frontend-api-v2.pump.fun',
  'https://frontend-api.pump.fun'
];

const BROWSER_HEADERS = {
  accept: 'application/json',
  origin: 'https://pump.fun',
  referer: 'https://pump.fun/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

function pumpApiBase() {
  const raw = String(process.env.PUMP_API_BASE || '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_HOSTS[0];
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_HOSTS[0];
    return `${url.protocol}//${url.host}`;
  } catch (err) {
    return DEFAULT_HOSTS[0];
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return String(url || '');
  }
}

function isPumpFrontendUrl(value) {
  const host = hostOf(value);
  return /^frontend-api(-v\d+)?\.pump\.fun$/i.test(host);
}

function hostList() {
  const preferred = pumpApiBase();
  return [preferred, ...DEFAULT_HOSTS.filter(host => host !== preferred)];
}

function pumpUrl(path) {
  const suffix = String(path || '').startsWith('/') ? String(path) : `/${path || ''}`;
  return `${pumpApiBase()}${suffix}`;
}

function urlsFor(input) {
  const value = String(input || '');
  if (/^https?:\/\//i.test(value)) {
    if (!isPumpFrontendUrl(value)) return [value];
    const url = new URL(value);
    return hostList().map(base => `${base}${url.pathname}${url.search}`);
  }
  const path = value.startsWith('/') ? value : `/${value}`;
  return hostList().map(base => `${base}${path}`);
}

function fallbackStatus(status) {
  return status === 403 || status >= 500;
}

async function fetchPumpJson(input, options = {}) {
  const fetchImpl = options.fetch || global.fetch;
  const urls = urlsFor(input);
  const failures = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const host = hostOf(url);
    const last = index === urls.length - 1;
    let response;
    try {
      response = await fetchImpl(url, { headers: { ...BROWSER_HEADERS, ...(options.headers || {}) } });
    } catch (err) {
      const error = new Error(`${err.message} from ${host}`);
      error.host = host;
      failures.push(error);
      if (last || urls.length === 1) break;
      continue;
    }
    if (response.ok) return response.json();
    const error = new Error(`HTTP ${response.status} from ${host}`);
    error.status = response.status;
    error.host = host;
    if (!fallbackStatus(response.status) || last || urls.length === 1) {
      if (failures.length) error.message = [...failures.map(item => item.message), error.message].join('; ');
      throw error;
    }
    failures.push(error);
  }
  const error = new Error(failures.map(item => item.message).join('; ') || 'Pump API request failed');
  error.host = failures.length ? failures[failures.length - 1].host : hostOf(urls[0]);
  throw error;
}

module.exports = {
  BROWSER_HEADERS,
  pumpApiBase,
  pumpUrl,
  isPumpFrontendUrl,
  fetchPumpJson,
  hostOf
};
