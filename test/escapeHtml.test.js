const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, safeHttpsUrl } = require('../public/js/escapeHtml');

test('escapeHtml neutralizes markup that would run from token metadata', () => {
  const hostile = `<img src=x onerror="alert('xss')"> & "quotes"`;
  const escaped = escapeHtml(hostile);
  assert.equal(escaped.includes('<'), false);
  assert.equal(escaped.includes('>'), false);
  assert.equal(escaped.includes('"'), false);
  assert.equal(escaped.includes("'"), false);
  assert.match(escaped, /&lt;img/);
  assert.match(escaped, /&#39;xss&#39;/);
  assert.match(escaped, /&amp;/);
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('only https URLs are kept for links and images', () => {
  assert.equal(safeHttpsUrl('https://cdn.example.com/icon.png'), 'https://cdn.example.com/icon.png');
  assert.equal(safeHttpsUrl('http://cdn.example.com/icon.png'), '');
  assert.equal(safeHttpsUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpsUrl('https://user:pass@cdn.example.com/a.png'), '');
  assert.equal(safeHttpsUrl('not a url'), '');
  assert.equal(safeHttpsUrl(''), '');
});
