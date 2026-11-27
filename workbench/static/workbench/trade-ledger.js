/* UN Comtrade 需求侧面板。
 *
 * 数据由服务端注入（#trade-data），首屏不用再请求；切到本 tab 时静默刷新一次，
 * 因为用户可能刚在 SKU 台账里补了 HS 编码，那两个 tab 之间没有共享状态。
 *
 * 同步是分批的：一次 POST 只跑 6 个「编码 × 年份」，拿回 next_offset 再续。
 * 42 次上游请求按 1 次/秒节流要四十多秒，塞进一个请求会让浏览器等到超时，
 * 中间也看不到任何进度。
 */
(() => {
  const panel = document.querySelector('#trade-panel')
  if (!panel) return

  const byId = id => document.getElementById(id)
  const businessUrl = value => globalThis.TradeLoomBusiness?.businessUrl(value) || value
  const csrfToken = () => document.querySelector('meta[name="csrf-token"]')?.content || ''
  const apiBase = panel.dataset.api || businessUrl('/api/trade')

  const LEVEL_TEXT = {
    big: '需求大', mid: '需求中', small: '需求小', none: '无进口',
  }

  let state = readSeed()
  let syncing = false
  let lastRefresh = 0

  function readSeed() {
    const node = byId('trade-data')
    if (!node) return null
    try {
      return JSON.parse(node.textContent || 'null')
    } catch (_) {
      return null
    }
  }

  const escapeHtml = value => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  async function request(path, options) {
    const response = await fetch(`${apiBase}${path}`, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrfToken(),
        Accept: 'application/json',
      },
      ...options,
    })
    let payload = null
    try {
      payload = await response.json()
    } catch (_) {
      payload = null
    }
    if (!response.ok || !payload || payload.ok === false) {
      const code = payload?.error_code || `HTTP ${response.status}`
      throw new Error(code)
    }
    return payload
  }

  const getState = () => request('', { method: 'GET' })
  const postJson = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body || {}) })

  // ---------------------------------------------------------------- 渲染

  function statCells(data) {
    const coverage = data.coverage || {}
    const cells = [
      ['HS 编码', String(coverage.hs6_total ?? 0)],
      ['已同步', `${coverage.hs6_with_data ?? 0} / ${coverage.hs6_total ?? 0}`],
      ['数据年份', coverage.latest_year ? String(coverage.latest_year) : '—'],
      ['观测行', String(data.row_count ?? 0)],
      ['最近同步', shortTime(data.synced_at)],
      ['接入方式', data.settings?.has_key ? 'Subscription Key' : '免 Key 预览'],
    ]
    return cells
  }

  function shortTime(value) {
    if (!value) return '—'
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return String(value).slice(0, 16).replace('T', ' ')
    const pad = number => String(number).padStart(2, '0')
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  }

  function renderStats() {
    const box = byId('trade-stats')
    if (!box) return
    box.textContent = ''
    for (const [label, value] of statCells(state || {})) {
      const cell = document.createElement('div')
      cell.className = 'trade-stat'
      const nameSpan = document.createElement('span')
      nameSpan.textContent = label
      const valueEl = document.createElement('strong')
      valueEl.textContent = value
      cell.append(nameSpan, valueEl)
      box.append(cell)
    }
  }

  function cellHtml(cell) {
    if (!cell) {
      return '<td class="trade-cell is-void"><span class="trade-void">未同步</span></td>'
    }
    if (cell.level === 'none') {
      return `<td class="trade-cell is-none" title="${escapeHtml(cell.source_year)} 年这个编码没有进口记录">
        <b>0</b><span class="trade-sub">无进口</span></td>`
    }
    const bits = []
    if (cell.growth && cell.growth_text !== '—') bits.push(`同比 ${cell.growth_text}`)
    if (cell.cn_share !== null && cell.cn_share !== undefined) bits.push(`中国 ${cell.cn_share_text}`)
    const title = [
      `${cell.market_name || cell.market}　${cell.source_year} 年进口 ${cell.import_value_text}`,
      cell.unit_price ? `单价带 ${cell.unit_price_text}` : '净重缺失，算不出单价带',
      cell.cn_value ? `其中自中国进口 ${Math.round(cell.cn_value / 10000)} 万美元` : '',
      cell.scope === 'ledger' ? '口径：台账全部编码合计' : '',
    ].filter(Boolean).join('\n')
    return `<td class="trade-cell is-${escapeHtml(cell.level)}" title="${escapeHtml(title)}">
      <b>${escapeHtml(cell.import_value_text)}</b>
      <span class="trade-sub">${escapeHtml(bits.join(' · ') || LEVEL_TEXT[cell.level] || '')}</span>
    </td>`
  }

  function renderTable() {
    const wrap = byId('trade-table-wrap')
    const head = byId('trade-thead')
    const body = byId('trade-tbody')
    if (!wrap || !head || !body) return
    const rows = state?.matrix || []
    const markets = state?.markets || []
    if (!rows.length) {
      wrap.hidden = true
      return
    }
    wrap.hidden = false

    head.textContent = ''
    const headRow = document.createElement('tr')
    const hsTh = document.createElement('th')
    hsTh.textContent = 'HS 编码'
    const coverTh = document.createElement('th')
    coverTh.textContent = '覆盖'
    headRow.append(hsTh, coverTh)
    for (const market of markets) {
      const th = document.createElement('th')
      th.textContent = market.name
      th.className = 'trade-th-market'
      // 欧盟是五国合计，标题里写清楚，否则「欧盟 1.99 亿」会让人以为是 27 国
      th.title = market.reporters > 1
        ? `${market.full_name}：按 ${market.reporters} 个报告国合计`
        : (market.full_name || market.name)
      headRow.append(th)
    }
    head.append(headRow)

    body.textContent = ''
    for (const row of rows) {
      const tr = document.createElement('tr')
      const hs = document.createElement('td')
      hs.className = 'trade-hs'
      hs.innerHTML = `<b>${escapeHtml(row.hs6)}</b>`
      if (row.source === 'duty') {
        const badge = document.createElement('span')
        badge.className = 'trade-badge'
        badge.textContent = '关税表'
        const where = (row.duty_markets || []).join('/')
        badge.title = `这个编码来自关税表${where ? `（${where}）` : ''}：台账里逐 SKU 的 HS 还没填，`
          + '所以「覆盖」是 0——不是数据错'
        hs.append(badge)
      }
      const cover = document.createElement('td')
      cover.className = 'trade-cover'
      cover.textContent = row.sku_count ? `${row.sku_count} 个 SKU` : '—'
      tr.append(hs, cover)
      for (const market of markets) {
        // 用 tr 做临时容器：直接把 `<td>` 字符串塞进 `<td>` 会被 HTML 解析器丢掉，
        // 结果只剩下纯文本，档位配色全没了。
        const holder = document.createElement('tr')
        holder.innerHTML = cellHtml((row.markets || {})[market.code])
        const cell = holder.firstElementChild
        if (cell) tr.append(cell)
      }
      body.append(tr)
    }
  }

  function renderEmpty() {
    const box = byId('trade-empty')
    if (!box) return
    let message = ''
    let hint = ''
    if (!state) {
      message = 'Comtrade 数据暂时读不出来。'
      hint = '多半是迁移还没跑（manage.py migrate），或者本地库有问题。'
    } else if (!(state.coverage?.hs6_total)) {
      message = '还没有可查的 HS 编码。'
      hint = '先去「SKU 成本台账」把 HS 编码填上（表格的 HS 列，或用「按系列设 HS」），'
        + '或者在「关税率…」里配一条——两边任一处有编码，这里就能查。'
    } else if (!(state.coverage?.hs6_with_data)) {
      message = `${state.coverage.hs6_total} 个编码已经就绪，但还没拉过贸易数据。`
      hint = `点右上角「同步数据」，按 ${state.coverage.hs6_total} 个编码 × ${state.years?.length || 3} 个年份`
        + '去 UN Comtrade 取一遍——免费端点每秒一次，大约要等几十秒。'
    }
    box.hidden = !message
    box.innerHTML = message
      ? `<b>${escapeHtml(message)}</b><span>${escapeHtml(hint)}</span>`
      : ''
  }

  function renderNote() {
    const note = byId('trade-note')
    if (!note) return
    const missing = state?.coverage?.hs6_missing || []
    const invalid = state?.invalid || []
    const parts = []
    if (missing.length) {
      parts.push(`这些编码还没拉到数据：${missing.join('、')}`)
    }
    if (invalid.length) {
      const sample = invalid.slice(0, 3).map(item => `${item.sku}（${item.raw}）`).join('、')
      parts.push(`${invalid.length} 个 SKU 的 HS 不足 6 位，查不了：${sample}${invalid.length > 3 ? ' 等' : ''}`)
    }
    note.hidden = !parts.length
    note.textContent = parts.join('；')
  }

  function renderAll() {
    renderStats()
    renderTable()
    renderEmpty()
    renderNote()
  }

  // ---------------------------------------------------------------- 同步

  function setProgress(visible, text, ratio) {
    const box = byId('trade-progress')
    const fill = byId('trade-progress-fill')
    const label = byId('trade-progress-text')
    if (!box) return
    box.hidden = !visible
    if (fill && ratio !== undefined) fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`
    if (label && text) label.textContent = text
  }

  function setBusy(busy) {
    const button = byId('trade-sync')
    if (!button) return
    button.disabled = busy
    button.textContent = busy ? '同步中…' : '同步数据'
  }

  async function runSync() {
    if (syncing || !state) return
    syncing = true
    setBusy(true)
    setProgress(true, '准备中…', 0)
    let offset = 0
    let total = 0
    let rows = 0
    let failed = 0
    try {
      for (let guard = 0; guard < 400; guard += 1) {
        const data = await postJson('/sync', { offset, max_calls: 6 })
        total = data.total || total
        rows += data.observations || 0
        failed += (data.failed || []).length
        const ratio = total ? (data.next_offset || 0) / total : 0
        setProgress(
          true,
          `已查 ${data.next_offset || 0}/${total} 组（编码 × 年份）· 写入 ${rows} 行${failed ? ` · 失败 ${failed}` : ''}`,
          ratio,
        )
        if (data.done) break
        offset = data.next_offset || 0
      }
      setProgress(true, `完成：写入 ${rows} 行${failed ? `，${failed} 组失败` : ''}`, 1)
      state = await getState()
      renderAll()
      lastRefresh = Date.now()
      setTimeout(() => setProgress(false), 4000)
    } catch (error) {
      setProgress(true, `同步中断：${error.message}。已拉到的数据已保存，再点一次会接着补。`, 0)
    } finally {
      syncing = false
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- 设置

  function openSettings() {
    const dialog = byId('trade-settings-dlg')
    if (!dialog) return
    const key = byId('trade-key')
    const lookback = byId('trade-lookback')
    if (key) key.value = ''
    if (key) key.placeholder = state?.settings?.has_key ? '已保存（留空 = 不修改）' : '留空 = 用免 key 的预览端点'
    if (lookback) lookback.value = state?.settings?.lookback_years || 3
    const out = byId('trade-settings-out')
    if (out) out.textContent = ''
    dialog.showModal()
  }

  async function saveSettings() {
    const key = byId('trade-key')
    const lookback = byId('trade-lookback')
    const out = byId('trade-settings-out')
    const patch = { lookback_years: Number(lookback?.value || 3) }
    // 留空表示「不改」：已经存过 key 的人重新打开对话框时不该被清掉
    if (key && key.value.trim()) patch.api_key = key.value.trim()
    try {
      const payload = await postJson('/settings', { settings: patch })
      state = payload
      renderAll()
      byId('trade-settings-dlg')?.close()
    } catch (error) {
      if (out) out.textContent = `保存失败：${error.message}`
    }
  }

  // 停用 Key 是个明确动作，单给一个按钮，避免「留空保存」的歧义
  async function clearKey() {
    const out = byId('trade-settings-out')
    try {
      const payload = await postJson('/settings', { settings: { api_key: '' } })
      state = payload
      renderAll()
      const key = byId('trade-key')
      if (key) { key.value = ''; key.placeholder = '留空 = 用免 key 的预览端点' }
      if (out) out.textContent = '已改为免 Key 的预览端点。'
    } catch (error) {
      if (out) out.textContent = `取消失败：${error.message}`
    }
  }

  // ---------------------------------------------------------------- 事件

  byId('trade-sync')?.addEventListener('click', runSync)
  byId('trade-settings')?.addEventListener('click', openSettings)
  byId('trade-settings-ok')?.addEventListener('click', saveSettings)
  byId('trade-settings-cancel')?.addEventListener('click', () => byId('trade-settings-dlg')?.close())
  byId('trade-settings-clear')?.addEventListener('click', clearKey)

  document.addEventListener('pd:show', event => {
    if (event.detail?.tab !== 'trade') return
    // 切进来时静默刷新：用户可能刚在 SKU 台账补了编码，两个 tab 不共享状态
    if (Date.now() - lastRefresh < 2000) return
    getState().then(fresh => {
      state = fresh
      lastRefresh = Date.now()
      renderAll()
    }).catch(() => renderAll())
  })

  renderAll()
})()
