(() => {
  const storageKey = 'uiScenePanelTabs:v1'
  const bars = new WeakMap()
  const dragThreshold = 8
  let drag
  let suppressClick

  function store() {
    try {
      const value = JSON.parse(window.localStorage.getItem(storageKey))
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return {} }
  }

  function normalize(value, ids) {
    if (value === undefined) return ids.map(id => ({ slot: id, tabs: [id], active: id }))
    if (!Array.isArray(value)) return null
    const slots = new Set(), tabs = new Set()
    for (const group of value) {
      if (!group || !ids.includes(group.slot) || slots.has(group.slot) || !Array.isArray(group.tabs)
        || !group.tabs.includes(group.active)) return null
      slots.add(group.slot)
      for (const id of group.tabs) {
        if (!ids.includes(id) || tabs.has(id)) return null
        tabs.add(id)
      }
    }
    return tabs.size === ids.length ? value : null
  }

  const panelIds = info => info.geometry.map(panel => panel.id)
  function reconcile(value, ids) {
    if (!Array.isArray(value)) return null
    const priorIds = value.flatMap(group => Array.isArray(group?.tabs) ? group.tabs : [])
    if (new Set(priorIds).size !== priorIds.length || !normalize(value, priorIds)) return null
    const retained = value.map(group => ({
      ...group, tabs: group.tabs.filter(id => ids.includes(id)),
    })).filter(group => group.tabs.length)
    const occupied = new Set(retained.filter(group => ids.includes(group.slot)).map(group => group.slot))
    for (const group of retained) {
      if (!group.tabs.includes(group.active)) group.active = group.tabs[0]
      if (ids.includes(group.slot)) continue
      group.slot = group.tabs.find(id => !occupied.has(id))
        ?? ids.find(id => priorIds.includes(id) && !occupied.has(id))
      occupied.add(group.slot)
    }
    const reconciled = retained.concat(ids.filter(id => !priorIds.includes(id)).map(id => ({ slot: id, tabs: [id], active: id })))
    return normalize(reconciled, ids)
  }

  function groups(info) {
    const ids = panelIds(info)
    const saved = store()[info.sceneId]
    return normalize(saved, ids) ?? reconcile(saved, ids) ?? normalize(undefined, ids)
  }

  function nextStore(info, value) {
    const next = store()
    if (!value || value.every(group => group.tabs.length === 1 && group.tabs[0] === group.slot)) delete next[info.sceneId]
    else next[info.sceneId] = value
    return next
  }

  function visible(info, layout = groups(info), closed = info.panels.filter(panel => panel.classList.contains('pi-closed')).map(panel => panel.dataset.panelId)) {
    const active = new Map()
    for (const group of layout) {
      const tabs = group.tabs.filter(id => !closed.includes(id))
      const id = tabs.includes(group.active) ? group.active : tabs[0]
      if (id) active.set(group.slot, id)
    }
    return active
  }

  function replace(info, value) {
    try { window.localStorage.setItem(storageKey, JSON.stringify(nextStore(info, value))) }
    catch { return false }
    window.dispatchEvent(new CustomEvent('scene-panel-tabs-changed'))
    return true
  }

  function render(info) {
    const layout = groups(info)
    const active = visible(info, layout)
    const byId = new Map(info.panels.map(panel => [panel.dataset.panelId, panel]))
    for (const group of layout) {
      const selected = active.get(group.slot)
      const available = group.tabs.filter(id => !byId.get(id).classList.contains('pi-closed'))
      for (const id of group.tabs) {
        const panel = byId.get(id)
        panel.classList.toggle('pi-tab-inactive', id !== selected)
        panel.setAttribute('aria-hidden', String(id !== selected))
        const header = panel.querySelector('.panel-header')
        if (!header) continue
        let bar = bars.get(panel)
        if (!bar) {
          bar = document.createElement('div')
          bar.className = 'pi-component-tabs'
          bar.setAttribute('role', 'tablist')
          bar.setAttribute('aria-label', '面板组件')
          header.insertBefore(bar, header.querySelector('.workflow-header-actions') || header.querySelector('.panel-controls'))
          bars.set(panel, bar)
        }
        const signature = JSON.stringify([available, selected])
        if (bar.dataset.signature === signature) continue
        bar.dataset.signature = signature
        bar.replaceChildren(...available.map(tabId => {
          const button = document.createElement('button')
          button.type = 'button'
          button.dataset.componentTab = tabId
          button.setAttribute('role', 'tab')
          button.setAttribute('aria-selected', String(tabId === selected))
          button.textContent = byId.get(tabId).querySelector('.panel-title')?.textContent || tabId
          return button
        }))
      }
    }
    return active
  }

  function infoFor(panel) {
    const grid = panel?.closest('#grid')
    const info = grid && window.sourcePanelTabs.getSceneInfo?.(grid)
    return info ? { ...info, grid } : null
  }

  function canMove(panel) {
    return !panel.classList.contains('panel-expanded') && !panel.classList.contains('pi-maximized')
      && window.businessBridge?.panelMenuCapabilities?.(panel)?.placement !== 'popped-out'
  }

  function slotPanel(panel) {
    const info = infoFor(panel)
    if (!info) return panel
    const group = groups(info).find(group => group.tabs.includes(panel.dataset.panelId))
    return info.panels.find(item => item.dataset.panelId === group?.slot) ?? panel
  }

  function dropTarget(state, x, y) {
    const hit = document.elementFromPoint(x, y)
    const bar = hit?.closest('.pi-component-tabs')
    const panel = hit?.closest('#grid > .panel')
    if (panel && (!state.info.panels.includes(panel) || !canMove(panel))) return null
    const active = visible(state.info, state.layout)
    if (panel && bar) {
      const seat = [...active].find(([, id]) => id === panel.dataset.panelId)?.[0]
      const group = state.layout.find(item => item.slot === seat)
      if (!group) return null
      const tab = hit.closest('[data-component-tab]')
      let index = group.tabs.length
      if (tab) {
        const rect = tab.getBoundingClientRect()
        index = group.tabs.indexOf(tab.dataset.componentTab) + Number(x > rect.left + rect.width / 2)
      }
      return { panel, group, index }
    }
    if (state.source.tabs.length < 2 || !state.leftStrip
      || (hit !== state.info.grid && !hit?.closest('.panel-content'))) return null
    const occupied = new Set(state.layout.map(group => group.slot))
    const overlaps = (a, b) => a.col < b.col + b.w && b.col < a.col + a.w
      && a.row < b.row + b.h && b.row < a.row + a.h
    const free = state.info.geometry.filter(item => !occupied.has(item.id)
      && !state.info.geometry.some(other => occupied.has(other.id) && overlaps(item, other)))
    if (panel) {
      const bounds = panel.getBoundingClientRect()
      const atEdge = Math.min(x - bounds.left, bounds.right - x) <= bounds.width * .2
        || Math.min(y - bounds.top, bounds.bottom - y) <= bounds.height * .2
      if (!atEdge) return null
    }
    const slots = window.sourcePanelTabs.slotRects?.(state.info.grid, free, active)
    for (const [slot, rect] of slots ?? []) {
      if (rect && x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height) return { slot, rect }
    }
    return null
  }

  function cancel() {
    drag?.target?.panel?.classList.remove('snap-target')
    drag?.preview?.remove()
    if (drag?.moved) suppressClick = drag.button
    drag = undefined
  }

  document.addEventListener('pointerdown', event => {
    const button = event.target.closest?.('[data-component-tab]')
    const panel = button?.closest('.panel')
    if (!panel || event.button !== 0 || drag || !canMove(panel)) return
    suppressClick = undefined
    event.stopPropagation()
    const info = infoFor(panel)
    if (!info) return
    const layout = groups(info)
    const id = button.dataset.componentTab
    const source = layout.find(group => group.tabs.includes(id))
    const component = info.panels.find(item => item.dataset.panelId === id)
    if (!source || !component || !canMove(component)) return
    drag = { info, layout, source, id, button, pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    try { button.setPointerCapture?.(event.pointerId) } catch { cancel() }
  }, true)

  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold) return
    drag.moved = true
    const strip = drag.button.closest('.pi-component-tabs').getBoundingClientRect()
    drag.leftStrip ||= event.clientY < strip.top - dragThreshold || event.clientY > strip.bottom + dragThreshold
    drag.target?.panel?.classList.remove('snap-target')
    drag.target = dropTarget(drag, event.clientX, event.clientY)
    drag.target?.panel?.classList.add('snap-target')
    if (drag.target?.rect) {
      if (!drag.preview) {
        drag.preview = document.createElement('div')
        drag.preview.className = 'pi-tab-split-preview'
        drag.preview.setAttribute('aria-hidden', 'true')
        document.body.append(drag.preview)
      }
      const { left, top, width, height } = drag.target.rect
      Object.assign(drag.preview.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` })
    } else {
      drag.preview?.remove()
      drag.preview = undefined
    }
  }, true)

  window.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const state = drag
    const target = state.moved && dropTarget(state, event.clientX, event.clientY)
    cancel()
    if (!target || !state.button.isConnected) return
    const { source, id, layout } = state
    const oldIndex = source.tabs.indexOf(id)
    if (target.group === source) {
      const index = target.index - Number(oldIndex < target.index)
      if (oldIndex === index) return
      source.tabs.splice(oldIndex, 1)
      source.tabs.splice(index, 0, id)
    } else {
      source.tabs.splice(oldIndex, 1)
      if (source.active === id) source.active = source.tabs[Math.min(oldIndex, source.tabs.length - 1)]
      if (target.group) {
        target.group.tabs.splice(target.index, 0, id)
        target.group.active = id
      } else layout.push({ slot: target.slot, tabs: [id], active: id })
    }
    replace(state.info, layout.filter(group => group.tabs.length))
  }, true)
  function cancelPointer(event) {
    if (event.pointerId === drag?.pointerId) cancel()
  }
  window.addEventListener('pointercancel', cancelPointer, true)
  document.addEventListener('lostpointercapture', cancelPointer, true)
  window.addEventListener('blur', cancel)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') cancel()
  })

  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-component-tab]')
    const panel = button?.closest('.panel')
    if (button && button === suppressClick && event.detail > 0) {
      suppressClick = undefined
      return
    }
    if (!panel || button.getAttribute('aria-selected') === 'true' || !canMove(panel)) return
    const info = infoFor(panel)
    if (!info) return
    const layout = groups(info)
    const group = layout.find(item => item.tabs.includes(button.dataset.componentTab))
    if (!group) return
    group.active = button.dataset.componentTab
    if (replace(info, layout)) {
      const activePanel = info.panels.find(item => item.dataset.panelId === group.active)
      bars.get(activePanel)?.querySelector('[aria-selected="true"]')?.focus()
    }
  })

  window.sourcePanelTabs = { storageKey, dragThreshold, groups, visible, render, nextStore, normalize, reconcile, slotPanel }
})()
