(() => {
  const enabled = document.documentElement.dataset.businessEmbed === "true";

  function hasExactDesktopLocation(location, pathname) {
    try {
      const url = new URL(location.href);
      return url.protocol === "dsh-app:" && url.hostname === "app" && url.port === ""
        && url.username === "" && url.password === "" && url.pathname === pathname
        && url.search === "" && url.hash === "";
    } catch { return false; }
  }

  function hasTicketedDesktopPopoutLocation(location) {
    try {
      const url = new URL(location.href);
      const params = [...url.searchParams.entries()];
      return url.protocol === "dsh-app:" && url.hostname === "app" && url.port === ""
        && url.username === "" && url.password === "" && url.pathname === "/desktop-pane-popout.html"
        && url.hash === "" && params.length === 1 && params[0][0] === "ticket"
        && /^[A-Za-z0-9_-]{43}$/.test(params[0][1]);
    } catch { return false; }
  }

  function isDesktopPopoutRoute(location) {
    try {
      const url = new URL(location.href);
      return url.protocol === "dsh-app:" && url.hostname === "app" && url.pathname === "/desktop-pane-popout.html";
    } catch { return false; }
  }

  function isDesktopPopoutParent(parent = window.parent) {
    if (!enabled || !parent || parent === window) return false;
    try {
      return hasTicketedDesktopPopoutLocation(parent.location)
        && parent.opener !== null && parent.opener !== undefined
        && (hasExactDesktopLocation(parent.opener.location, "/")
          || hasExactDesktopLocation(parent.opener.location, "/index.html"));
    } catch { return false; }
  }

  function bridgeTarget() {
    if (!enabled || window.parent === window) return null;
    try {
      if (isDesktopPopoutRoute(window.parent.location)) {
        return isDesktopPopoutParent(window.parent) ? window.parent.opener : null;
      }
      return window.parent.location.origin === window.location.origin ? window.parent : null;
    } catch { return null; }
  }

  function isTrustedBridgeEvent(event) {
    if (!enabled || !event || event.origin !== window.location.origin) return false;
    if (event.source === window.parent) return true;
    if (!isDesktopPopoutParent(window.parent)) return false;
    try { return event.source === window.parent.opener; }
    catch { return false; }
  }

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

  globalThis.TradeLoomBusiness = { businessUrl, bridgeTarget, isTrustedBridgeEvent };
})();
