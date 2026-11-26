/* 产品资料页的模块切换：SKU 台账 / UN Comtrade / 选品建议。
 *
 * 切换只改 hidden，不重载页面——SKU 表格 144 行、Comtrade 矩阵好几十格，
 * 每次点 tab 都重新请求一遍既慢又会让滚动位置丢掉。
 * 各面板靠 `pd:show` 事件知道自己被激活，做「首次进入才加载」。
 */
(() => {
  const tabs = Array.from(document.querySelectorAll('[data-pd-tab]'))
  const views = Array.from(document.querySelectorAll('[data-pd-view]'))
  if (!tabs.length || !views.length) return

  const STORE_KEY = 'tradeloom.products.tab'

  function show(name, persist) {
    const known = views.some(view => view.dataset.pdView === name)
    const target = known ? name : 'sku'
    for (const tab of tabs) {
      const on = tab.dataset.pdTab === target
      tab.classList.toggle('is-on', on)
      tab.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    for (const view of views) {
      view.hidden = view.dataset.pdView !== target
    }
    if (persist) {
      try { localStorage.setItem(STORE_KEY, target) } catch (_) { /* 隐私模式写不了，不影响切换 */ }
      // 记进 hash：刷新或把链接发给别人时停在同一模块，而不是每次都跳回台账
      try {
        const next = `#${target}`
        if (window.location.hash !== next) {
          history.replaceState(null, '', next)
        }
      } catch (_) { /* file:// 或受限环境忽略 */ }
    }
    document.dispatchEvent(new CustomEvent('pd:show', { detail: { tab: target } }))
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => show(tab.dataset.pdTab, true))
  }

  let initial = 'sku'
  try { initial = localStorage.getItem(STORE_KEY) || 'sku' } catch (_) { initial = 'sku' }
  // hash 优先：这是「我要直接看这个模块」的明确意图，比上次停留的记忆更强
  const fromHash = (window.location.hash || '').replace('#', '')
  if (fromHash) initial = fromHash
  show(initial, Boolean(fromHash))
})()
