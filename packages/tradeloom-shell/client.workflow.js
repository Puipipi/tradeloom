window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell',
  chunk: 'client.workflow.js',
  factory(require) {
    // 工作流（wf）画布：类 ComfyUI 的节点编辑器。拖动节点、从右侧圆点拖到左侧圆点连线、右侧面板编辑节点。
    const React = require('react')
    const h = React.createElement
    const ROUTE = '/tradeloom/workflows'
    const NODE_W = 188
    const NODE_H = 76
    const STATUS_LABEL = { pending: '等待', running: '运行中', waiting: '待确认', done: '已完成', failed: '失败', skipped: '已跳过' }
    const RUN_LABEL = { running: '运行中', waiting: '等待人工确认', done: '已完成', failed: '失败', cancelled: '已取消' }
    const KIND_DEFAULT_TITLE = { input: '输入', agent: '新 agent 步骤', review: '人工确认', external: '外部平台', output: '输出' }

    async function api(method, body, query = '') {
      const response = await fetch(`${ROUTE}${query}`, {
        method, credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw Object.assign(new Error(value.error || `http-${response.status}`), { issues: value.issues })
      return value
    }

    const shortId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)

    function emptyWorkflow() {
      return {
        version: 1, id: `wf-${shortId()}`, title: '未命名工作流', description: '', source: 'manual', confirmed: true,
        nodes: [{ id: 'in', kind: 'input', title: '输入', instruction: '', position: { x: 40, y: 60 } }], edges: [],
      }
    }

    function appearance(catalog, node) {
      if (node.kind === 'agent') return catalog?.agents.find(item => item.id === node.agent) ?? { icon: '◎', color: '#356fc4', label: 'Agent' }
      return catalog?.kinds.find(item => item.kind === node.kind) ?? { icon: '•', color: '#68778c', label: node.kind }
    }

    function modelKey(model) { return model ? `${model.provider}\u0000${model.model}` : '' }

    function edgePath(a, b) {
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2
      const dx = Math.max(40, Math.abs(x2 - x1) / 2)
      return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
    }

    // initial 仅供测试注入初始状态；正常挂载时从宿主路由加载。
    function WorkflowCanvas({ modelGroups = [], initial = null }) {
      const [catalog, setCatalog] = React.useState(initial?.catalog ?? null)
      const [list, setList] = React.useState(initial?.list ?? [])
      const [doc, setDoc] = React.useState(initial?.doc ?? null)
      const [dirty, setDirty] = React.useState(false)
      const [run, setRun] = React.useState(initial?.run ?? null)
      const [selected, setSelected] = React.useState(initial?.selected ?? null)
      const [message, setMessage] = React.useState({ text: '', issues: [] })
      const [linking, setLinking] = React.useState(null)
      const [view, setView] = React.useState({ x: 0, y: 0, scale: 1 })
      const drag = React.useRef(null)
      const surface = React.useRef(null)
      const dirtyRef = React.useRef(false)
      dirtyRef.current = dirty

      const refreshList = React.useCallback(async () => {
        const value = await api('GET')
        setCatalog(value.catalog)
        setList(value.workflows)
        return value.workflows
      }, [])

      const open = React.useCallback(async id => {
        const value = await api('GET', null, `?id=${encodeURIComponent(id)}`)
        setDoc(value.workflow); setRun(value.run); setDirty(false); setSelected(null)
      }, [])

      React.useEffect(() => {
        if (initial) return
        refreshList().then(items => items[0] ? open(items[0].id) : setDoc(emptyWorkflow()))
          .catch(error => setMessage({ text: `工作流服务不可用：${error.message}`, issues: [] }))
      }, [])

      // 运行中快速轮询节点状态；空闲时慢速同步，接住中心 agent 提交的草稿或发起的运行。
      const active = run && !run.finishedAt
      React.useEffect(() => {
        const timer = setInterval(async () => {
          try {
            if (active) { setRun((await api('GET', null, `?run=${run.id}`)).run); return }
            const items = await refreshList()
            if (doc && !dirtyRef.current && items.some(item => item.id === doc.id)) {
              const value = await api('GET', null, `?id=${encodeURIComponent(doc.id)}`)
              if (!dirtyRef.current) { setDoc(value.workflow); setRun(value.run) }
            }
          } catch { /* 下次轮询重试 */ }
        }, active ? 800 : 4000)
        return () => clearInterval(timer)
      }, [active, run?.id, doc?.id])

      function edit(next) { setDoc(next); setDirty(true) }
      function updateNode(id, patch) { edit({ ...doc, nodes: doc.nodes.map(node => node.id === id ? { ...node, ...patch } : node) }) }
      function show(text, issues = []) { setMessage({ text, issues }) }

      async function act(label, task) {
        try { await task(); show(label) } catch (error) { show(`${label}失败：${error.message}`, error.issues ?? []) }
      }
      const save = () => act('已保存', async () => {
        const value = await api('POST', { action: 'save', workflow: doc })
        setDoc(value.workflow); setDirty(false); await refreshList()
      })
      const confirm = () => act('已确认，可以运行', async () => {
        if (dirty) await api('POST', { action: 'save', workflow: doc })
        const value = await api('POST', { action: 'confirm', id: doc.id })
        setDoc(value.workflow); setDirty(false); await refreshList()
      })
      const start = () => act('已开始运行', async () => {
        if (dirty) { const saved = await api('POST', { action: 'save', workflow: doc }); setDoc(saved.workflow); setDirty(false) }
        setRun((await api('POST', { action: 'run', id: doc.id })).run)
      })
      const cancel = () => act('已取消运行', async () => setRun((await api('POST', { action: 'cancel', run: run.id })).run))
      const decide = (nodeId, approved) => act(approved ? '已通过' : '已驳回', async () => setRun((await api('POST', { action: 'decide', run: run.id, node: nodeId, approved })).run))
      const remove = () => {
        if (!window.confirm(`删除工作流「${doc.title}」？`)) return
        act('已删除', async () => {
          await api('POST', { action: 'delete', id: doc.id })
          const items = await refreshList()
          if (items[0]) await open(items[0].id); else { setDoc(emptyWorkflow()); setRun(null) }
        })
      }

      function addNode(kind) {
        const base = kind === 'agent' ? { agent: catalog?.agents[1]?.id ?? 'center', model: null } : kind === 'external' ? { platform: '免费网页模型' } : {}
        const id = `${kind}-${shortId().slice(-4)}`
        const position = { x: Math.round(-view.x / view.scale + 80 + doc.nodes.length * 18), y: Math.round(-view.y / view.scale + 80 + doc.nodes.length * 14) }
        edit({ ...doc, nodes: [...doc.nodes, { id, kind, title: KIND_DEFAULT_TITLE[kind], instruction: '', ...base, position }] })
        setSelected(id)
      }
      function deleteNode(id) {
        edit({ ...doc, nodes: doc.nodes.filter(node => node.id !== id), edges: doc.edges.filter(edge => edge.from !== id && edge.to !== id) })
        setSelected(null)
      }
      function connect(from, to) {
        if (from === to || doc.edges.some(edge => edge.from === from && edge.to === to)) return
        edit({ ...doc, edges: [...doc.edges, { from, to }] })
      }

      // 指针拖拽：节点移动 / 画布平移 / 连线预览共用一套。
      function toCanvas(event) {
        const rect = surface.current.getBoundingClientRect()
        return { x: (event.clientX - rect.left - view.x) / view.scale, y: (event.clientY - rect.top - view.y) / view.scale }
      }
      function onPointerMove(event) {
        const state = drag.current
        if (state?.type === 'node') {
          const point = toCanvas(event)
          setDoc(current => ({ ...current, nodes: current.nodes.map(node => node.id === state.id
            ? { ...node, position: { x: Math.round(point.x - state.dx), y: Math.round(point.y - state.dy) } } : node) }))
          state.moved = true
        } else if (state?.type === 'pan') {
          setView(current => ({ ...current, x: state.vx + event.clientX - state.sx, y: state.vy + event.clientY - state.sy }))
        } else if (linking) setLinking({ ...linking, point: toCanvas(event) })
      }
      function onPointerUp() {
        if (drag.current?.type === 'node' && drag.current.moved) setDirty(true)
        drag.current = null
        setLinking(null)
      }
      function onWheel(event) {
        const scale = Math.min(1.6, Math.max(0.4, view.scale * (event.deltaY < 0 ? 1.1 : 0.9)))
        setView(current => ({ ...current, scale }))
      }

      // 新出现待确认节点时，把视角平移到该节点并选中它，用户不用自己找
      const waitingKey = Object.entries(run?.nodes ?? {}).filter(([, state]) => state.status === 'waiting').map(([id]) => id).join(',')
      const focusedRef = React.useRef('')
      React.useEffect(() => {
        if (!waitingKey || waitingKey === focusedRef.current) { focusedRef.current = waitingKey; return }
        const previous = new Set(focusedRef.current.split(','))
        focusedRef.current = waitingKey
        const target = doc?.nodes.find(node => node.id === waitingKey.split(',').find(id => !previous.has(id)))
        const rect = surface.current?.getBoundingClientRect()
        if (!target || !rect) return
        setSelected(target.id)
        setView(current => ({
          ...current,
          x: Math.round(rect.width / 2 - (target.position.x + NODE_W / 2) * current.scale),
          y: Math.round(rect.height / 2 - (target.position.y + NODE_H / 2) * current.scale),
        }))
      }, [waitingKey])

      if (!doc) return h('div', { className: 'tl-wf-empty', role: 'status' }, message.text || '加载工作流…')
      const byId = new Map(doc.nodes.map(node => [node.id, node]))
      const nodeState = id => run?.nodes?.[id]
      const editingRun = Boolean(active)
      const selectedNode = selected ? byId.get(selected) : null
      const models = modelGroups.flatMap(group => group.models)

      const toolbar = h('div', { className: 'tl-wf-toolbar', role: 'toolbar', 'aria-label': '工作流操作' },
        h('select', {
          'aria-label': '选择工作流', value: list.some(item => item.id === doc.id) ? doc.id : '',
          onChange: event => event.target.value && open(event.target.value),
        }, !list.some(item => item.id === doc.id) && h('option', { value: '' }, `${doc.title}（未保存）`),
          list.map(item => h('option', { key: item.id, value: item.id }, `${item.source === 'agent' ? '🤖 ' : ''}${item.title}${item.confirmed ? '' : '（待确认）'}`))),
        h('input', { 'aria-label': '工作流名称', className: 'tl-wf-title', value: doc.title, disabled: editingRun, onChange: event => edit({ ...doc, title: event.target.value }) }),
        h('button', { type: 'button', onClick: () => { setDoc(emptyWorkflow()); setRun(null); setDirty(true); setSelected(null) } }, '新建'),
        h('button', { type: 'button', onClick: save, disabled: editingRun }, dirty ? '保存*' : '保存'),
        !doc.confirmed && h('button', { type: 'button', className: 'is-primary', onClick: confirm }, '确认草稿'),
        active ? h('button', { type: 'button', className: 'is-danger', onClick: cancel }, '停止')
          : h('button', { type: 'button', className: 'is-primary', onClick: start, disabled: !doc.confirmed }, '▶ 运行'),
        h('button', { type: 'button', onClick: remove, disabled: editingRun || !list.some(item => item.id === doc.id) }, '删除'),
        h('span', { className: 'tl-wf-runstate', role: 'status', 'aria-live': 'polite' },
          doc.source === 'agent' && !doc.confirmed ? '中心 agent 草稿，确认后可运行' : run ? `运行：${RUN_LABEL[run.status] ?? run.status}` : ''),
        // 添加节点的按钮统一放第二行
        h('div', { className: 'tl-wf-kinds', role: 'group', 'aria-label': '添加节点' },
          (catalog?.kinds ?? []).map(kind => h('button', {
            key: kind.kind, type: 'button', disabled: editingRun, onClick: () => addNode(kind.kind),
            title: `添加${kind.label}节点`, style: { '--tl-wf-color': kind.color },
          }, h('span', { 'aria-hidden': true }, kind.icon), ` ${kind.label}`))))

      const edges = h('svg', { className: 'tl-wf-edges', 'aria-hidden': true },
        doc.edges.map(edge => {
          const a = byId.get(edge.from), b = byId.get(edge.to)
          if (!a || !b) return null
          const flowing = ['running', 'waiting'].includes(nodeState(edge.to)?.status) && nodeState(edge.from)?.status === 'done'
          const done = nodeState(edge.to)?.status === 'done'
          return h('path', {
            key: `${edge.from}-${edge.to}`, d: edgePath(a.position, b.position),
            className: `tl-wf-edge${flowing ? ' is-flowing' : ''}${done ? ' is-done' : ''}`,
            onDoubleClick: () => !editingRun && edit({ ...doc, edges: doc.edges.filter(item => item !== edge) }),
          }, h('title', null, '双击删除连线'))
        }),
        linking && h('path', { className: 'tl-wf-edge is-preview', d: edgePath(byId.get(linking.from).position, { x: linking.point.x, y: linking.point.y - NODE_H / 2 }) }))

      const nodes = doc.nodes.map(node => {
        const look = appearance(catalog, node)
        const status = nodeState(node.id)?.status
        const model = node.kind === 'agent' && node.model ? models.find(item => item.provider === node.model.provider && item.id === node.model.model) : null
        const sub = node.kind === 'agent' ? `${look.label} · ${model?.name ?? (node.model ? node.model.model : '默认模型')}`
          : node.kind === 'external' ? node.platform : look.label
        return h('div', {
          key: node.id, role: 'button', tabIndex: 0,
          'aria-label': `${node.title}，${sub}${status ? `，${STATUS_LABEL[status]}` : ''}`,
          'aria-pressed': selected === node.id,
          className: `tl-wf-node${status ? ` is-${status}` : ''}${selected === node.id ? ' is-selected' : ''}`,
          style: { left: node.position.x, top: node.position.y, width: NODE_W, height: NODE_H, '--tl-wf-color': look.color },
          onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(node.id) } },
          onPointerDown: event => {
            if (event.button !== 0) return
            event.stopPropagation()
            setSelected(node.id)
            if (editingRun) return
            const point = toCanvas(event)
            drag.current = { type: 'node', id: node.id, dx: point.x - node.position.x, dy: point.y - node.position.y }
          },
          onPointerUp: () => { if (linking && linking.from !== node.id) connect(linking.from, node.id) },
        },
          node.kind !== 'input' && h('span', { className: 'tl-wf-port is-in', 'aria-hidden': true }),
          h('span', { className: 'tl-wf-icon', 'aria-hidden': true }, look.icon),
          h('span', { className: 'tl-wf-text' },
            h('strong', null, node.title),
            h('small', null, sub)),
          status && h('span', { className: 'tl-wf-badge' }, status === 'done' ? '✓' : status === 'failed' ? '✕' : status === 'skipped' ? '–' : STATUS_LABEL[status]),
          node.kind !== 'output' && !editingRun && h('span', {
            className: 'tl-wf-port is-out', title: '拖到另一个节点上连线',
            onPointerDown: event => { event.stopPropagation(); setLinking({ from: node.id, point: toCanvas(event) }) },
          }))
      })

      // 待确认节点两侧的快捷按钮：左绿通过、右红驳回
      const quickDecisions = doc.nodes.filter(node => nodeState(node.id)?.status === 'waiting').map(node =>
        h('div', {
          key: `decide-${node.id}`, className: 'tl-wf-quick', role: 'group', 'aria-label': `${node.title}：人工确认`,
          style: { left: node.position.x, top: node.position.y, width: NODE_W, height: NODE_H },
          onPointerDown: event => event.stopPropagation(),
        },
          h('button', { type: 'button', className: 'tl-wf-quick-btn is-approve', title: '通过', 'aria-label': `通过「${node.title}」`, onClick: () => decide(node.id, true) }, '✓'),
          h('button', { type: 'button', className: 'tl-wf-quick-btn is-reject', title: '驳回', 'aria-label': `驳回「${node.title}」`, onClick: () => decide(node.id, false) }, '✕')))

      // 审核时要看的内容：上游节点的输出
      const reviewInputs = selectedNode?.kind === 'review'
        ? doc.edges.filter(edge => edge.to === selectedNode.id).map(edge => ({ node: byId.get(edge.from), output: nodeState(edge.from)?.output })).filter(item => item.node && item.output)
        : []

      const inspector = selectedNode && h('aside', { className: 'tl-wf-inspector', 'aria-label': '节点设置' },
        reviewInputs.length > 0 && h('div', { className: 'tl-wf-review' },
          h('strong', null, '待审核内容'),
          reviewInputs.map(item => h('div', { key: item.node.id },
            h('small', null, item.node.title),
            h('pre', { className: 'tl-wf-output' }, item.output)))),
        h('label', null, '名称', h('input', { value: selectedNode.title, disabled: editingRun, onChange: event => updateNode(selectedNode.id, { title: event.target.value }) })),
        selectedNode.kind === 'agent' && h('label', null, 'Agent',
          h('select', { value: selectedNode.agent, disabled: editingRun, onChange: event => updateNode(selectedNode.id, { agent: event.target.value }) },
            (catalog?.agents ?? []).map(agent => h('option', { key: agent.id, value: agent.id }, `${agent.icon} ${agent.label}`)))),
        selectedNode.kind === 'agent' && h('label', null, '模型',
          h('select', {
            value: modelKey(selectedNode.model), disabled: editingRun,
            onChange: event => {
              const [provider, modelId] = event.target.value.split('\u0000')
              updateNode(selectedNode.id, { model: event.target.value ? { provider, model: modelId } : null })
            },
          },
            h('option', { value: '' }, '跟随 agent 默认模型'),
            selectedNode.model && !models.some(item => modelKey({ provider: item.provider, model: item.id }) === modelKey(selectedNode.model))
              && h('option', { value: modelKey(selectedNode.model) }, `${selectedNode.model.provider} · ${selectedNode.model.model}`),
            modelGroups.map(group => h('optgroup', { key: group.provider, label: group.providerName },
              group.models.map(item => h('option', { key: item.id, value: modelKey({ provider: item.provider, model: item.id }) }, item.name)))))),
        selectedNode.kind === 'external' && h('label', null, '外部平台', h('input', { value: selectedNode.platform ?? '', disabled: editingRun, onChange: event => updateNode(selectedNode.id, { platform: event.target.value }) })),
        h('label', null, '说明', h('textarea', { rows: 4, value: selectedNode.instruction ?? '', disabled: editingRun, onChange: event => updateNode(selectedNode.id, { instruction: event.target.value }) })),
        nodeState(selectedNode.id)?.status === 'waiting' && h('div', { className: 'tl-wf-decide' },
          h('button', { type: 'button', className: 'is-primary', onClick: () => decide(selectedNode.id, true) }, '通过'),
          h('button', { type: 'button', className: 'is-danger', onClick: () => decide(selectedNode.id, false) }, '驳回')),
        nodeState(selectedNode.id)?.output && h('pre', { className: 'tl-wf-output' }, nodeState(selectedNode.id).output),
        nodeState(selectedNode.id)?.error && h('p', { className: 'tl-wf-error', role: 'alert' }, nodeState(selectedNode.id).error),
        !editingRun && h('button', { type: 'button', className: 'is-danger', onClick: () => deleteNode(selectedNode.id) }, '删除节点'))

      return h('section', { className: 'tl-wf', 'aria-label': '工作流画布' },
        h('style', null, WORKFLOW_CSS),
        toolbar,
        (message.text || message.issues.length > 0) && h('div', { className: 'tl-wf-message', role: 'status' },
          message.text, message.issues.length > 0 && h('ul', null, message.issues.map(issue => h('li', { key: issue }, issue)))),
        h('div', { className: 'tl-wf-body' },
          h('div', {
            ref: surface, className: 'tl-wf-surface',
            onPointerDown: event => {
              if (event.button !== 0) return
              setSelected(null)
              drag.current = { type: 'pan', sx: event.clientX, sy: event.clientY, vx: view.x, vy: view.y }
            },
            onPointerMove, onPointerUp, onPointerLeave: onPointerUp, onWheel,
          },
            h('div', { className: 'tl-wf-layer', style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` } }, edges, nodes, quickDecisions)),
          inspector))
    }

    const WORKFLOW_CSS = `
      .tl-wf { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--tl-ink,#202b3a); font-size:13px; }
      .tl-wf-empty { padding:16px; color:var(--tl-muted,#68778c); }
      .tl-wf-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px solid var(--tl-border,#cbd5e2); }
      .tl-wf-toolbar button, .tl-wf-inspector button { border:1px solid var(--tl-border,#cbd5e2); background:var(--tl-surface,#fff); color:inherit; border-radius:6px; padding:3px 9px; cursor:pointer; }
      .tl-wf-toolbar button[style] { border-color:var(--tl-wf-color); }
      .tl-wf-toolbar button:disabled { opacity:.45; cursor:default; }
      .tl-wf button.is-primary { background:var(--tl-accent,#356fc4); border-color:var(--tl-accent,#356fc4); color:#fff; }
      .tl-wf button.is-danger { border-color:#c0392b; color:#c0392b; }
      .tl-wf-title { width:180px; }
      .tl-wf-kinds { flex-basis:100%; display:flex; flex-wrap:wrap; gap:6px; }
      .tl-wf-runstate { margin-left:auto; color:var(--tl-muted,#68778c); }
      .tl-wf-message { padding:4px 10px; background:var(--tl-surface-soft,#eef3f9); }
      .tl-wf-message ul { margin:2px 0 0 18px; padding:0; color:#c0392b; }
      .tl-wf-body { flex:1; min-height:0; display:flex; }
      .tl-wf-surface { flex:1; position:relative; overflow:hidden; cursor:grab; touch-action:none;
        background-color:var(--tl-surface-soft,#f4f7fb); background-image:radial-gradient(var(--tl-border,#cbd5e2) 1px, transparent 1px); background-size:20px 20px; }
      .tl-wf-layer { position:absolute; inset:0; transform-origin:0 0; }
      .tl-wf-edges { position:absolute; left:0; top:0; width:4000px; height:3000px; overflow:visible; }
      .tl-wf-edge { fill:none; stroke:var(--tl-muted,#8b97ab); stroke-width:2; pointer-events:stroke; cursor:pointer; }
      .tl-wf-edge.is-done { stroke:#9aa5b5; opacity:.6; }
      .tl-wf-edge.is-flowing { stroke:var(--tl-accent,#356fc4); stroke-dasharray:6 6; animation:tl-wf-flow .6s linear infinite; }
      .tl-wf-edge.is-preview { stroke-dasharray:4 4; pointer-events:none; }
      @keyframes tl-wf-flow { to { stroke-dashoffset:-12; } }
      .tl-wf-node { position:absolute; box-sizing:border-box; display:flex; align-items:center; gap:8px; padding:8px 10px;
        background:var(--tl-surface,#fff); border:1px solid var(--tl-border,#cbd5e2); border-left:5px solid var(--tl-wf-color); border-radius:8px;
        box-shadow:0 1px 3px rgba(0,0,0,.12); cursor:pointer; user-select:none; transition:opacity .3s, filter .3s, box-shadow .3s; }
      .tl-wf-node:focus-visible, .tl-wf-node.is-selected { outline:2px solid var(--tl-accent,#356fc4); outline-offset:2px; }
      .tl-wf-icon { flex:none; width:30px; height:30px; display:grid; place-items:center; border-radius:50%; font-size:16px; color:#fff; background:var(--tl-wf-color); }
      .tl-wf-text { display:flex; flex-direction:column; min-width:0; }
      .tl-wf-text strong, .tl-wf-text small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .tl-wf-text small { color:var(--tl-muted,#68778c); }
      .tl-wf-badge { position:absolute; top:-9px; right:8px; padding:0 6px; border-radius:9px; font-size:11px; background:var(--tl-surface,#fff); border:1px solid currentColor; }
      .tl-wf-node.is-running { box-shadow:0 0 0 3px var(--tl-wf-color), 0 0 16px var(--tl-wf-color); animation:tl-wf-pulse 1.2s ease-in-out infinite; }
      .tl-wf-node.is-running .tl-wf-badge { color:var(--tl-wf-color); }
      .tl-wf-node.is-waiting { box-shadow:0 0 0 3px #e0a100; animation:tl-wf-pulse 1.6s ease-in-out infinite; }
      .tl-wf-node.is-waiting .tl-wf-badge { color:#b07d00; }
      .tl-wf-node.is-done { filter:grayscale(1); opacity:.55; }
      .tl-wf-node.is-done .tl-wf-badge { color:#2f7d4f; }
      .tl-wf-node.is-failed { border-color:#c0392b; box-shadow:0 0 0 2px #c0392b; }
      .tl-wf-node.is-failed .tl-wf-badge { color:#c0392b; }
      .tl-wf-node.is-skipped { opacity:.35; border-style:dashed; }
      @keyframes tl-wf-pulse { 50% { transform:translateY(-1px); filter:brightness(1.08); } }
      @media (prefers-reduced-motion: reduce) { .tl-wf-node, .tl-wf-edge { animation:none !important; } }
      .tl-wf-port { position:absolute; top:50%; width:12px; height:12px; margin-top:-6px; border-radius:50%; background:var(--tl-surface,#fff); border:2px solid var(--tl-wf-color); }
      .tl-wf-port.is-in { left:-8px; }
      .tl-wf-port.is-out { right:-8px; cursor:crosshair; }
      .tl-wf-inspector { width:250px; flex:none; overflow:auto; padding:10px; display:flex; flex-direction:column; gap:8px; border-left:1px solid var(--tl-border,#cbd5e2); background:var(--tl-surface,#fff); }
      .tl-wf-inspector label { display:flex; flex-direction:column; gap:3px; color:var(--tl-muted,#68778c); }
      .tl-wf-inspector input, .tl-wf-inspector select, .tl-wf-inspector textarea { color:var(--tl-ink,#202b3a); font:inherit; }
      .tl-wf-decide { display:flex; gap:6px; }
      .tl-wf-quick { position:absolute; pointer-events:none; }
      .tl-wf-quick-btn { pointer-events:auto; position:absolute; top:50%; width:40px; height:40px; margin-top:-20px; border:0; border-radius:50%; color:#fff; font-size:20px; font-weight:700; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.35); }
      .tl-wf-quick-btn.is-approve { left:-54px; background:#2f9e44; }
      .tl-wf-quick-btn.is-reject { right:-54px; background:#d9363e; }
      .tl-wf-quick-btn:hover, .tl-wf-quick-btn:focus-visible { transform:scale(1.1); outline:2px solid #fff; outline-offset:2px; }
      .tl-wf-review { display:flex; flex-direction:column; gap:4px; padding:6px; border:1px solid #e0a100; border-radius:6px; }
      .tl-wf-review small { color:var(--tl-muted,#68778c); }
      .tl-wf-output { white-space:pre-wrap; margin:0; padding:6px; max-height:160px; overflow:auto; background:var(--tl-surface-soft,#eef3f9); border-radius:6px; font-size:12px; }
      .tl-wf-error { color:#c0392b; margin:0; }
    `

    return { WorkflowCanvas }
  },
})
