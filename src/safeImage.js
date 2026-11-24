const dns = require('dns').promises;
const net = require('net');
const axios = require('axios');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function isPrivateIp(ip) {
  const value = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return true;
  if (value.includes(':')) {
    if (value === '::1' || value === '::') return true;
    if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80')) return true;
    if (value.startsWith('::ffff:')) return isPrivateIp(value.slice(7));
    return false;
  }
  const parts = value.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function blockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true;
  return false;
}

async function assertPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (err) {
    throw new Error('Image URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('Image URL must use https');
  if (url.username || url.password) throw new Error('Image URL must not include credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (blockedHostname(host)) throw new Error('Image URL host is not allowed');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Image URL uses a private or local address');
    return url;
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length) throw new Error('Image host did not resolve');
  for (const record of records) {
    if (isPrivateIp(record.address)) throw new Error('Image URL resolves to a private or local address');
  }
  return url;
}

async function fetchHttpsImage(value) {
  const url = await assertPublicHttpsUrl(value);
  const response = await axios.get(url.href, {
    responseType: 'arraybuffer',
    timeout: 8000,
    maxRedirects: 0,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    validateStatus: () => true
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Image URL redirects are blocked');
  }
  if (response.status !== 200) {
    throw new Error(`Image download failed (${response.status})`);
  }
  const buffer = Buffer.from(response.data || []);
  if (buffer.length === 0) throw new Error('Image download was empty');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 2MB limit');
  const contentType = String(response.headers && response.headers['content-type'] || '');
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    throw new Error('Remote URL did not return an image');
  }
  return { buffer, fileName: 'logo.png', contentType };
}

module.exports = {
  MAX_IMAGE_BYTES,
  isPrivateIp,
  blockedHostname,
  assertPublicHttpsUrl,
  fetchHttpsImage
};
