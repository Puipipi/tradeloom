"use strict";
(() => {
  const initial = document.querySelector('meta[name="enterprise-policy-revision"]')?.content;
  if (!initial) return;
  const endpoint = new URL('/enterprise/capabilities/?ui=1', location.origin).href;
  let checking = false, stopped = false, unavailable = false, generation = 0;
  const blocked = new Map();
  const notice = document.createElement('p');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  notice.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;padding:12px;z-index:9999;background:#fff4d6;color:#493700;border:1px solid #cba94b';
  document.body.append(notice);
  function privileged(element) {
    const form = element.closest('form');
    if (form?.getAttribute('action') === '/accounts/logout/') return false;
    return Boolean(element.closest('button,input[type=submit]') || element.closest('a[href^="/enterprise/console/"],a[href^="/enterprise/business/"],a[href^="/admin/"]'));
  }
  function availability(value) {
    const recovered = unavailable && value;
    unavailable = !value;
    notice.hidden = value;
    notice.textContent = value ? '' : '暂时无法核对权限，新增操作已暂停；连接恢复后会自动继续。未提交的内容已保留。';
    if (value) {
      for (const [element, previous] of blocked) {
        if (!element.isConnected) continue;
        element.inert = previous.inert;
        if (previous.aria === null) element.removeAttribute('aria-disabled'); else element.setAttribute('aria-disabled', previous.aria);
      }
      blocked.clear();
      if (recovered) window.dispatchEvent(new Event('enterprise-policy-ready'));
    } else {
      for (const element of document.querySelectorAll('button,input[type=submit],a')) {
        if (!privileged(element) || blocked.has(element)) continue;
        blocked.set(element, { inert: element.inert, aria: element.getAttribute('aria-disabled') });
        element.inert = true;
        element.setAttribute('aria-disabled', 'true');
      }
    }
  }
  for (const name of ['click', 'submit']) document.addEventListener(name, event => {
    if (unavailable && (name === 'submit' ? event.target.getAttribute('action') !== '/accounts/logout/' : privileged(event.target))) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  function replace(target) {
    stopped = true;
    const message = document.createElement('p');
    message.textContent = '权限已更新，正在打开当前可访问的页面…';
    document.body.replaceChildren(message); // Remove stale restricted data before navigation.
    location.replace(target);
  }
  async function check() {
    if (checking || stopped || document.visibilityState !== 'visible') return;
    checking = true;
    const epoch = generation, url = location.href;
    try {
      const response = await fetch(endpoint, {credentials:'same-origin', cache:'no-store', redirect:'manual', signal:AbortSignal.timeout(8000)});
      if (stopped || epoch !== generation || location.href !== url) return;
      if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) { replace('/enterprise/'); return; }
      if (!response.ok || response.redirected || response.url !== endpoint) throw new Error('Policy unavailable');
      const policy = await response.json();
      if (stopped || epoch !== generation || location.href !== url) return;
      if (!/^[a-f0-9]{64}$/.test(policy.ui_revision) || !policy.capabilities || policy.authentication?.email_verified !== true) throw new Error('Policy unavailable');
      if (policy.ui_revision !== initial) {
        const consolePage = location.pathname.startsWith('/enterprise/console/');
        const kind = location.pathname.match(/^\/enterprise\/business\/(products|customers|quotations|orders)\//)?.[1];
        const capability = {products:'business_data',customers:'customer_data',quotations:'quotation_data',orders:'order_followup'}[kind];
        replace(consolePage ? (policy.console_access ? '/enterprise/console/' + location.hash : '/enterprise/') : (capability && !policy.capabilities[capability]) ? '/enterprise/' : url);
      } else availability(true);
    } catch {
      if (!stopped && epoch === generation && location.href === url) availability(false);
    } finally { checking = false; }
  }
  let timer = setInterval(check, 5000);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('pagehide', () => { generation++; stopped = true; clearInterval(timer); timer = null; });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { generation++; stopped = false; timer = setInterval(check, 5000); availability(false); check(); }
  });
  check();
})();
