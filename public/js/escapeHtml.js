(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.escapeHtml = api.escapeHtml;
    root.safeHttpsUrl = api.safeHttpsUrl;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeHttpsUrl(value) {
    try {
      const url = new URL(String(value == null ? '' : value).trim());
      if (url.protocol !== 'https:') return '';
      if (url.username || url.password) return '';
      return url.href;
    } catch (err) {
      return '';
    }
  }

  return { escapeHtml, safeHttpsUrl };
});
