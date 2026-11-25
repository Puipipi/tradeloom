/* Shared URL rules for the page and the offline release checker. */
(() => {
  function safeUrl(value, image = false) {
    if (typeof value !== 'string' || !value.trim()) return '';
    const raw = value.trim();
    if (image && /^assets\/[a-z0-9_./% -]+$/i.test(raw)) {
      try {
        const decoded = decodeURIComponent(raw);
        if (/^assets\/[a-z0-9_./ -]+$/i.test(decoded) && !decoded.split('/').some(part => part === '..' || part === '.')) return raw;
      } catch { /* Invalid percent escape is not a usable local image path. */ }
      return '';
    }
    try {
      const url = new URL(raw);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  const helpers = { safeUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  else window.DSH_GO_UTILS = helpers;
})();
