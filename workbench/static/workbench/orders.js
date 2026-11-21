(() => {
  const form = document.querySelector('#order-followup-form')
  const input = document.querySelector('#order-key')
  const status = document.querySelector('#order-followup-status')
  const results = document.querySelector('#order-followup-results')
  if (!form || !input || !status || !results) return

  const labels = {
    requirements: '生产要求与 PMC 核料',
    purchase_plans: '采购计划',
    material_receipts: '物料到料',
    production_handoff: '生产交接',
    shipment_payments: '出货与回款记录',
  }
  const stateLabel = value => ({
    missing: '缺失', needs_confirmation: '待人工确认', confirmed: '已有确认记录',
    exact_match: '编号精确匹配', suggested: '候选待确认',
  }[value] || value || '未知')
  const node = (tag, text, className) => {
    const element = document.createElement(tag)
    if (text !== undefined) element.textContent = text
    if (className) element.className = className
    return element
  }
  const showOrder = order => {
    results.replaceChildren()
    results.classList.add('has-order-results')
    const summary = node('header', undefined, 'order-result-head')
    summary.append(node('h3', `订单 ${order.order_key}`), node('span', `来源匹配：${stateLabel(order.match_status)}`, 'order-match'))
    results.append(summary)
    const candidates = node('section', undefined, 'order-section order-source-section')
    candidates.append(node('h4', '来源候选'))
    if (!order.candidates.length) candidates.append(node('p', '没有精确匹配的来源候选。'))
    else {
      const list = node('ul')
      for (const candidate of order.candidates) {
        list.append(node('li', `${candidate.candidate_type} · ${stateLabel(candidate.relation)} · ${stateLabel(candidate.review_status)}`))
      }
      candidates.append(list)
    }
    results.append(candidates)
    const inquirySection = node('section', undefined, 'order-section order-source-section')
    inquirySection.append(node('h4', '询报价与商业来源'))
    if (!order.inquiries.length) inquirySection.append(node('p', '暂无匹配的商业来源记录。'))
    else {
      const list = node('ul')
      for (const inquiry of order.inquiries) {
        list.append(node('li', `${inquiry.document_reference || '无来源编号'} · ${inquiry.party || '未记录往来方'} · ${inquiry.item_description || '未记录品名'} · ${inquiry.quantity || '数量缺失'} ${inquiry.unit || ''} · ${stateLabel(inquiry.review_status)}`))
      }
      inquirySection.append(list)
    }
    results.append(inquirySection)
    for (const [key, label] of Object.entries(labels)) {
      const group = order[key]
      const section = node('section', undefined, `order-section order-stage-${key}`)
      section.append(node('h4', `${label} · ${stateLabel(group.status)}`))
      if (!group.records.length) section.append(node('p', '暂无记录。'))
      else {
        const list = node('ul')
        for (const row of group.records) {
          if (key === 'requirements') {
            const check = row.pmc_material_check
            list.append(node('li', `版本 ${row.revision} · ${stateLabel(row.status)} · PMC ${stateLabel(check?.state)}`))
          } else if (key === 'purchase_plans') list.append(node('li', `${row.material} · ${row.quantity} ${row.unit} · ${stateLabel(row.status)}`))
          else if (key === 'material_receipts') list.append(node('li', `${row.material} · ${row.quantity} ${row.unit} · ${row.received_on || '未记录日期'} · ${stateLabel(row.status)}`))
          else list.append(node('li', `${row.kind === 'payment' ? '回款' : '出货'} · ${row.reference || '未填写关联编号'} · ${row.amount} ${row.currency} · ${stateLabel(row.status)}`))
        }
        section.append(list)
      }
      results.append(section)
    }
    const erp = order.erpnext
    const erpSection = node('section', undefined, 'order-section order-erp-section')
    erpSection.append(node('h4', `ERPNext · ${stateLabel(erp.status)}`))
    erpSection.append(node('p', `此读取适配器支持：${erp.supported_doctypes.join('、')}。`))
    erpSection.append(node('p', `当前适配器不支持：${erp.unsupported_doctypes.join('、')}；不会生成跳转链接。`))
    erpSection.append(node('p', 'Purchase Order 可读取；当前未找到可验证的同单关系，因此不会将同名采购单作为此销售订单的链接。'))
    for (const record of erp.records) {
      if (record.name !== order.order_key || !['Sales Order', 'Purchase Order'].includes(record.doctype)) continue
      const link = node('a', `${record.doctype} · ${record.name}`)
      link.href = record.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      erpSection.append(link)
    }
    results.append(erpSection)
  }
  const search = async key => {
    status.textContent = '正在读取订单跟进记录…'
    results.replaceChildren()
    try {
      const apiUrl = globalThis.TradeLoomBusiness?.businessUrl(`/api/orders?order_key=${encodeURIComponent(key)}`)
        || `/api/orders?order_key=${encodeURIComponent(key)}`
      const response = await fetch(apiUrl, { headers: { Accept: 'application/json' } })
      const body = await response.json()
      if (!response.ok || body.ok !== true || body.order?.order_key !== key) throw new Error(body.error_code || 'invalid_order_followup')
      showOrder(body.order)
      status.textContent = '订单跟进读取完成。'
      history.replaceState(null, '', `/business/orders?order_key=${encodeURIComponent(key)}`)
    } catch (error) {
      status.textContent = `读取失败：${error.message || 'request_failed'}`
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    const key = input.value
    if (key && key.length <= 140 && key === key.trim()) search(key)
    else status.textContent = '请输入 1 至 140 个字符的完整订单编号，不要在编号前后添加空格。'
  })
  const initial = new URLSearchParams(location.search).get('order_key')
  if (initial) {
    input.value = initial
    search(initial)
  }
})()
