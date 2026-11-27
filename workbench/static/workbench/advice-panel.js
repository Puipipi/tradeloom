/* 选品建议面板。
 *
 * 从 sku-ledger.js 搬出来独立成模块：它读两份数据（成本侧毛利 + 需求侧进口额），
 * 和台账「一行一个 SKU」不是一回事。混在台账里既拖慢首屏，也容易让人以为
 * 它只是表格的附注。
 *
 * 只在切到本 tab 时才算：一次建议要把七个市场各算一遍，比读表格慢得多。
 */
(() => {
  const panel = document.querySelector('#advice-panel')
  if (!panel) return

  const byId = id => document.getElementById(id)
  const businessUrl = value => globalThis.TradeLoomBusiness?.businessUrl(value) || value
  const apiBase = panel.dataset.api || businessUrl('/api/advice')

  const ADVICE_TAG = {
    // 「没量」排在第一位：这是需求侧唯一能推翻成本结论的场景，
    // 也是只看毛利时最容易踩的坑，值得让它先被看见。
    no_demand: ['没量', 'is-starved'],
    switch: ['换市场', 'is-switch'],
    fill: ['补税率', 'is-fill'],
    loss: ['亏损', 'is-loss'],
    thin: ['薄利', 'is-thin'],
  }

  const LEVEL_CLASS = {
    big: 'is-big', mid: 'is-mid', small: 'is-small', none: 'is-none', unknown: 'is-void',
  }

  let seq = 0
  let loaded = false
  let loading = false

  async function load(force) {
    if (loading) return
    if (loaded && !force) return
    loading = true
    const current = ++seq
    const badge = byId('advice-badge')
    if (badge) { badge.textContent = '正在算…'; badge.className = 'sku-advice-badge' }
    try {
      const response = await fetch(apiBase, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      const payload = await response.json()
      if (!response.ok || payload.ok === false) {
        throw new Error(payload?.error_code || `HTTP ${response.status}`)
      }
      if (current !== seq) return
      loaded = true
      render(payload.advice)
    } catch (error) {
      if (current !== seq) return
      if (badge) { badge.textContent = '算不出'; badge.className = 'sku-advice-badge' }
      const headline = byId('advice-headline')
      if (headline) headline.textContent = `算不出来：${error.message}`
    } finally {
      if (current === seq) loading = false
    }
  }

  function render(advice) {
    if (!advice) return
    const badge = byId('advice-badge')
    if (badge) {
      const count = (advice.suggestions || []).length
      badge.textContent = count ? `${count} 条建议` : (advice.hint ? '待补数据' : '暂无建议')
      badge.className = `sku-advice-badge${count ? ' is-on' : ''}`
    }
    const headline = byId('advice-headline')
    if (headline) headline.textContent = advice.headline || ''
    const hintBox = byId('advice-hint')
    if (hintBox) {
      hintBox.textContent = advice.hint || ''
      hintBox.hidden = !advice.hint
    }
    renderMarkets(advice.markets || [])
    renderList(advice)
  }

  function renderMarkets(markets) {
    const box = byId('advice-markets')
    if (!box) return
    box.textContent = ''
    const usable = markets.filter(item => item.ready)
    const top = usable.length ? Math.max(...usable.map(item => item.avg_margin || 0)) : 0
    for (const item of markets) {
      const line = document.createElement('div')
      line.className = 'sku-advice-market'

      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = item.name

      const bar = document.createElement('span')
      bar.className = 'bar'
      const fill = document.createElement('i')
      const ratio = item.avg_margin && top ? Math.max(0.04, item.avg_margin / top) : 0
      fill.style.width = `${ratio * 100}%`
      bar.append(fill)

      const value = document.createElement('span')
      value.className = 'value'
      value.textContent = item.avg_margin_text || '—'

      // 需求列：进口额 + 档位。没有同步过就写「需求未知」，
      // 不能写成 0——那是「还没查」，不是「没有量」。
      const demand = document.createElement('span')
      const level = item.demand_level || 'unknown'
      demand.className = `demand ${LEVEL_CLASS[level] || 'is-void'}`
      const amount = document.createElement('b')
      amount.textContent = item.trade ? item.demand_text : '需求未知'
      const tag = document.createElement('i')
      tag.textContent = item.trade ? (item.demand_level_text || '') : ''
      demand.append(amount, tag)
      if (item.trade) {
        demand.title = [
          `${item.demand_level_text}：这批编码在该市场一年进口 ${item.demand_text}`,
          item.trade.scope === 'ledger' ? '口径：台账全部编码合计（逐 SKU 的 HS 还没填）' : '',
        ].filter(Boolean).join('\n')
      } else {
        demand.title = '还没同步这个市场的贸易数据。切到「UN Comtrade」拉一遍。'
      }

      const meta = document.createElement('span')
      meta.className = 'meta'
      meta.textContent = item.ready
        ? `${item.ready}/${item.total} 可算${item.loss ? ` · 亏 ${item.loss}` : ''}`
        : '未配税率'

      line.append(name, bar, value, demand, meta)
      box.append(line)
    }
  }

  function renderList(advice) {
    const list = byId('advice-list')
    if (!list) return
    list.textContent = ''
    const suggestions = advice.suggestions || []
    if (!suggestions.length) {
      const empty = document.createElement('li')
      empty.className = 'sku-advice-empty'
      empty.textContent = advice.hint
        ? '配置好各市场税率后，这里会列出「换哪个市场更赚」的具体建议。'
        : '当前没有需要提醒的：能算的 SKU 在各市场都不亏，也没有明显的市场差。'
      list.append(empty)
      return
    }
    for (const item of suggestions) {
      const row = document.createElement('li')
      const [label, cls] = ADVICE_TAG[item.kind] || ['提示', '']
      row.className = `sku-advice-item ${cls}`
      const tag = document.createElement('em')
      tag.className = 'tag'
      tag.textContent = label
      const sku = document.createElement('b')
      sku.className = 'sku'
      sku.textContent = item.sku
      const text = document.createElement('span')
      text.className = 'txt'
      text.textContent = item.text
      row.append(tag, sku, text)
      list.append(row)
    }
  }

  byId('advice-refresh')?.addEventListener('click', () => load(true))

  document.addEventListener('pd:show', event => {
    if (event.detail?.tab !== 'advice') return
    // 只在首次进入或数据被标记过期时算；重算按钮可以强制刷新
    load(false)
  })

  // 默认 tab 是 SKU，但如果用户上次停在建议页，tabs 脚本会立刻切过来，
  // 那次 pd:show 是同步派发的，可能早于这里注册监听——兜一次。
  const visible = !panel.hidden
  if (visible) load(false)
})()
