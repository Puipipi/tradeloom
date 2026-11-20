window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell', chunk: 'client.scene-memory.js',
  factory(require) {
    const React = require('react'), h = React.createElement
    const matchesSurfaceDescriptor = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(key => a[key] === b[key])
    function register(ctx, descriptor, bridge, reportNotice) {
      if (descriptor.kind !== 'role' || descriptor.surface !== 'chat') return
      const expected = Object.freeze({ ...descriptor })
      function SceneMemory({ sessionId }) {
        const [open, setOpen] = React.useState(false), [view, setView] = React.useState(null)
        const [query, setQuery] = React.useState(''), [kind, setKind] = React.useState('')
        const [draft, setDraft] = React.useState(''), [action, setAction] = React.useState('progress')
        const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false), [zoom, setZoom] = React.useState(1)
        const [selectedRecord, setSelectedRecord] = React.useState(null)
        const lifetime = React.useRef(null), sequence = React.useRef(0)
        React.useEffect(() => {
          const controller = new AbortController(); lifetime.current = controller
          const stop = bridge.onNativeSurfaceChanged(next => { if (!matchesSurfaceDescriptor(next, expected)) { lifetime.current.abort(); if (!next) lifetime.current = new AbortController(); sequence.current++; setOpen(false) } })
          return () => { lifetime.current.abort(); sequence.current++; stop() }
        }, [])
        // The existing parent panel menu sends a fixed, Main-checked UI intent.
        const menuAction = React.useRef(null)
        menuAction.current = () => { setOpen(true); return load() }
        React.useEffect(() => {
          if (sessionId !== expected.sessionId) return
          let active = true
          const stopIntent = bridge.onNativeUtilityRequested(request => {
            if (!active || request?.action !== 'scene-memory' || !matchesSurfaceDescriptor(request.descriptor, expected)) return
            void Promise.resolve(bridge.nativeSurfaceDescriptor()).then(current => {
              if (!active || !matchesSurfaceDescriptor(current, expected)) return
              return menuAction.current?.()
            }).catch(() => { if (active) reportNotice?.('当前会话操作未完成，请重新打开菜单。') })
          })
          return () => { active = false; stopIntent() }
        }, [sessionId])
        async function request(input) {
          if (lifetime.current?.signal.aborted || sessionId !== expected.sessionId || !matchesSurfaceDescriptor(await bridge.nativeSurfaceDescriptor(), expected)) throw Error('当前场景绑定已变化，请重新打开面板。')
          const body = JSON.stringify({ id: crypto.randomUUID(), ...input }), bodyBytes = new TextEncoder().encode(body)
          const grant = await bridge.issueSceneMemoryOriginGrant({ endpoint: 'tradeloom/scene-memory', httpMethod: 'POST', bodyBytes })
          if (!grant?.token || lifetime.current.signal.aborted || !matchesSurfaceDescriptor(await bridge.nativeSurfaceDescriptor(), expected)) throw Error('场景身份确认失败。')
          const response = await fetch('/tradeloom/scene-memory', { method: 'POST', credentials: 'same-origin', signal: lifetime.current.signal,
            headers: { 'content-type': 'application/json', 'x-tradeloom-origin': grant.token }, body })
          const result = await response.json()
          if (!response.ok || result.ok !== true) throw Error(result.error_code || 'scene_memory_unavailable')
          if (lifetime.current.signal.aborted || !matchesSurfaceDescriptor(await bridge.nativeSurfaceDescriptor(), expected)) throw Error('场景绑定已变化，结果未应用。')
          return result.result
        }
        async function load(cursor) {
          const token = ++sequence.current; setBusy(true); setError('')
          try {
            const result = await request({ action: 'graph', query: { ...(cursor ? { cursor } : { text: query, kinds: kind ? [kind] : undefined }), pageSize: 25 } })
            if (token === sequence.current) setView(result)
          } catch (failure) { if (token === sequence.current && !lifetime.current?.signal.aborted) setError(failure.message) }
          finally { if (token === sequence.current) setBusy(false) }
        }
        async function save() {
          if (!view || !draft.trim()) return
          setBusy(true); setError('')
          try { await request({ action, text: draft, expectedRevision: view.revision }); setDraft(''); await load() }
          catch (failure) { if (!lifetime.current?.signal.aborted) setError(failure.message) }
          finally { if (!lifetime.current?.signal.aborted) setBusy(false) }
        }
        async function resolve(node) {
          setBusy(true); setError('')
          try {
            const result = await request({ action: 'resolve', nodeId: node.id, expectedTarget: view.graph.target })
            const navigation = result.navigation
            if (navigation?.kind === 'bound-role') {
              if (navigation.sessionId !== expected.sessionId || navigation.sceneId !== expected.sceneId
                || navigation.roleId !== expected.roleId || navigation.bindingRevision !== expected.bindingRevision
                || !matchesSurfaceDescriptor(await bridge.nativeSurfaceDescriptor(), expected)) throw Error('场景目标已变化，未执行跳转。')
              // This is the real Main account-sidebar route: it revalidates
              // role ownership and resolves the current saved scene/panel
              // binding before the source-shell openBoundSession consumer.
              await bridge.accountSidebarCommand({ generation: expected.generation, accountGeneration: expected.accountGeneration,
                command: { action: 'openSession', target: navigation.sessionId } })
              if (lifetime.current?.signal.aborted || !matchesSurfaceDescriptor(await bridge.nativeSurfaceDescriptor(), expected)) throw Error('场景绑定已变化。')
              setOpen(false)
            } else if (navigation?.kind === 'skill') {
              if (navigation.roleId !== expected.roleId || navigation.sessionId !== expected.sessionId || !matchesSurfaceDescriptor(await bridge.nativeSurfaceDescriptor(), expected)) throw Error('技能所属会话已变化。')
              // Existing production skills-open re-resolves the user-invocable
              // skill in this actual Agent scope, checks binding and filesystem
              // mapping twice, then uses sessionController.openWorkspacePath.
              const response = await fetch('/tradeloom/skills/open', { method: 'POST', credentials: 'same-origin', signal: lifetime.current.signal,
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: expected.roleId, expectedSessionId: expected.sessionId, name: navigation.name, target: 'body' }) })
              const opened = await response.json()
              if (!response.ok || opened.status !== 'handed-off' || !matchesSurfaceDescriptor(await bridge.nativeSurfaceDescriptor(), expected)) throw Error('技能不可用、未获授权或所属会话已变化。')
            } else if (navigation?.kind === 'record') setSelectedRecord(navigation.record)
            else setError('此引用类型尚无已授权的打开入口；未打开其它场景、会话或文件。')
          } catch (failure) { if (!lifetime.current?.signal.aborted) setError(failure.message) }
          finally { if (!lifetime.current?.signal.aborted) setBusy(false) }
        }
        if (sessionId !== expected.sessionId) return null
        const nodes = view ? [...view.graph.contextNodes, ...view.graph.nodes].filter((node, index, all) => all.findIndex(item => item.id === node.id) === index) : []
        const position = new Map(nodes.map((node, index) => [node.id, { x: 100 + (index % 3) * 220, y: 50 + Math.floor(index / 3) * 95 }]))
        return h(React.Fragment, null,
          open ? h('dialog', { open: true, 'aria-label': '当前场景记忆', style: { position: 'fixed', inset: '8%', width: 'auto', maxHeight: '84vh', overflow: 'auto', zIndex: 1000, color: 'var(--tl-theme-text)', background: 'var(--tl-theme-panel)', border: '1px solid var(--tl-theme-border)' } },
            h('header', null, h('strong', null, `场景记忆 · ${expected.sceneId}`), h('button', { type: 'button', onClick: () => setOpen(false) }, '关闭')),
            h('p', null, '仅显示当前已验证场景的显式记录及来源；不推断关系、不跨场景检索。'),
            h('label', null, '筛选', h('input', { value: query, maxLength: 1000, onChange: event => setQuery(event.target.value) })),
            h('select', { value: kind, onChange: event => setKind(event.target.value), 'aria-label': '记录类型' }, ...[['', '全部'], ['handoff', '交接'], ['progress', '进展'], ['decision', '决策'], ['session_binding', '会话'], ['asset_ref', '资源引用']].map(([value, label]) => h('option', { key: value, value }, label))),
            h('button', { type: 'button', disabled: busy, onClick: () => void load() }, '查询'),
            h('label', null, '缩放', h('input', { type: 'range', min: .5, max: 2, step: .1, value: zoom, onChange: event => setZoom(Number(event.target.value)) })),
            h('div', { style: { overflow: 'auto', maxHeight: '40vh' } }, h('svg', { width: 700 * zoom, height: Math.max(180, Math.ceil(nodes.length / 3) * 95) * zoom, viewBox: `0 0 700 ${Math.max(180, Math.ceil(nodes.length / 3) * 95)}`, role: 'img', 'aria-label': '带来源的场景记忆关系图' },
              ...(view?.graph.edges ?? []).map(edge => { const a = position.get(edge.source), b = position.get(edge.target); return a && b ? h('line', { key: edge.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'currentColor', opacity: .35 }) : null }),
              ...nodes.map(node => { const p = position.get(node.id); return h('g', { key: node.id, transform: `translate(${p.x},${p.y})`, onClick: () => void resolve(node) }, h('rect', { x: -90, y: -22, width: 180, height: 50, rx: 6, fill: 'var(--tl-theme-panel)', stroke: 'currentColor' }), h('title', null, `${node.label}\n${node.source.record}`), h('text', { textAnchor: 'middle', fill: 'currentColor', fontSize: 12 }, node.label.slice(0, 15)), h('text', { y: 17, textAnchor: 'middle', fill: 'currentColor', fontSize: 10 }, node.kind)) }))),
            h('ul', null, ...nodes.map(node => h('li', { key: node.id }, h('button', { type: 'button', disabled: busy, onClick: () => void resolve(node) }, `${node.label} · ${node.source.record}`)))),
            selectedRecord ? h('section', { 'aria-label': '场景记录详情' }, h('h3', null, selectedRecord.kind),
              h('p', null, selectedRecord.data.text), h('p', null, `出处：${selectedRecord.source.record}`),
              selectedRecord.source.sourceSessionId !== expected.sessionId ? h('p', null, '历史来源记录；不授予来源会话访问权。') : null,
              h('button', { type: 'button', onClick: () => setSelectedRecord(null) }, '关闭详情')) : null,
            view?.graph.pagination.hasMore ? h('button', { disabled: busy, onClick: () => void load(view.graph.pagination.nextCursor) }, '下一页') : null,
            h('select', { value: action, onChange: event => setAction(event.target.value), 'aria-label': '新增记录类型' }, ...[['progress', '进展'], ['decision', '决策'], ['handoff', '交接']].map(([value, label]) => h('option', { key: value, value }, label))),
            h('textarea', { value: draft, maxLength: 12000, 'aria-label': '场景记忆内容', onChange: event => setDraft(event.target.value) }),
            h('button', { type: 'button', disabled: busy || !view || !draft.trim(), onClick: () => void save() }, '保存当前场景记录'),
            error ? h('p', { role: 'alert' }, error) : null) : null)
      }
      return ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'tradeloom-scene-memory' }, SceneMemory))
    }
    return { register }
  },
})
