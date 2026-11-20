window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell', chunk: 'client.webai-files.js',
  factory(require) {
    const React = require('react'), h = React.createElement
    const same = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key])
    function register(ctx, descriptor, bridge, reportNotice) {
      if (descriptor.kind !== 'role' || descriptor.surface !== 'chat') return
      function DirectoryGrant({ sessionId, locked }) {
        const [targets, setTargets] = React.useState([]), [grants, setGrants] = React.useState([])
        const [write, setWrite] = React.useState(false), [notice, setNotice] = React.useState(''), [busy, setBusy] = React.useState(false)
        const [prompt, setPrompt] = React.useState(''), [taskId, setTaskId] = React.useState(null), [open, setOpen] = React.useState(false)
        const live = React.useRef(true)
        const activeTask = React.useRef(null), lifetime = React.useRef(null)
        React.useEffect(() => {
          live.current = true
          lifetime.current = new AbortController()
          const cancel = () => { live.current = false; lifetime.current.abort(); if (activeTask.current) void bridge.webAiDirectory({ action: 'cancel-task', taskId: activeTask.current }).catch(() => {}) }
          const stop = bridge.onNativeSurfaceChanged(next => { if (!same(next, descriptor)) cancel() })
          return () => { cancel(); stop() }
        }, [])
        // The existing parent panel menu sends a fixed, Main-checked UI intent.
        const menuAction = React.useRef(null)
        menuAction.current = () => { setOpen(true); if (!busy) return perform({ action: 'status' }) }
        React.useEffect(() => {
          if (sessionId !== descriptor.sessionId) return
          let active = true
          const stopIntent = bridge.onNativeUtilityRequested(request => {
            if (!active || request?.action !== 'task-directory' || !same(request.descriptor, descriptor)) return
            void Promise.resolve(bridge.nativeSurfaceDescriptor()).then(current => {
              if (!active || !same(current, descriptor)) return
              return menuAction.current?.()
            }).catch(() => { if (active) reportNotice?.('当前会话操作未完成，请重新打开菜单。') })
          })
          return () => { active = false; stopIntent() }
        }, [sessionId])
        async function current() { if (!live.current || !same(await bridge.nativeSurfaceDescriptor(), descriptor) || !live.current) throw Error('binding_changed') }
        async function perform(request) {
          setBusy(true); setNotice('')
          try {
            await current(); const result = await bridge.webAiDirectory(request); await current()
            if (request.action === 'status') { setTargets(result); if (!result.some(item => item.transportReady)) setNotice(result.some(item => item.reason === 'webai_site_protocol_unverified') ? '网站窗口已登记；新聊天、助手消息与完成状态尚未核实，自动任务未开放，也未授予目录访问。' : '请先打开已有网站窗口；未授予目录访问。') }
            else if (request.action === 'select' && !result.cancelled) setGrants(previous => [...previous, result])
            else if (request.action === 'revoke' && result.revoked) setGrants(previous => previous.filter(item => item.id !== request.id))
          } catch { if (live.current) setNotice('目录未授权或当前任务身份已变化。') }
          finally { if (live.current) setBusy(false) }
        }
        async function start(providerId) {
          setBusy(true); setNotice('')
          try {
            await current()
            const body = JSON.stringify({ id: crypto.randomUUID(), providerId, prompt })
            const grant = await bridge.issueSceneMemoryOriginGrant({ endpoint: 'tradeloom/webai-task', httpMethod: 'POST', bodyBytes: new TextEncoder().encode(body) })
            await current()
            const response = await fetch('/tradeloom/webai-task', { method: 'POST', credentials: 'same-origin', signal: lifetime.current.signal,
              headers: { 'content-type': 'application/json', 'x-tradeloom-origin': grant.token }, body })
            const value = await response.json()
            if (!response.ok || value.ok !== true || typeof value.result?.taskId !== 'string') throw Error('webai_task_unavailable')
            activeTask.current = value.result.taskId; setTaskId(activeTask.current)
            await current()
            const result = await bridge.webAiDirectory({ action: 'run-task', taskId: activeTask.current, write })
            await current()
            setNotice(result.completed ? '本次自动文件任务已结束，请查看原网站会话的分析。' : '任务未完成。')
          } catch { if (live.current) setNotice('任务未完成或清理失败；未确认的操作不视为成功。') }
          finally {
            const id = activeTask.current; activeTask.current = null
            if (id) try { await bridge.webAiDirectory({ action: 'cancel-task', taskId: id }) } catch { if (live.current) setNotice('任务清理未确认，请保留现场。') }
            if (live.current) { setTaskId(null); setBusy(false) }
          }
        }
        if (sessionId !== descriptor.sessionId || !open) return null
        return h('dialog', { open: true, 'aria-label': '网站任务目录授权', style: { position: 'fixed', inset: '8%', maxHeight: '84vh', overflow: 'auto', color: 'var(--tl-theme-text)', background: 'var(--tl-theme-panel)', border: '1px solid var(--tl-theme-border)' } },
          h('button', { type: 'button', onClick: () => setOpen(false) }, '关闭'),
          h('div', { hidden: !open },
          h('label', null, h('input', { type: 'checkbox', checked: write, disabled: locked || busy, onChange: event => setWrite(event.target.checked) }), '允许新建文件（不覆盖）'),
          h('textarea', { value: prompt, disabled: locked || busy, 'aria-label': '网站自动文件任务', placeholder: '说明需要分析或新建的内容；目录须另外明确授权。', onChange: event => setPrompt(event.target.value) }),
          ...targets.map(target => h('button', { key: `task-${target.providerId}`, type: 'button', disabled: locked || busy || !prompt.trim() || !target.transportReady, onClick: () => void start(target.providerId) }, `${target.providerId}：授权并自动执行任务`)),
          taskId ? h('button', { type: 'button', onClick: () => void bridge.webAiDirectory({ action: 'cancel-task', taskId }).catch(() => { if (live.current) setNotice('取消未确认，请保留现场。') }) }, '取消自动任务') : null,
          ...targets.map(target => h('button', { key: target.providerId, disabled: locked || busy || !target.available, type: 'button', onClick: () => void perform({ action: 'select', targetId: target.targetId, write }) }, `${target.providerId}：选择并授权目录`)),
          ...grants.map(grant => h('button', { key: grant.id, type: 'button', disabled: busy, onClick: () => void perform({ action: 'revoke', id: grant.id }) }, '撤销本次目录授权')),
          notice ? h('span', { role: 'status' }, notice) : null))
      }
      return ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'tradeloom-webai-directory-grant' }, DirectoryGrant))
    }
    return { register }
  },
})
