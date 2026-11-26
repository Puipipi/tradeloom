/* SKU 成本台账：产品资料页顶部区块的交互。
   与其它页面一致——URL 走 TradeLoomBusiness.businessUrl()，CSRF 走 meta 标签，
   错误按 error_code 翻译，不把后端中文提示直接弹给用户。

   切市场走**局部重算**而不是整页重载：接口本来就返回完整 state（rows/summary/markets/
   fx_meta），把 DOM 更新一遍只要十几毫秒，而 window.location.reload() 要重新请求整页、
   重跑下方产品资料库的查询、重解析全部 CSS/JS——那才是「切一下卡一下」的来源。 */
(() => {
  const panel = document.querySelector('#sku-panel')
  if (!panel) return

  const businessUrl = value => globalThis.TradeLoomBusiness?.businessUrl(value) || value
  const csrfToken = () => document.querySelector('meta[name="csrf-token"]')?.content || ''
  const byId = id => document.getElementById(id)
  // 服务端渲染的路径最可靠；缺了再退回 businessUrl 推断
  const apiBase = panel.dataset.api || businessUrl('/api/sku')

  const ERROR_TEXT = {
    invalid_json: '请求格式不对',
    duplicate_json_key: '请求里有重复字段',
    invalid_arguments: '参数不合法',
    empty_content: '内容为空',
    no_sku_rows: '没有解析到 SKU 行，确认首行是表头且有一列叫 SKU',
    unknown_currency: '不支持的币种',
    unknown_market: '不支持的市场',
    invalid_hs_prefix: 'HS 前缀只能是数字、点和短横线',
    invalid_hs_code: 'HS 编码只能是数字、点和短横线，最长 40 位',
    duplicate_hs_prefix: 'HS 前缀重复了',
    invalid_duty_rate: '税率超出合理范围',
    invalid_month: '月份格式应为 2026-11',
    invalid_amount: '金额不能是负数',
    item_not_found: '找不到这个 SKU',
    fx_unavailable: '汇率源暂时不可用',
    duty_lookup_failed: '官方税则没连上（可能没网或对方接口超时）',
    duty_not_found: '官方税则里没查到这一档',
    internal: '服务内部出错，稍后再试',
  }

  const errorText = data => {
    if (data && data.error_code) return ERROR_TEXT[data.error_code] || data.error_code
    if (data && data.error) return data.error       // 兼容旧字段
    return '请求失败'
  }

  const request = async (path, body) => {
    const payload = { ...(body || {}) }
    // 带上正在看的月份：否则存一格 SKU 或刷汇率，期间费用面板会跳回本月，
    // 看着像刚填的数丢了。月份只在期间费用区选，那里是唯一入口。
    const month = byId('sku-period-month')?.value
    if (month && payload.month === undefined) payload.month = month
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken() },
      body: JSON.stringify(payload),
    })
    const data = await response.json().catch(() => ({ ok: false, error_code: 'invalid_json' }))
    if (!response.ok || data.ok === false) throw new Error(errorText(data))
    return data
  }

  // 读接口（选品建议）走 GET：不需要 CSRF，也能直接被浏览器缓存
  const requestGet = async (path, params) => {
    const query = new URLSearchParams(params || {}).toString()
    const response = await fetch(`${apiBase}${path}${query ? `?${query}` : ''}`, {
      headers: { Accept: 'application/json' },
    })
    const data = await response.json().catch(() => ({ ok: false, error_code: 'invalid_json' }))
    if (!response.ok || data.ok === false) throw new Error(errorText(data))
    return data
  }

  const toast = message => {
    const element = byId('sku-toast')
    if (!element) return
    element.textContent = message
    element.classList.add('show')
    clearTimeout(element.dataset.timer)
    element.dataset.timer = setTimeout(() => element.classList.remove('show'), 2400)
  }

  const offline = message => {
    const element = byId('sku-offline')
    if (!element) return
    element.textContent = message || ''
    element.classList.toggle('show', Boolean(message))
  }

  const text = value => (value === null || value === undefined ? '' : String(value))

  /* ---------------- 输入框回填 ---------------- */

  // 数值相等就不改写 DOM：否则 "8.00" 会被后端的 8 改成 "8"，
  // 用户正看着的数字会莫名变形，光标位置也会被打断。
  const sameNumber = (a, b) => {
    const left = a === null || a === undefined ? '' : String(a).trim()
    const right = b === null || b === undefined ? '' : String(b).trim()
    if (left === '' || right === '') return left === right
    const x = Number(left)
    const y = Number(right)
    return Number.isFinite(x) && Number.isFinite(y) ? x === y : left === right
  }

  const fillInput = (input, value, force) => {
    if (!input) return
    // 自动保存回包时别抢用户正在编辑的格子；但切市场这种「口径变了」的刷新必须覆盖，
    // 否则表格显示的旧数字与实际入账口径不一致，比打断输入更危险。
    if (!force && input === document.activeElement) return
    if (sameNumber(input.value, value)) return
    input.value = text(value)
  }

  /* ---------------- 行 ---------------- */

  const renderRow = (tr, row, force) => {
    const price = tr.querySelector('input[data-f="price"]')
    if (price) {
      fillInput(price, row.price, force)
      const previous = row.price_prev_text || ''
      price.classList.toggle('mismatch', Boolean(previous))
      price.placeholder = previous
      price.title = previous
        ? `这个 SKU 的售价原本记的是 ${row.price_prev_currency}，切到结算币种 ${row.currency || ''} 后请按新币种重填；旧值未被覆盖，切回原币种即可恢复`
        : ''
    }

    const landed = tr.querySelector('[data-c="landed"]')
    if (landed) {
      landed.textContent = text(row.landed_text)
      landed.title = `关税 ${row.duty_rate_text || '未设'}（${row.duty_source || ''}）；按 HS ${row.duty_hs || ''}`
        + (row.duty_hs_from_suggest ? '（建议值）' : '')
        + `，计征基数 ¥${Number(row.duty_base || 0).toFixed(2)}（关税 ¥${row.duty_cny_text || '—'}）`
        + `；保本售价 ¥${row.bep_text || '—'}`
    }

    const commissionCny = tr.querySelector('[data-c="commission_cny"]')
    if (commissionCny) commissionCny.textContent = text(row.commission_cny_text)

    const profit = tr.querySelector('[data-c="profit"]')
    if (profit) {
      profit.textContent = text(row.profit_text)
      profit.className = `num${row.is_loss ? ' sku-neg' : ''}`
    }

    const margin = tr.querySelector('[data-c="margin"]')
    if (margin) {
      margin.textContent = text(row.margin_text)
      margin.className = `num ${row.margin_class || ''}`.trim()
    }

    const status = tr.querySelector('[data-c="status"]')
    if (status) {
      const missing = row.missing || []
      status.innerHTML = row.status === '可算'
        ? '<span class="sku-badge">可算</span>'
        : `<span class="sku-badge pend" title="缺：${missing.join('、')}">待补 ${missing.length}</span>`
    }
    tr.dataset.status = row.status
    tr.dataset.loss = row.is_loss ? '1' : '0'
  }

  const renderSummary = summary => {
    if (!summary) return
    const put = (id, value) => {
      const element = byId(id)
      if (element) element.textContent = value
    }
    put('sku-k-total', summary.total)
    put('sku-k-ok', summary.ok)
    put('sku-k-pending', summary.pending)
    put('sku-k-loss', summary.loss_count)
    put('sku-k-margin', summary.avg_margin_text || '—')
    put('sku-k-gross', summary.gross_month_text || '—')
  }

  /* ---------------- 期间费用 ----------------
     广告/退货/店铺月费不进 SKU 行，单独登记实际发生额。
     这里只负责「填进去」和「把汇总算出来显示」，不参与任何单件成本计算。 */

  const periodBox = byId('sku-period')
  const periodHint = byId('sku-period-hint')
  // 金额文案（含 ¥ 与负号）都由 service 层给，前端只拼接前缀，不自己格式化数字
  const amount = value => (value ? value : '—')

  const renderPeriod = (period, force) => {
    if (!periodBox || !period) return
    const monthInput = byId('sku-period-month')
    if (monthInput && period.month && monthInput.value !== period.month) monthInput.value = period.month

    const data = period.data || {}
    periodBox.querySelectorAll('input[data-p]').forEach(input => {
      const key = input.dataset.p
      if (key === 'note') {
        if (input === document.activeElement && !force) return
        if (input.value !== (data.note || '')) input.value = data.note || ''
        return
      }
      fillInput(input, data[key], force)
    })

    const summary = period.summary || {}
    const put = (key, value) => {
      const element = periodBox.querySelector(`[data-p-out="${key}"]`)
      if (element) element.textContent = value
    }
    // 没登记完的费用不会凭空消失，所以正数净利只是上限，前面加「≤」。
    // 净利已经是负的时候不加：`≤−325` 读起来像"至少赚 325"，反而更糊涂——
    // 那种情况靠下面那句「净利只会更少」说明。
    const capped = Boolean(summary.missing && summary.missing.length && summary.net_profit > 0)
    put('revenue', amount(summary.revenue_text))
    put('gross', amount(summary.gross_profit_text))
    put('gross-margin', summary.gross_margin_text || '')
    put('expense', summary.expense_total_text ? `−${summary.expense_total_text}` : '—')
    put('net', summary.net_profit === null ? '—' : `${capped ? '≤' : ''}${amount(summary.net_profit_text)}`)
    put('net-margin', summary.net_margin_text || '')
    put('ad-ratio', summary.ad_ratio_text || '—')
    const netCell = periodBox.querySelector('.sku-period-cell.is-net')
    if (netCell) netCell.classList.toggle('is-loss', (summary.net_profit || 0) < 0)

    if (periodHint) {
      // 只在「该填的没填」时给一句提醒，其余状态不留文字
      const missing = summary.missing || []
      const warn = Boolean(missing.length && summary.has_expense)
      if (warn) {
        periodHint.textContent = `还有 ${missing.join('、')} 没登记，净利只会更少，这里的数是上限。`
        periodHint.hidden = false
      } else {
        periodHint.textContent = ''
        periodHint.hidden = true
      }
      periodHint.classList.toggle('is-warn', warn)
    }
  }

  const tbody = panel.querySelector('tbody')

  const applyFilter = () => {
    const keyword = (byId('sku-q')?.value || '').trim().toLowerCase()
    const state = byId('sku-state')?.value || ''
    // 系列用「选项下标」当 value，真实值放在 data-series：系列名里可能有冒号或空格，
    // 拼进 value 再拆容易拆错，这样比较永远是对整串相等判断。
    const seriesOption = byId('sku-series')?.selectedOptions?.[0]
    const series = seriesOption ? seriesOption.dataset.series : undefined
    tbody?.querySelectorAll('tr').forEach(tr => {
      let show = true
      if (keyword) {
        const name = tr.querySelector('.sku-name')
        const haystack = `${tr.dataset.sku.toLowerCase()} ${name ? name.textContent.toLowerCase() : ''}`
        if (!haystack.includes(keyword)) show = false
      }
      if (show && state === 'ok' && tr.dataset.status !== '可算') show = false
      if (show && state === 'pend' && tr.dataset.status !== '待补') show = false
      if (show && state === 'loss' && tr.dataset.loss !== '1') show = false
      if (show && series !== undefined) {
        if ((tr.dataset.series || '').trim() !== series) show = false
      }
      tr.style.display = show ? '' : 'none'
    })
  }

  // 系列下拉从行本身长出来：行里已有的系列就是全部可选项，不用后端再算一份，
  // 也不会出现「下拉里有、表里没有」的空选项。数量顺带写在标签里，方便判断筛选范围。
  const buildSeriesFilter = () => {
    const select = byId('sku-series')
    if (!select || !tbody) return
    const counts = new Map()
    tbody.querySelectorAll('tr').forEach(tr => {
      const key = (tr.dataset.series || '').trim()
      counts.set(key, (counts.get(key) || 0) + 1)
    })
    const names = [...counts.keys()].sort((a, b) => {
      if (!a) return 1                    // 空系列排最后，别占第一个位置
      if (!b) return -1
      return a.localeCompare(b, 'zh-Hans')
    })
    const fragment = document.createDocumentFragment()
    names.forEach((name, index) => {
      const option = document.createElement('option')
      option.value = String(index + 1)
      option.dataset.series = name
      option.textContent = `${name || '未分类'}（${counts.get(name)}）`
      fragment.append(option)
    })
    select.append(fragment)
  }

  const applyRows = (rows, force) => {
    const map = new Map((rows || []).map(row => [row.sku, row]))
    tbody?.querySelectorAll('tr').forEach(tr => {
      const row = map.get(tr.dataset.sku)
      if (row) renderRow(tr, row, force)
    })
    applyFilter()
  }

  /* ---------------- 市场条 ---------------- */

  const fxbar = byId('sku-fxbar')

  const setChipActive = (chip, active) => {
    if (!chip) return
    chip.classList.toggle('on', active)
    chip.setAttribute('aria-pressed', active ? 'true' : 'false')
    const code = chip.querySelector('.sku-fxchip-code')
    if (!code) return
    const mark = code.querySelector('i')
    if (active && !mark) {
      const tick = document.createElement('i')
      tick.textContent = '✓'
      code.append(tick)
    } else if (!active && mark) {
      mark.remove()
    }
  }

  function renderMarkets(list) {
    if (!fxbar || !list) return
    for (const item of list) {
      const chip = fxbar.querySelector(`[data-market="${item.code}"]`)
      if (!chip) continue
      const rate = chip.querySelector('.sku-fxchip-rate')
      if (rate) rate.textContent = item.shown_text || '—'
      const sub = chip.querySelector('.sku-fxchip-sub')
      if (sub) {
        sub.textContent = `${item.currency} · `
        if (item.duty_configured) {
          sub.append(document.createTextNode('关税已配'))
        } else {
          const warn = document.createElement('b')
          warn.className = 'warn'
          warn.textContent = '关税未配'
          sub.append(warn)
        }
      }
      chip.title = `${item.name}：1 ${item.unit_text} ≈ ${item.shown_text || '—'} CNY　${item.hint}`
      setChipActive(chip, Boolean(item.selected))
    }
  }

  function renderFxNote(meta) {
    if (!meta) return
    const note = byId('sku-fx-note')
    const rate = Number(meta.rate)
    if (!Number.isFinite(rate)) {
      if (note) {
        note.textContent = `${meta.currency || ''} 汇率暂不可用`
        note.className = 'sku-fx-note is-bad'
      }
      return
    }
    const sources = (meta.sources || []).join('/')
    if (note) {
      note.className = `sku-fx-note${meta.stale ? ' is-warn' : ''}`
      note.innerHTML = `1 ${meta.currency} = <b>${rate.toFixed(4)}</b> CNY`
        + (meta.mode === 'auto' ? '' : ' 手填')
        + (sources ? ` · ${sources}` : '')
        + (meta.stale ? '（缓存，未联网）' : '')
    }
  }

  /* ---------------- 其余随市场联动的固定元素 ---------------- */

  const renderHeader = state => {
    const th = byId('sku-th-price')
    if (th && state.price_label) th.textContent = state.price_label
    // 关税维护弹窗跟着市场走，否则会在「美国」标题下编辑欧盟的税率
    const dialog = byId('sku-duty-dlg')
    if (dialog && state.market) dialog.dataset.market = state.market
    const title = byId('sku-duty-title')
    if (title && state.market_name) title.textContent = state.market_name
    // 成本 CSV 弹窗的示例表头也带币种
    const importText = byId('sku-import-text')
    if (importText && state.price_label) {
      importText.placeholder = `sku,${state.price_label},采购价CNY,头程CNY\nVFR-01-38,2.50,8.00,1.20`
    }
  }

  const renderDutyNotice = state => {
    const box = byId('sku-duty-missing')
    if (!box) return
    box.hidden = Boolean(state.duty_ready)
    const name = byId('sku-duty-market')
    if (name) name.textContent = state.market_name || ''
    // 只提示「没配」不再够用：同一个市场可能 5806 配好了、6307 还空着，
    // 横幅必须说清是哪几个编码，否则用户以为全表都算得出来。
    const detail = byId('sku-duty-missing-text')
    if (detail) {
      detail.textContent = state.duty_missing_text
        ? `这些 HS 编码还没配税率：${state.duty_missing_text}，对应 SKU 的毛利率暂时算不出来（不按 0 蒙一个）。`
        : '还没配关税率，所以毛利率暂时算不出来（不按 0 蒙一个）。'
    }
  }

  const applyState = (payload, force) => {
    const state = payload?.state || payload
    if (!state || !state.rows) return
    applyRows(state.rows, force)
    renderSummary(state.summary)
    renderMarkets(state.markets)
    renderFxNote(state.fx_meta)
    renderHeader(state)
    renderDutyNotice(state)
    renderPeriod(state.period, force)
    // 毛利变了，建议也要跟着变：输入时不停地 save，所以这里防抖
    scheduleAdvice()
  }

  /* ---------------- 编辑自动保存 ---------------- */

  const pending = new Map()
  let timer = null
  let busy = false

  panel.addEventListener('input', event => {
    const input = event.target.closest('input[data-f]')
    if (!input) return
    input.classList.add('dirty')
    const sku = input.closest('tr')?.dataset.sku
    if (!sku) return
    if (!pending.has(sku)) pending.set(sku, {})
    pending.get(sku)[input.dataset.f] = input.value
    clearTimeout(timer)
    timer = setTimeout(flush, 700)
  })

  async function flush() {
    if (!pending.size) return true
    if (busy) return false          // 已经有一轮在跑，等它回来再刷
    busy = true
    const patch = Object.fromEntries(pending)
    try {
      const data = await request('/rows', { patch })
      for (const sku of Object.keys(patch)) {
        const current = pending.get(sku)
        if (!current) continue
        for (const field of Object.keys(patch[sku])) {
          if (current[field] === patch[sku][field]) delete current[field]
        }
        if (!Object.keys(current).length) pending.delete(sku)
      }
      applyState(data)
      panel.querySelectorAll('input.dirty').forEach(input => input.classList.remove('dirty'))
      offline('')
      return true
    } catch (error) {
      offline(`保存失败：${error.message}　改动还在页面上，别刷新；服务恢复后会自动重试。`)
      toast(`保存失败：${error.message}`)
      clearTimeout(timer)
      timer = setTimeout(flush, 4000)
      return false
    } finally {
      busy = false
      if (pending.size) {
        clearTimeout(timer)
        timer = setTimeout(flush, 900)
      }
    }
  }

  /* ---------------- 切市场：局部重算 ---------------- */

  let switchSeq = 0

  fxbar?.addEventListener('click', async event => {
    const chip = event.target.closest('.sku-fxchip')
    if (!chip || chip.classList.contains('on') || chip.disabled) return

    // 先把手上的改动落库，不然重算结果会把没保存的格子盖回去
    if (pending.size) {
      const saved = await flush()
      if (!saved) {
        toast('还有未保存的改动，先别切市场')
        return
      }
    }

    const previous = fxbar.querySelector('.sku-fxchip.on')
    const chips = fxbar.querySelectorAll('.sku-fxchip')
    chips.forEach(item => { item.disabled = true })
    // 点了就亮，不等服务端：网络往返的几十毫秒里界面不能是「没反应」
    setChipActive(chip, true)
    if (previous && previous !== chip) setChipActive(previous, false)
    panel.classList.add('is-refreshing')

    const seq = ++switchSeq
    try {
      const data = await request('/settings', { settings: { market: chip.dataset.market } })
      if (seq !== switchSeq) return            // 连点了几个市场，只用最后一次的结果
      applyState(data, true)
      offline('')
      requestAnimationFrame(() => panel.classList.remove('is-refreshing'))
    } catch (error) {
      if (seq !== switchSeq) return
      setChipActive(chip, false)
      if (previous) setChipActive(previous, true)
      panel.classList.remove('is-refreshing')
      toast(`切换市场失败：${error.message}`)
    } finally {
      chips.forEach(item => { item.disabled = false })
    }
  })

  /* ---------------- 期间费用：自动保存 ---------------- */

  const periodPending = new Map()
  let periodTimer = null
  let periodBusy = false

  periodBox?.addEventListener('input', event => {
    const input = event.target.closest('input[data-p]')
    if (!input) return
    periodPending.set(input.dataset.p, input.value)
    input.classList.add('dirty')
    clearTimeout(periodTimer)
    periodTimer = setTimeout(flushPeriod, 800)
  })

  async function flushPeriod() {
    if (!periodPending.size) return true
    if (periodBusy) return false
    periodBusy = true
    const month = byId('sku-period-month')?.value || ''
    const patch = Object.fromEntries(periodPending)
    try {
      const data = await request('/period', { month, patch })
      for (const key of Object.keys(patch)) {
        if (periodPending.get(key) === patch[key]) periodPending.delete(key)
      }
      periodBox.querySelectorAll('input.dirty').forEach(input => input.classList.remove('dirty'))
      applyState(data)
      offline('')
      return true
    } catch (error) {
      offline(`期间费用保存失败：${error.message}　改动还在页面上，别刷新。`)
      toast(`保存失败：${error.message}`)
      clearTimeout(periodTimer)
      periodTimer = setTimeout(flushPeriod, 4000)
      return false
    } finally {
      periodBusy = false
    }
  }

  // 月份只决定期间费用的归属：汇率按当前牌价算，不再按月锁定。
  async function switchMonth(month) {
    if (!month) return
    if (periodPending.size) {
      const saved = await flushPeriod()
      if (!saved) {
        toast('还有未保存的期间费用，先别切月份')
        return
      }
    }
    if (pending.size) {
      const saved = await flush()
      if (!saved) {
        toast('还有未保存的 SKU 改动，先别切月份')
        return
      }
    }
    const periodMonth = byId('sku-period-month')
    if (periodMonth) periodMonth.value = month
    panel.classList.add('is-refreshing')
    try {
      const data = await request('/period', { month })
      applyState(data, true)
      offline('')
      scheduleAdvice()
    } catch (error) {
      toast(`切换月份失败：${error.message}`)
    } finally {
      requestAnimationFrame(() => panel.classList.remove('is-refreshing'))
    }
  }

  byId('sku-period-month')?.addEventListener('change', event => switchMonth(event.target.value))

  /* ---------------- 关税率维护 ---------------- */
  const dutyDlg = byId('sku-duty-dlg')
  const dutyBody = byId('sku-duty-rows')
  const dutyOut = byId('sku-duty-out')

  const toPercentText = value => {
    const num = Number(value)
    if (!value && value !== 0) return ''
    if (!Number.isFinite(num)) return ''
    return String(Math.round(num * 100000) / 1000)
  }

  function addDutyRow(values = {}) {
    if (!dutyBody) return
    const tr = document.createElement('tr')
    const cells = [
      ['duty-hs', 'text', values.hs_prefix || '', '5806.32'],
      ['duty-base', 'decimal', toPercentText(values.base_rate), '0'],
      ['duty-extra', 'decimal', toPercentText(values.extra_rate), '0'],
      // 优惠税率只登记不算账：没办原产地证就用不上，空着比填 0 清楚
      ['duty-pref', 'decimal', toPercentText(values.preferred_rate), '—'],
      ['duty-note', 'text', values.note || '', '依据 / 生效日期'],
    ]
    for (const [cls, mode, value, placeholder] of cells) {
      const td = document.createElement('td')
      const input = document.createElement('input')
      input.className = cls
      input.inputMode = mode
      input.value = value
      input.placeholder = placeholder
      if (cls === 'duty-hs') {
        // HS 旁边挂一个「查」：填编码这一步本来就该顺带把税率取回来，
        // 不该让人另开浏览器翻税则再回来敲数字。
        const wrap = document.createElement('div')
        wrap.className = 'duty-hs-wrap'
        const go = document.createElement('button')
        go.type = 'button'
        go.className = 'duty-fetch'
        go.textContent = '查'
        go.title = '按这个编码去官方税则查现行税率'
        go.addEventListener('click', () => lookupDuty(tr))
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            lookupDuty(tr)
          }
        })
        wrap.append(input, go)
        td.append(wrap)
      } else {
        td.append(input)
      }
      tr.append(td)
    }
    const td = document.createElement('td')
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'duty-del'
    del.title = '删除这一行'
    del.textContent = '×'
    del.addEventListener('click', () => tr.remove())
    td.append(del)
    tr.append(td)
    dutyBody.append(tr)
    return tr
  }

  const dutyGroupsBox = byId('sku-duty-groups')

  // 本市场在用的 HS 编码：先说清「你有哪几种商品、各自多少 SKU、哪个还没配」，
  // 再让人填数。没有这一块，用户面对空白表格根本不知道该加几行。
  function renderDutyGroups(groups) {
    if (!dutyGroupsBox) return
    dutyGroupsBox.textContent = ''
    if (!groups || !groups.length) {
      dutyGroupsBox.hidden = true
      return
    }
    dutyGroupsBox.hidden = false
    const title = document.createElement('p')
    title.className = 'sku-duty-groups-title'
    const missing = groups.filter(group => !group.configured).length
    title.textContent = `本市场在用 ${groups.length} 个 HS 编码`
      + (missing ? `，其中 ${missing} 个还没配税率` : '，全部已配')
    dutyGroupsBox.append(title)
    for (const group of groups) {
      const row = document.createElement('div')
      row.className = `sku-duty-group${group.configured ? '' : ' is-missing'}`
      const hs = document.createElement('b')
      hs.textContent = group.hs_text || '未填编码'
      const meta = document.createElement('span')
      meta.textContent = `${group.sku_count} 个 SKU · ${group.series_text || '—'}`
      const rate = document.createElement('span')
      rate.className = 'sku-duty-group-rate'
      rate.textContent = group.configured
        ? `已配 ${group.rate_text}${String(group.source || '').includes('默认') ? '（市场默认）' : ''}`
          + (group.preferred_text ? ` · 优惠 ${group.preferred_text}` : '')
        : '未配'
      row.append(hs, meta, rate)
      dutyGroupsBox.append(row)
    }
  }

  /* ---------------- 按 HS 查官方税则 ---------------- */

  // 查回来分两类：基础（slot=base）填「基础%」，附加（反倾销/反补贴/301 加征，
  // slot=extra）填「附加%」。两栏相加才是实际税负；任何一栏空着表示「没查」，
  // 不等于零。优惠%不代填——那是要凭原产地证的。
  const pickBox = byId('sku-duty-pick')
  const pickList = byId('sku-duty-pick-list')
  const pickFoot = byId('sku-duty-pick-foot')
  const pickTitle = byId('sku-duty-pick-title')
  let pickTarget = null

  function closePick() {
    if (!pickBox) return
    pickBox.hidden = true
    pickList.textContent = ''
    pickFoot.textContent = ''
    pickTarget = null
  }

  // 填哪一格由 slot 决定。onlyEmpty 用在「自动填基础」上：已经有值了就别盖掉，
  // 人可能按实际报关口径改过。
  function fillDutyFromCandidate(tr, cand, meta, onlyEmpty) {
    if (!tr) return false
    const isExtra = cand.slot === 'extra'
    const field = tr.querySelector(isExtra ? '.duty-extra' : '.duty-base')
    let filled = false
    if (field && cand.base_rate !== null && cand.base_rate !== undefined) {
      if (!onlyEmpty || !field.value.trim()) {
        field.value = toPercentText(cand.base_rate / 100)
        filled = true
      }
    }
    const note = tr.querySelector('.duty-note')
    if (note) {
      const text = `${meta.source} ${cand.code} · ${cand.desc || ''} · ${meta.fetched_at} 抓取`.replace(/\s+/g, ' ')
      // 基础先填了备注，点附加那条时别把来源冲掉，追加条款号即可
      note.value = note.value.trim() ? `${note.value.trim()}；附加 ${cand.code}` : text
    }
    return filled
  }

  function renderPick(data, autoBase) {
    if (!pickBox) return
    pickList.textContent = ''
    pickFoot.textContent = ''
    const candidates = data.candidates || []
    const bases = candidates.filter((cand) => cand.slot !== 'extra')
    const extras = candidates.filter((cand) => cand.slot === 'extra')
    pickTitle.textContent = `${data.market_name || ''} ${data.hs || ''}`.trim()
      + (data.supported ? ` · ${data.source}` : '')

    if (!candidates.length) {
      const empty = document.createElement('p')
      empty.className = 'sku-pick-empty'
      empty.textContent = data.supported
        ? '官方税则里没查到这一档，确认编码是否写对。'
        : '这个市场没有公开查询接口，只能去官网查。'
      pickList.append(empty)
    }

    function addGroup(label, hint, rows) {
      if (!rows.length) return
      const head = document.createElement('p')
      head.className = 'sku-pick-group'
      const name = document.createElement('b')
      name.textContent = label
      head.append(name)
      if (hint) {
        const note = document.createElement('span')
        note.textContent = hint
        head.append(note)
      }
      pickList.append(head)
      for (const cand of rows) pickList.append(buildPickRow(cand, data))
    }

    function buildPickRow(cand, meta) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'sku-pick-row'
      const code = document.createElement('b')
      code.textContent = cand.code
      const desc = document.createElement('span')
      desc.className = 'sku-pick-desc'
      // note 里是法规号 / 档数 / 「需确认清单」这类关键提示，跟着描述一起显示，
      // 太长由 CSS 省略，悬停看全文。
      desc.textContent = [cand.desc, cand.note].filter(Boolean).join(' · ')
      desc.title = desc.textContent
      const rate = document.createElement('span')
      rate.className = 'sku-pick-rate'
      const hasRate = cand.base_rate !== null && cand.base_rate !== undefined
      rate.textContent = hasRate
        ? `${toPercentText(cand.base_rate / 100)}%`
        : (cand.raw || '需人工核')
      row.append(code, desc, rate)
      if (cand.slot === 'extra') {
        const tag = document.createElement('em')
        tag.className = 'sku-pick-tag is-extra'
        tag.textContent = '附加'
        row.append(tag)
      }
      if (cand.specific) {
        const tag = document.createElement('em')
        tag.className = 'sku-pick-tag'
        tag.textContent = '含从量税'
        row.append(tag)
      }
      row.addEventListener('click', () => {
        const target = pickTarget
        const isExtra = cand.slot === 'extra'
        fillDutyFromCandidate(target, cand, meta)
        toast(`已填${isExtra ? '附加' : '基础'} ${cand.code}：${rate.textContent}`)
        closePick()
      })
      return row
    }

    addGroup('基础税率', '点一条填入「基础%」', bases)
    addGroup('附加税', '反倾销 / 反补贴 / 加征，点一条填入「附加%」', extras)

    const foot = []
    if (autoBase) foot.push(`基础已自动填 ${autoBase}，再点一条附加`)
    if (data.fetched_at) foot.push(`${data.fetched_at} 取自 ${data.source}${data.cached ? '（缓存）' : ''}`)
    if ((data.warnings || []).length) foot.push(data.warnings[0])
    pickFoot.textContent = foot.join(' · ')
    if (data.source_url) {
      const link = document.createElement('a')
      link.href = data.source_url
      link.target = '_blank'
      link.rel = 'noreferrer'
      link.className = 'sku-pick-link'
      link.textContent = '官方页面'
      pickFoot.append(' ', link)
    }
    pickBox.hidden = false
  }

  async function lookupDuty(tr) {
    const input = tr?.querySelector('.duty-hs')
    const hs = input?.value.trim() || ''
    if (!hs) {
      input?.focus()
      return
    }
    const button = tr.querySelector('.duty-fetch')
    if (button) { button.disabled = true; button.textContent = '…' }
    if (dutyOut) dutyOut.textContent = ''
    if (pickBox && pickList) {
      // 欧盟那两步 TARIC 查询要十秒上下，先给个「在查」的落点，别让人以为没反应
      pickTitle.textContent = '正在查官方税则…'
      pickList.textContent = ''
      pickFoot.textContent = '欧美税则较慢，通常 3–30 秒'
      pickBox.hidden = false
    }
    try {
      const data = await request('/duty/lookup', { hs, market: dutyDlg?.dataset.market })
      const candidates = data.candidates || []
      const bases = candidates.filter((cand) => cand.slot !== 'extra')
      const extras = candidates.filter((cand) => cand.slot === 'extra')
      // 基础只有唯一一档时直接填掉，省一次点击；附加照旧让人自己选——
      // 美国那份清单不落到编码上，替人挑等于替他猜。
      let autoBase = ''
      if (bases.length === 1 && bases[0].base_rate !== null && bases[0].base_rate !== undefined) {
        const text = `${toPercentText(bases[0].base_rate / 100)}%`
        if (fillDutyFromCandidate(tr, bases[0], data, true)) autoBase = text
      }
      if (!candidates.length) {
        pickTarget = tr
        renderPick(data)
        return
      }
      if (!extras.length && bases.length === 1) {
        closePick()
        toast(autoBase
          ? `已填基础 ${bases[0].code}：${autoBase}`
          : `基础已有值（${bases[0].code} ${toPercentText(bases[0].base_rate / 100)}%），未覆盖`)
        return
      }
      pickTarget = tr
      renderPick(data, autoBase)
    } catch (error) {
      closePick()
      if (dutyOut) dutyOut.textContent = `查询失败：${error.message}`
      toast(`查询失败：${error.message}`)
    } finally {
      if (button) { button.disabled = false; button.textContent = '查' }
    }
  }

  byId('sku-duty-pick-close')?.addEventListener('click', closePick)

  async function openDutyDialog() {
    if (!dutyDlg) return
    closePick()
    dutyBody.textContent = ''
    if (dutyOut) dutyOut.textContent = ''
    if (dutyGroupsBox) { dutyGroupsBox.textContent = ''; dutyGroupsBox.hidden = true }
    try {
      const data = await request('/duty', {})
      const rows = (data && data.rows) || []
      const groups = (data && data.groups) || []
      rows.forEach(row => addDutyRow(row))
      renderDutyGroups(groups)
      // 未配的编码直接铺成待填行：编码、系列、SKU 数都带来了，只剩填税率
      const missing = groups.filter(group => !group.configured && group.hs)
      for (const group of missing) {
        const tr = addDutyRow({ hs_prefix: group.hs, base_rate: null, extra_rate: null })
        if (tr) {
          tr.dataset.auto = '1'
          tr.classList.add('is-missing')
          const note = tr.querySelector('.duty-note')
          if (note) note.placeholder = `${group.series_text || ''} ${group.sku_count} 个 SKU`.trim()
        }
      }
      if (!rows.length && !missing.length) addDutyRow()
      const noHs = groups.filter(group => !group.hs)
      if (noHs.length && dutyOut) {
        dutyOut.textContent = `有 ${noHs.reduce((sum, group) => sum + group.sku_count, 0)} 个 SKU 还没填 HS 编码，先在表格里用「按系列设 HS…」补上。`
      }
    } catch (error) {
      if (dutyOut) dutyOut.textContent = `读取失败：${error.message}`
      addDutyRow()
    }
    dutyDlg.showModal()
  }

  byId('sku-duty-open')?.addEventListener('click', openDutyDialog)
  byId('sku-duty-add')?.addEventListener('click', () => addDutyRow())
  byId('sku-duty-cancel')?.addEventListener('click', () => {
    closePick()
    dutyDlg?.close()
  })

  byId('sku-duty-ok')?.addEventListener('click', async () => {
    if (!dutyDlg || !dutyBody) return
    const rows = []
    for (const tr of dutyBody.querySelectorAll('tr')) {
      const prefix = tr.querySelector('.duty-hs')?.value.trim() || ''
      if (!prefix) continue
      const base = tr.querySelector('.duty-base')?.value.trim() || ''
      const extra = tr.querySelector('.duty-extra')?.value.trim() || ''
      const pref = tr.querySelector('.duty-pref')?.value.trim() || ''
      // 三个税率都空 = 这行还不打算配，不提交。以前空值会被写成 0%，
      // 等于把「没查过」记成「零关税」，毛利凭空变好。
      if (!base && !extra && !pref) continue
      rows.push({
        hs_prefix: prefix,
        base_rate: base,
        extra_rate: extra,
        preferred_rate: pref,
        note: tr.querySelector('.duty-note')?.value.trim() || '',
      })
    }
    const ok = byId('sku-duty-ok')
    ok.disabled = true
    try {
      const data = await request('/duty', { market: dutyDlg.dataset.market, rows })
      dutyDlg.close()
      // 税率变了只影响计算结果，表结构没变——局部重算即可，不整页刷新
      panel.classList.add('is-refreshing')
      applyState(data, true)
      requestAnimationFrame(() => panel.classList.remove('is-refreshing'))
      toast('关税率已保存，已按新税率重算')
    } catch (error) {
      if (dutyOut) dutyOut.textContent = `保存失败：${error.message}`
      toast(`保存关税率失败：${error.message}`)
    } finally {
      ok.disabled = false
    }
  })

  /* ---------------- 按子系列设 HS ---------------- */
  const hsDlg = byId('sku-hs-dlg')
  const hsBody = byId('sku-hs-rows')
  const hsOut = byId('sku-hs-out')

  // 按子系列聚合当前 HS：一个子系列里已经填了哪几个、还差多少是「建议值」。
  // 直接读表格 DOM 而不另存一份 state：页面是服务端渲染的，首次打开还没有任何
  // 接口往返；草稿值也该以用户眼前看到的输入框为准。
  function hsGroupList() {
    const map = new Map()
    for (const tr of panel.querySelectorAll('tbody tr[data-sku]')) {
      const key = (tr.dataset.series || '').trim()
      if (!key) continue
      const input = tr.querySelector('input[data-f="hs_code"]')
      const own = (input?.value || '').trim()
      const suggest = (input?.placeholder || '').trim()
      let group = map.get(key)
      if (!group) {
        // 表格显示的是「子系列，缺了退到系列」，所以这一格两种都有可能：
        // 两个字段都传，服务端先按子系列精确匹配，匹配不到再按系列兜底。
        group = { label: key, sub: key, series: key, count: 0, own: new Map(), suggest: new Map() }
        map.set(key, group)
      }
      group.count += 1
      const bucket = own ? group.own : group.suggest
      const value = own || suggest
      if (value) bucket.set(value, (bucket.get(value) || 0) + 1)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }

  const hsSummary = (bucket, prefix) => {
    const parts = []
    for (const [value, count] of bucket) parts.push(`${value} ×${count}`)
    return parts.length ? `${prefix}${parts.join(' / ')}` : ''
  }

  function openHsDialog() {
    if (!hsDlg || !hsBody) return
    hsBody.textContent = ''
    if (hsOut) hsOut.textContent = ''
    const groups = hsGroupList()
    if (!groups.length) {
      if (hsOut) hsOut.textContent = '还没有可设置的 SKU 行。'
      hsDlg.showModal()
      return
    }
    for (const group of groups) {
      const tr = document.createElement('tr')
      tr.dataset.sub = group.sub
      tr.dataset.series = group.series
      const nameTd = document.createElement('td')
      nameTd.textContent = group.label
      const countTd = document.createElement('td')
      countTd.textContent = String(group.count)
      const nowTd = document.createElement('td')
      nowTd.className = 'sku-hs-now'
      nowTd.textContent = [
        hsSummary(group.own, '已填 '),
        hsSummary(group.suggest, '建议 '),
      ].filter(Boolean).join('；') || '—'
      const setTd = document.createElement('td')
      const input = document.createElement('input')
      input.className = 'hs-input'
      const suggestKeys = [...group.suggest.keys()]
      input.placeholder = suggestKeys.length === 1 ? suggestKeys[0] : '如 5806.32'
      if (group.own.size === 1) input.value = [...group.own.keys()][0]
      tr.dataset.initial = input.value
      setTd.append(input)
      tr.append(nameTd, countTd, nowTd, setTd)
      hsBody.append(tr)
    }
    hsDlg.showModal()
  }

  byId('sku-hs-open')?.addEventListener('click', openHsDialog)
  byId('sku-hs-cancel')?.addEventListener('click', () => hsDlg?.close())

  byId('sku-hs-ok')?.addEventListener('click', async () => {
    if (!hsBody) return
    const items = []
    for (const tr of hsBody.querySelectorAll('tr')) {
      const value = tr.querySelector('.hs-input')?.value.trim() || ''
      // 没改的行不提交：默认是「只补空白」，一起提交只会多做一次无意义的全表扫描
      if (!value || value === (tr.dataset.initial || '')) continue
      items.push({ sub: tr.dataset.sub || '', series: tr.dataset.series || '', hs_code: value })
    }
    if (!items.length) {
      hsDlg?.close()
      toast('没有改动')
      return
    }
    const ok = byId('sku-hs-ok')
    ok.disabled = true
    try {
      const onlyEmpty = byId('sku-hs-only-empty')?.checked !== false
      const data = await request('/hs-bulk', { items, only_empty: onlyEmpty })
      hsDlg?.close()
      panel.classList.add('is-refreshing')
      applyState(data, true)
      requestAnimationFrame(() => panel.classList.remove('is-refreshing'))
      toast(`已写入 ${data.touched || 0} 个 SKU 的 HS 编码，关税按新编码重算`)
    } catch (error) {
      if (hsOut) hsOut.textContent = `保存失败：${error.message}`
      toast(`设置 HS 失败：${error.message}`)
    } finally {
      ok.disabled = false
    }
  })

  /* ---------------- 筛选 ---------------- */
  byId('sku-q')?.addEventListener('input', applyFilter)
  byId('sku-state')?.addEventListener('change', applyFilter)
  byId('sku-series')?.addEventListener('change', applyFilter)

  /* ---------------- 导入商品清单 ---------------- */
  const catalogDialog = byId('sku-catalog-dlg')
  byId('sku-catalog')?.addEventListener('click', () => {
    byId('sku-catalog-out').textContent = ''
    byId('sku-catalog-text').value = ''
    catalogDialog.showModal()
  })
  byId('sku-catalog-cancel')?.addEventListener('click', () => catalogDialog.close())
  byId('sku-catalog-ok')?.addEventListener('click', async function () {
    const content = byId('sku-catalog-text').value
    const output = byId('sku-catalog-out')
    if (!content.trim()) { output.textContent = '内容为空'; return }
    this.disabled = true
    try {
      const data = await request('/catalog/import', { csv: content })
      const result = data.result || {}
      output.textContent = `新增 ${result.added} 个，更新 ${result.updated} 个`
        + (result.skipped ? `，跳过 ${result.skipped} 行` : '')
        + `；清单共 ${result.total} 个 SKU`
      if (result.added) {
        // 新增 SKU 会让行集合变化，得重建表格；这种情况低频，交给整页渲染最稳，
        // 免得前端再维护一份行模板（同一套列写两遍，改一处漏一处）。
        toast(`新增 ${result.added} 个 SKU，正在刷新…`)
        // 刚加了 SKU 却停在收起状态，等于让人以为没生效——这一条顺手展开
        try {
          globalThis.localStorage?.removeItem(COLLAPSE_KEY)
        } catch {
          /* 存不了不影响刷新 */
        }
        setTimeout(() => { catalogDialog.close(); window.location.reload() }, 900)
      } else {
        applyState(data, true)
        toast('清单已更新，成本数据未动')
      }
      offline('')
    } catch (error) {
      output.textContent = `失败：${error.message}`
    } finally {
      this.disabled = false
    }
  })

  /* ---------------- 刷新汇率 ---------------- */
  const fxButton = byId('sku-fx')
  fxButton?.addEventListener('click', async () => {
    const label = fxButton.textContent
    fxButton.disabled = true
    fxButton.textContent = '取汇率…'
    try {
      const data = await request('/fx', {})
      applyState(data, true)
      const meta = (data.state || data).fx_meta || {}
      const rate = Number(meta.rate)
      toast(`${meta.currency || ''} 汇率 ${Number.isFinite(rate) ? rate.toFixed(4) : '—'}`
        + `（${meta.source_count || 0} 源校验）`)
      offline('')
    } catch (error) {
      toast(`取汇率失败：${error.message}`)
      offline(`汇率刷新失败：${error.message}　继续用上一次的缓存值。`)
    } finally {
      fxButton.disabled = false
      fxButton.textContent = label
    }
  })

  /* ---------------- 导入成本 CSV ---------------- */
  const importDialog = byId('sku-import-dlg')
  byId('sku-import')?.addEventListener('click', () => {
    byId('sku-import-out').textContent = ''
    byId('sku-import-text').value = ''
    importDialog.showModal()
  })
  byId('sku-import-cancel')?.addEventListener('click', () => importDialog.close())
  byId('sku-import-ok')?.addEventListener('click', async () => {
    const content = byId('sku-import-text').value
    const output = byId('sku-import-out')
    if (!content.trim()) { output.textContent = '内容为空'; return }
    try {
      const data = await request('/import', { csv: content })
      const result = data.result || {}
      output.textContent = `匹配 ${result.matched} 行`
        + (result.unknown_count ? `；${result.unknown_count} 个 SKU 在台账里找不到` : '')
      applyState(data, true)
      toast(`已导入 ${result.matched} 行`)
      setTimeout(() => importDialog.close(), 1000)
    } catch (error) {
      output.textContent = `失败：${error.message}`
    }
  })

  /* ---------------- 折叠 ----------------
     表格 144 行、期间费用 12 个月，两块都能收起。状态挂在根元素的类上，
     模板 head 里的内联脚本先按 localStorage 打类，首帧就是收起的；
     这里只负责点击切换与写回。两块逻辑一样，走同一个绑定函数。 */
  const COLLAPSE_KEY = 'tradeloom.sku.collapsed'
  const PERIOD_KEY = 'tradeloom.sku.period.collapsed'
  const root = document.documentElement

  const bindCollapse = (buttonId, className, storageKey, labels) => {
    const button = byId(buttonId)
    if (!button) return
    const labelBox = labels ? byId(labels.id) : null
    const paint = collapsed => {
      root.classList.toggle(className, collapsed)
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
      if (labelBox) labelBox.textContent = collapsed ? labels.off : labels.on
    }
    paint(root.classList.contains(className))
    button.addEventListener('click', () => {
      const next = !root.classList.contains(className)
      paint(next)
      try {
        globalThis.localStorage?.setItem(storageKey, next ? '1' : '0')
      } catch {
        /* 存不下就算了，本次开合已经生效 */
      }
    })
  }

  bindCollapse('sku-collapse', 'sku-table-collapsed', COLLAPSE_KEY,
    { id: 'sku-collapse-text', on: '收起表格', off: '展开表格' })
  bindCollapse('sku-period-toggle', 'sku-period-collapsed', PERIOD_KEY, null)

  /* ---------------- 导出跟随筛选 ----------------
     导出的应该是屏幕上那批行，不是全量 144 行——否则还得回 Excel 再筛一遍。
     筛选条件（关键字 / 系列 / 状态）与核算月份一起拼进查询串，后端按同一口径过滤。 */
  byId('sku-export')?.addEventListener('click', event => {
    event.preventDefault()
    const link = event.currentTarget
    if (!link.dataset.base) link.dataset.base = link.getAttribute('href') || ''
    const params = new URLSearchParams()
    const keyword = byId('sku-q')?.value.trim()
    const series = byId('sku-series')?.selectedOptions?.[0]?.dataset.series
    const state = byId('sku-state')?.value
    const month = byId('sku-period-month')?.value
    if (keyword) params.set('q', keyword)
    if (series) params.set('series', series)
    if (state) params.set('state', state)
    if (month) params.set('month', month)
    const base = link.dataset.base
    const query = params.toString()
    link.href = query ? `${base}${base.includes('?') ? '&' : '?'}${query}` : base
    // 有筛选时给一句反馈，避免「点了没反应」的错觉
    if (query) toast('按当前筛选导出')
    window.location.href = link.href
  })

  buildSeriesFilter()
  applyFilter()
})()
