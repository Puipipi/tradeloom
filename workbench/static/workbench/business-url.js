(() => {
  const enabled = document.documentElement.dataset.businessEmbed === "true";

  function businessUrl(value) {
    if (!enabled || typeof value !== "string") return value;
    let url;
    try { url = new URL(value, window.location.href); } catch { return value; }
    if (url.origin !== window.location.origin) return value;
    if (["/business", "/business-api", "/business-static", "/business-media"].some(alias => url.pathname === alias || url.pathname.startsWith(`${alias}/`))) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
    const mappings = [
      ["/api/", "/business-api/"],
      ["/static/", "/business-static/"],
      ["/uploads/", "/business-media/"],
    ];
    for (const [internal, external] of mappings) {
      if (url.pathname === internal.slice(0, -1)) {
        url.pathname = external.slice(0, -1);
        break;
      }
      if (url.pathname.startsWith(internal)) {
        url.pathname = external + url.pathname.slice(internal.length);
        break;
      }
    }
    if (!["/business-api", "/business-static", "/business-media"].some(alias => url.pathname === alias || url.pathname.startsWith(`${alias}/`))) {
      url.pathname = `/business${url.pathname}`;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  }

  globalThis.TradeLoomBusiness = { businessUrl };
})();
