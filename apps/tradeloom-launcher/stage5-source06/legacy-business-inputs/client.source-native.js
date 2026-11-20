window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell',
  chunk: 'client.source-native.js',
  factory(require) {
    const React = require('react'), h = React.createElement
    const gatewayApi = require('@deepseek-ai/dsh-api-gateway/client')
    const valid = d => d && d.kind === 'role' && typeof d.roleId === 'string' && d.roleId && typeof d.bindingRevision === 'string' && /^(0|[1-9][0-9]{0,63})$/.test(d.bindingRevision) && typeof d.sceneId === 'string' && typeof d.panelId === 'string' && typeof d.sessionId === 'string' && d.sessionId && ['chat','files'].includes(d.surface) && Number.isSafeInteger(d.generation)
    const same = (a,b) => valid(a) && valid(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(k => a[k] === b[k])
    const reportRoleGuestPhase = (descriptor, phase) => {
      if (!valid(descriptor)) return
      try { console.info(`TL-ROLE-GUEST-PHASE|${phase}|${descriptor.surface}`) } catch {}
    }
    // The rc2 conversation factory no longer consumes conversation-density.
    // Keep the accepted composer rules on this owned root, using its public DOM
    // attributes and composer-local class names, never CSS-module hashes or
    // the old webview script. Local-name selectors stay inside the owned card.
    const nativeChatStyles = `
      [data-source-owned-role] > [data-shell-overlay] > * { pointer-events:auto; }
      @media (pointer:fine) {
        [data-source-native-root] .cm-btn.cm-stat-entry { min-height:initial; }
      }
      .tl-bound-skills {
        width:min(480px,calc(100vw - 32px));max-height:70vh;box-sizing:border-box;padding:14px;
        color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);
        border:1px solid var(--dsw-alias-border-l2);border-radius:9px;
        font:inherit;font-size:var(--tl-font-compact,12px);
      }
      .tl-bound-skills > header { display:flex;align-items:center;justify-content:space-between;gap:12px; }
      .tl-bound-skills ul { list-style:none;padding:0;display:grid;gap:12px; }
      .tl-bound-skills p { color:var(--dsw-alias-label-secondary);white-space:pre-wrap; }
      [data-source-native-root] {
        --dsw-font-family:var(--tl-font-family,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif);
        font-family:var(--dsw-font-family);container-type:size;
      }
      [data-source-native-root] [data-conversation-content] {
        --dsh-chat-content-width:calc(100% - 16px);
        --dsh-composer-card-max-width:calc(100% - 16px);
        --dsh-composer-side-clearance:8px;
        min-width:0;
      }
      [data-source-native-root] [data-conversation-scroll] { min-width:0; }
      [data-source-native-root] [data-composer-seat] {
        --dsh-composer-input-min-height:36px;
        --dsh-composer-row-gap:12px;
        --dsh-native-composer-padding-top:8px;
        --dsh-native-composer-padding-bottom:10px;
        --dsh-composer-input-max-height:clamp(var(--dsh-composer-input-min-height),calc(100vh - 188px - var(--dsh-native-composer-padding-top) - var(--dsh-native-composer-padding-bottom) + 4px),336px);
        --dsh-composer-text-max-height:var(--dsh-composer-input-max-height);
        position:sticky;bottom:0;z-index:1;margin-top:auto;flex:0 0 auto;
        padding:var(--dsh-native-composer-padding-top) 10px var(--dsh-native-composer-padding-bottom);
        background:var(--dsw-alias-bg-layer-1);
      }
      [data-source-native-root] [data-composer-card] {
        max-width:calc(100% - 16px);box-sizing:border-box;
        border:1px solid var(--dsw-alias-border-l2);border-radius:9px;
        padding:8px 10px;gap:0;box-shadow:none;
        font-size:var(--tl-font-compact,12px);line-height:1.65;
      }
      [data-source-native-root] [data-composer-input] {
        min-height:26px;padding:0;font:inherit;
      }
      [data-source-native-root] [data-composer-placeholder] { font-size:11.5px;line-height:1.65;inset:0; }
      [data-source-native-root] [data-composer-dock] { gap:7px; }
      [data-source-native-root] [data-composer-card] > :is([class$="_row"],[class*="_row "]) {
        margin-top:8px;padding:0;gap:var(--dsh-composer-row-gap);
      }
      [data-source-native-root] [data-composer-card] :is([class$="_tools"],[class*="_tools "],[class$="_modes"],[class*="_modes "],[class$="_trailing"],[class*="_trailing "]) { gap:7px; }
      [data-source-native-root] [data-composer-card] :is(button[class$="_add"],button[class*="_add "],button[class$="_primary"],button[class*="_primary "]) { width:26px;height:26px; }
      [data-source-native-root] [data-composer-card] :is([class$="_select"],[class*="_select "],[class$="_tools"] button,[class*="_tools "] button,[class$="_modes"] button,[class*="_modes "] button,[class$="_trailing"] button,[class*="_trailing "] button,[class$="_trailing"] select,[class*="_trailing "] select) { height:26px; }
      [data-source-native-root] [data-composer-card] :is([class$="_standardControls"],[class*="_standardControls "]) :is(button,select) { height:26px;font-size:11px; }
      @container (height<=380px) {
        [data-source-native-root] [data-composer-seat] {
          --dsh-composer-input-min-height:max(28px,calc(28px + var(--dsh-content-font-delta,0px)));
          --dsh-composer-row-gap:8px;
        }
      }
      [data-source-native-root][data-conversation-density="compact"] [data-composer-seat] {
        --dsh-composer-input-min-height:26px;
      }
      @media(max-height:260px) {
        [data-source-native-root] [data-composer-seat] {
          --dsh-native-composer-padding-top:0px;
          --dsh-native-composer-padding-bottom:8px;
        }
      }
    `
    function installNativeChatStyles() {
      const style=document.createElement('style')
      style.dataset.tradeloomNativeChat='1'
      style.textContent=nativeChatStyles
      document.head.append(style)
      return ()=>style.remove()
    }
    const whaleAutoBases = new Map()
    function installWhaleAutoBasis(bridge, sceneId, panelId) {
      if (typeof bridge?.nativeSurfaceLayout !== 'function' || typeof bridge?.onNativeSurfaceChanged !== 'function') return undefined
      const key='tl.nativeWhaleAutoBase:v1:'+encodeURIComponent(sceneId)+':'+encodeURIComponent(panelId)
      const root=document.documentElement,attribute='data-tl-native-whale-basis',variable='--tl-native-whale-auto-base'
      const oldAttribute=root.getAttribute(attribute),oldValue=root.style.getPropertyValue(variable),oldPriority=root.style.getPropertyPriority(variable)
      let basis=whaleAutoBases.get(key),live=true,sequence=0,waiting=false,style,ownedValue
      if (basis===undefined) try { const raw=localStorage.getItem(key);if(raw!==null){const value=JSON.parse(raw);if(typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=250){basis=value;whaleAutoBases.set(key,value)}} } catch {}
      const disable=()=>{
        if(!style)return
        style.remove();style=undefined
        if(root.getAttribute(attribute)==='1'){if(oldAttribute===null)root.removeAttribute(attribute);else root.setAttribute(attribute,oldAttribute)}
        if(root.style.getPropertyValue(variable)===ownedValue){if(oldValue)root.style.setProperty(variable,oldValue,oldPriority);else root.style.removeProperty(variable)}
      }
      const enable=()=>{
        if(style)return
        ownedValue=String(basis)+'px';root.style.setProperty(variable,ownedValue);root.setAttribute(attribute,'1')
        style=document.createElement('style');style.textContent='html[data-tl-native-whale-basis="1"] .dshwv-root{--dshw-base:clamp(122px,calc(var(--tl-native-whale-auto-base) * var(--dshw-scale)),625px)}'
        document.head.append(style)
      }
      const waitForBounds=value=>{if(value===waiting)return;waiting=value;if(value)window.addEventListener('resize',refresh);else window.removeEventListener('resize',refresh)}
      async function refresh() {
        const token=++sequence
        try {
          const value=await bridge.nativeSurfaceLayout()
          if(!live||token!==sequence)return
          if(!value||Object.keys(value).sort().join(',')!=='boundsReady,embedded,height,width'||typeof value.embedded!=='boolean'||typeof value.boundsReady!=='boolean'||!Number.isFinite(value.width)||!Number.isFinite(value.height)||value.width<0||value.height<0||(value.boundsReady?!(value.width>0&&value.height>0):value.width!==0||value.height!==0))throw Error('invalid native layout')
          if(!value.embedded){waitForBounds(false);disable();return}
          if(!value.boundsReady){waitForBounds(true);disable();return}
          if(basis===undefined){basis=Math.min(250,Math.min(value.width,value.height)*.28);whaleAutoBases.set(key,basis);try{localStorage.setItem(key,JSON.stringify(basis))}catch{}}
          waitForBounds(false);enable()
        } catch { if(live&&token===sequence){waitForBounds(false);disable()} }
      }
      const stop=bridge.onNativeSurfaceChanged(refresh)
      void refresh()
      return ()=>{live=false;sequence++;waitForBounds(false);stop();disable()}
    }
    // Same official per-session path as dsh-client-ui-skill rc2
    // src/client/index.ts:115-132: retain/using -> remote.skills.list(sessionId).
    // This controller reads only; configuration stays in the account UI.
    function createBoundSkillCatalogue(ctx, bridge, expected, publish) {
      let disposed = false, sequence = 0, abort
      const close = () => { sequence++; abort?.abort(); abort = undefined; if (!disposed) publish(undefined) }
      const open = async request => {
        if (disposed || request?.action !== 'session-skills' || !same(request.descriptor, expected)) return
        close()
        const ticket = sequence, active = new AbortController(); abort = active
        try {
          if (!same(await bridge.nativeSurfaceDescriptor(), expected) || disposed || ticket !== sequence) return
          if (ctx.sessions.binding(expected.sessionId) === undefined) throw Error('bound session not retained')
          publish({ phase: 'loading' })
          const skills = await ctx.sessions.using(expected.sessionId, { source: 'sourceNativeSkills', signal: active.signal }, async reference => {
            active.signal.throwIfAborted()
            if (reference.binding.session.getSnapshot().openState !== 'open') throw Error('bound session not open')
            const result = await ctx.remote.skills.list({ sessionId: expected.sessionId }, active.signal)
            active.signal.throwIfAborted()
            if (result?.ok !== true || !Array.isArray(result.value?.skills)) throw Error('bound skill catalogue unavailable')
            return result.value.skills
          })
          if (disposed || ticket !== sequence || active.signal.aborted || !same(await bridge.nativeSurfaceDescriptor(), expected)) return
          publish({ phase: 'ready', skills })
        } catch {
          if (!disposed && ticket === sequence && !active.signal.aborted) publish({ phase: 'error' })
        } finally { if (abort === active) abort = undefined }
      }
      const offIntent = bridge.onNativeUtilityRequested(open)
      const offOwner = bridge.onNativeSurfaceChanged(next => { if (!same(next, expected)) close() })
      return { close, dispose() { close(); disposed = true; offIntent(); offOwner() } }
    }
    async function register(ctx, initial, bridge) {
      if (!valid(initial) || typeof bridge?.nativeSurfaceMounted !== 'function' || typeof bridge?.onNativeSurfaceChanged !== 'function') throw Error('invalid native surface contract')
      const extensions = []
      if (initial.kind === 'role' && initial.surface === 'chat') {
        extensions.push(await require.async('./client.scene-memory.js'))
        extensions.push(await require.async('./client.scene-drafts.js'))
        extensions.push(await require.async('./client.session-audio.js'))
        extensions.push(await require.async('./client.mcp-runtime.js'))
        extensions.push(await require.async('./client.webai-files.js'))
      }
      function SourceNative({ SessionProvider, renderFactorySlot }) {
        const [descriptor,setDescriptor] = React.useState(initial), [state,setState] = React.useState({phase:'loading'}), [notice,setNotice] = React.useState('')
        const latest = React.useRef(descriptor), request = React.useRef(0)
        const [extensionFailure, setExtensionFailure] = React.useState()
        const [identityConfirmed, setIdentityConfirmed] = React.useState(false)
        const [identityProbe, setIdentityProbe] = React.useState(0)
        const [skillCatalogue, setSkillCatalogue] = React.useState()
        const skillsControl = React.useRef(), skillDialog = React.useRef()
        React.useEffect(() => {
          if (descriptor.surface !== 'chat' || state.phase !== 'ready') return
          const control = createBoundSkillCatalogue(ctx, bridge, descriptor, setSkillCatalogue)
          skillsControl.current = control
          return () => { if (skillsControl.current === control) skillsControl.current = undefined; control.dispose() }
        }, [descriptor, state.phase])
        React.useEffect(() => { if (skillCatalogue && skillDialog.current && !skillDialog.current.open) skillDialog.current.showModal() }, [skillCatalogue])
        const announcedGeneration = React.useRef(descriptor.generation)
        latest.current = descriptor
        React.useEffect(() => {
          let live = true
          const releases = []
          void Promise.resolve().then(async () => {
            for (const extension of extensions) {
              if (!live || !same(await bridge.nativeSurfaceDescriptor(), descriptor)) return
              const release = await extension.register(ctx, descriptor, bridge, message => { if (live && same(latest.current, descriptor)) setNotice(message) })
              if (!live || !same(await bridge.nativeSurfaceDescriptor(), descriptor)) { release?.(); return }
              if (typeof release === 'function') releases.push(release)
            }
          }).catch(error => { if (live) setExtensionFailure(() => error) })
          return () => { live = false; for (const release of releases.reverse()) release() }
        }, [descriptor])
        React.useEffect(() => descriptor.surface==='chat' ? installNativeChatStyles() : undefined, [descriptor.surface])
        React.useEffect(() => descriptor.surface==='chat' ? installWhaleAutoBasis(bridge,descriptor.sceneId,descriptor.panelId) : undefined, [descriptor.sceneId,descriptor.panelId,descriptor.surface])
        React.useEffect(() => {
          let live=true
          const refreshDescriptor = hint => {
            const token=++request.current
            if (valid(hint)) announcedGeneration.current=Math.max(announcedGeneration.current,hint.generation)
            // A trusted newer identity cancels input activities immediately.
            // Repeated layout/status notifications with the same full tuple
            // must not unmount a composer, its draft or its in-memory uploads.
            if (!same(hint, latest.current)) setIdentityConfirmed(false)
            Promise.resolve(bridge.nativeSurfaceDescriptor()).then(next=>{
              if (!live || token!==request.current) return
              if (!valid(next) || next.generation < announcedGeneration.current) { setIdentityConfirmed(false); setNotice('原生面板身份暂未确认；当前输入已暂停，内容保留。'); return }
              if (same(next, latest.current)) { setIdentityConfirmed(true); setNotice(''); return }
              setIdentityConfirmed(true); setState({phase:'loading'}); setNotice(''); setDescriptor(next)
            }).catch(()=>{ if(live && token===request.current) { setIdentityConfirmed(false); setNotice('原生面板身份暂未确认；当前输入已暂停，内容保留。') } })
          }
          const stop=bridge.onNativeSurfaceChanged(refreshDescriptor)
          refreshDescriptor()
          return () => { live=false; request.current++; stop() }
        }, [identityProbe])
        React.useEffect(() => {
          let live=true, reference
          const waitAbort = new AbortController()
          setState({phase:'loading'})
          const waitForSnapshot = (store, ready) => new Promise((resolve,reject) => {
            let settled=false, dispose=()=>{}
            const finish=(error,value)=>{
              if(settled)return
              settled=true
              waitAbort.signal.removeEventListener('abort',aborted)
              dispose();
              if(error)reject(error);else resolve(value)
            }
            const aborted=()=>finish(undefined,null)
            const inspect=()=>{
              if(waitAbort.signal.aborted){aborted();return}
              try { const value=store.getSnapshot();if(ready(value))finish(undefined,value) }
              catch(error){finish(error)}
            }
            waitAbort.signal.addEventListener('abort',aborted,{once:true})
            try {
              const nextDispose=store.subscribe(inspect)
              if(typeof nextDispose!=='function')throw Error('invalid readiness subscription')
              if(settled)nextDispose();else dispose=nextDispose
              inspect()
            } catch(error) { finish(error) }
          })
          async function open() {
            const sessions=ctx.sessions, list=sessions?.list
            if (!list?.getSnapshot || typeof list.subscribe!=='function' || typeof sessions.retain !== 'function' || typeof sessions.refresh !== 'function') throw Error('session service unavailable')
            const connection=ctx.get?.('connection')
            if (!connection?.generation?.getSnapshot || typeof connection.generation.subscribe!=='function' || !['answer','none'].includes(connection.interactions)) throw Error('connection readiness service unavailable')
            const liveNow=()=>live&&!waitAbort.signal.aborted
            let catalog
            if(connection.interactions==='answer') {
              if(connection.generation.getSnapshot()===undefined) {
                reportRoleGuestPhase(descriptor,'generation-wait-start')
                const generation=await waitForSnapshot(connection.generation,value=>value!==undefined)
                if(!generation)return
                reportRoleGuestPhase(descriptor,'generation-wait-end')
              }
              catalog=list.getSnapshot()
            } else {
              reportRoleGuestPhase(descriptor,'loader-wait-start')
              const loader=ctx.get?.('loader')
              if(typeof loader?.await!=='function')throw Error('loader readiness unavailable')
              await loader.await()
              if(!liveNow()){reportRoleGuestPhase(descriptor,'not-live');return}
              reportRoleGuestPhase(descriptor,'loader-wait-end')
            }
            let refreshed=false
            let listProbeStarted=false
            const refreshCatalog=async()=>{
              if(refreshed)return list.getSnapshot()
              refreshed=true
              reportRoleGuestPhase(descriptor,'catalog-refresh-start')
              try { await sessions.refresh();reportRoleGuestPhase(descriptor,'catalog-refresh-end') }
              catch(error){reportRoleGuestPhase(descriptor,'catalog-refresh-error');throw error}
              return list.getSnapshot()
            }
            if(connection.interactions==='none')catalog=await refreshCatalog()
            else if(catalog?.phase!=='ready' || (Array.isArray(catalog?.ids)&&!catalog.ids.includes(descriptor.sessionId)))catalog=await refreshCatalog()
            if(!liveNow()){reportRoleGuestPhase(descriptor,'not-live');return}
            if(catalog?.phase!=='ready') {
              if(!listProbeStarted && liveNow() && same(descriptor,latest.current)) {
                listProbeStarted=true
                const safeRemoteCode=error=>error?.isDSHRemoteError===true && typeof error.code==='string' && error.code!=='none' && error.code.length<=64 && /^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_-]+)*(?![\s\S])/u.test(error.code)?error.code:'unknown'
                const safeReasonHint=error=>{
                  if(error?.isDSHRemoteError!==true || error.code!=='gateway/internal')return 'unclassified'
                  try {
                    const phase=gatewayApi?.getInvocationFailurePhase?.(error)
                    return phase==='rpc-call'||phase==='result-decode'?phase:'unclassified'
                  } catch { return 'unclassified' }
                }
                const reportListProbe=(outcome,code,reasonHint)=>{
                  if(!liveNow() || !same(descriptor,latest.current))return
                  const message='TL-ROLE-GUEST-LIST-PROBE|guest-list-after-refresh-v2|'+outcome+'|'+code+'|'+reasonHint+'|'+descriptor.surface+'|'+descriptor.generation
                  if(message.length>170)return
                  try { console.info(message) } catch {}
                }
                void (async()=>{
                  try {
                    const result=await ctx.remote.session.list({})
                    if(!liveNow() || !same(descriptor,latest.current))return
                    reportListProbe(result?.ok===true?'ok':result?.ok===false?'result-error':'unknown',
                      result?.ok===true?'none':safeRemoteCode(result?.error),
                      result?.ok===true?'none':safeReasonHint(result?.error))
                  } catch(error) {
                    if(!liveNow() || !same(descriptor,latest.current))return
                    reportListProbe('throw',safeRemoteCode(error),safeReasonHint(error))
                  }
                })().catch(()=>{})
              }
              reportRoleGuestPhase(descriptor,'catalog-not-ready');throw Error('session catalog not ready')
            }
            if (!live) { reportRoleGuestPhase(descriptor, 'not-live'); return }
            if(Array.isArray(catalog.ids)&&!catalog.ids.includes(descriptor.sessionId))reportRoleGuestPhase(descriptor,'catalog-missing-bound')
            try { reference=ctx.sessions.retain(descriptor.sessionId,{source:'sourceNativeSurface'}) }
            catch (error) {
              reportRoleGuestPhase(descriptor, error && typeof error.message === 'string' && error.message === `sessions.retain: unknown session ${descriptor.sessionId}` ? 'retain-unknown-session' : 'retain-error')
              throw error
            }
            if (!reference?.ready || typeof reference.release !== 'function') { reportRoleGuestPhase(descriptor, 'invalid-reference'); throw Error('invalid session reference') }
            reportRoleGuestPhase(descriptor, 'retain-ready-start')
            try { await reference.ready; reportRoleGuestPhase(descriptor, 'retain-ready-end') }
            catch (error) { reportRoleGuestPhase(descriptor, 'retain-ready-error'); throw error }
            if(live) setState({phase:'ready',reference,sessionId:descriptor.sessionId})
          }
          void open().catch(()=>{if(live){reportRoleGuestPhase(descriptor,'terminal-error');setState({phase:'error',message:'无法连接绑定的原生会话。'})}})
          return () => { live=false;waitAbort.abort();reference?.release() }
        }, [descriptor])
        let slot=null
        const factoryName=descriptor.surface==='chat'?'conversation.content':'sidebar.surface'
        const slotHost=ctx.slots.hostFace()
        const subscribeFactory=React.useCallback(listener=>slotHost.subscribeFactory(factoryName,listener),[slotHost,factoryName])
        const getFactoryVersion=React.useCallback(()=>slotHost.getFactoryVersion(factoryName),[slotHost,factoryName])
        React.useSyncExternalStore(subscribeFactory,getFactoryVersion,getFactoryVersion)
        const available=slotHost.factoryOf(factoryName)!==undefined
        React.useEffect(()=>{reportRoleGuestPhase(descriptor,available?'slot-available':'slot-unavailable')},[available,descriptor.surface])
        if (state.phase==='ready' && state.sessionId===descriptor.sessionId && available && typeof SessionProvider==='function' && typeof renderFactorySlot==='function') {
          slot=descriptor.surface==='chat' ? renderFactorySlot('conversation.content',{variant:'embedded',phase:'active',hero:false}) : renderFactorySlot('sidebar.surface',{ownerId:`${descriptor.sceneId}:${descriptor.panelId}`,active:true,initialKind:'files'})
        }
        const mounted = slot !== null && slot !== undefined && slot !== false
        React.useEffect(() => {
          if(!mounted || !identityConfirmed) return undefined
          let live=true; const expected=descriptor
          reportRoleGuestPhase(expected, 'mounted-start')
          void Promise.resolve(bridge.nativeSurfaceDescriptor()).then(current=>{
            if(live && same(current,expected) && same(latest.current,expected)) return Promise.resolve(bridge.nativeSurfaceMounted(expected)).then(()=>{if(live)reportRoleGuestPhase(expected, 'mounted-end')})
          }).catch(()=>{if(live){reportRoleGuestPhase(expected, 'mounted-error');setNotice('原生面板确认失败，当前上下文未确认。')}})
          return () => {live=false}
        }, [descriptor.sceneId,descriptor.panelId,descriptor.sessionId,descriptor.surface,descriptor.generation,mounted,identityConfirmed])
        if(extensionFailure) throw extensionFailure
        if(state.phase==='error') return h('div',{role:'alert'},state.message)
        if(state.phase!=='ready') return h('div',{role:'status'},'正在连接原生会话…')
        if(!mounted) return h('div',{role:'alert'},'原生面板组件不可用。')
        const content=descriptor.surface==='chat' ? h('div',{'data-source-native-root':'','data-conversation-density':'compact',style:{height:'100%',minHeight:0,minWidth:0,display:'flex',flexDirection:'column'}},slot) : slot
        return h(React.Fragment,null,
          h('div', { inert: identityConfirmed ? undefined : '', 'aria-busy': !identityConfirmed, style:{height:'100%',minHeight:0,minWidth:0},
            onKeyDownCapture:event=>{if(!identityConfirmed){event.preventDefault();event.stopPropagation()}},
            onPointerDownCapture:event=>{if(!identityConfirmed){event.preventDefault();event.stopPropagation()}} },
            h(SessionProvider,{key:JSON.stringify(descriptor),session:state.reference},content)),
          notice ? h('div',{role:'alert'},notice, !identityConfirmed ? h('button',{type:'button',onClick:()=>setIdentityProbe(value=>value+1)},'重新确认当前面板') : null) : null,
          skillCatalogue ? h('dialog', { ref: skillDialog, className: 'tl-bound-skills', 'aria-label': '当前助手技能', onCancel: () => skillsControl.current?.close() },
            h('header', null, h('strong', null, '当前助手技能'), h('button', { type: 'button', onClick: () => skillsControl.current?.close(), 'aria-label': '关闭技能目录' }, '关闭')),
            h('p', null, '仅显示本会话技能；管理请使用左上角原生全局界面。'),
            skillCatalogue.phase === 'loading' ? h('p', { role: 'status' }, '正在读取当前助手技能…')
              : skillCatalogue.phase === 'error' ? h('p', { role: 'alert' }, '当前助手技能暂不可读，请稍后重试。')
              : skillCatalogue.skills.length ? h('ul', null, ...skillCatalogue.skills.map((skill, index) => h('li', { key: index }, h('strong', null, skill.name), h('p', null, skill.description))))
                : h('p', null, '当前助手没有返回可用技能。')) : null)
      }
      function RoleSurfaceFactory({ renderSlot }) { return renderSlot('tradeloom.role.surface', {}) }
      function RoleSurfaceCaller({ renderFactorySlot }) { return renderFactorySlot('tradeloom.role.surface-factory', {}) }
      function RoleRootPresenter({ renderFactorySlot }) {
        return h('div', { 'data-source-owned-role': '', style: { position: 'relative', height: '100%', minHeight: 0, minWidth: 0 } },
          renderFactorySlot('tradeloom.role.surface-factory', {}))
      }
      ctx.slots.registerFactory({name:'tradeloom.role.surface-factory',scope:'root',children:{'tradeloom.role.surface':{kind:'single',scope:'root'}}},RoleSurfaceFactory)
      ctx.slots.inject('tradeloom.role.surface',()=>ctx.slots.register({name:'tradeloom.role.surface',children:{'source-native.session-area':{kind:'single',scope:'session'}}},SourceNative))
      ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'source-native'},RoleSurfaceCaller))
      if (initial.surface === 'chat') ctx.slots.inject('root', () => ctx.slots.register({ name: 'root', priority: -1 }, RoleRootPresenter))
      ctx.layout.selectPanel('source-native')
    }
    function registerAccountInventory(ctx, bridge) {
      if (typeof ctx.effect !== 'function' || typeof bridge?.onPluginInventoryRequested !== 'function' || typeof bridge?.pluginInventoryResult !== 'function') throw Error('plugin inventory bridge unavailable')
      ctx.effect(() => {
        let live=true
        const stopRequest=bridge.onPluginInventoryRequested(async request=>{
          try {
            const current=await bridge.nativeSurfaceDescriptor();if(!live || current?.kind!=='account' || current.generation!==request?.generation)return
            const result=await ctx.remote.pluginInventory.list();if(!result?.ok || !Array.isArray(result.value?.entries))throw Error('inventory unavailable')
            const after=await bridge.nativeSurfaceDescriptor();if(!live || after?.kind!=='account' || after.generation!==current.generation)return
            const entries=result.value.entries.map(item=>({entryId:item.entryId,moduleName:item.moduleName,enabled:item.enabled,fiberPhase:item.fiberPhase,meta:item.meta && {title:item.meta.title,description:item.meta.description}}))
            await bridge.pluginInventoryResult(request,{entries})
          } catch { if(live)await bridge.pluginInventoryResult(request,{error:'unavailable'}).catch(()=>{}) }
        })
        return ()=>{live=false;stopRequest()}
      },'source-account-plugin-inventory')
    }
    function registerAccountModelCatalog(ctx, bridge) {
      if (typeof ctx.effect !== 'function' || typeof bridge?.onModelCatalogRequested !== 'function' || typeof bridge?.modelCatalogResult !== 'function') throw Error('model catalog bridge unavailable')
      ctx.effect(() => {
        let live=true
        const stop=bridge.onModelCatalogRequested(async request=>{
          try {
            const current=await bridge.nativeSurfaceDescriptor(); if(!live || current?.kind!=='account' || current.generation!==request?.generation)return
            const result=await ctx.remote.session.modelCatalog(); if(!result?.ok || !Array.isArray(result.value?.groups))throw Error('model catalog unavailable')
            const after=await bridge.nativeSurfaceDescriptor(); if(!live || after?.kind!=='account' || after.generation!==current.generation)return
            const groups=result.value.groups.map(group=>({id:group.id,name:group.name,models:group.models.map(model=>({id:model.id,name:model.name}))}))
            const selected=result.value.default,defaultModel=typeof selected?.provider==='string' && typeof selected?.model==='string'?{provider:selected.provider,model:selected.model}:undefined
            const failures=Array.isArray(result.value.failures)?result.value.failures.map(item=>({id:item.id,name:item.name})):undefined
            await bridge.modelCatalogResult(request,{groups,defaultModel,failures})
          } catch { if(live)await bridge.modelCatalogResult(request,{error:'unavailable'}).catch(()=>{}) }
        })
        return ()=>{live=false;stop()}
      },'source-account-model-catalog')
    }
    function registerAccountSidebarControls(ctx, bridge) {
      if (typeof ctx.effect !== 'function' || typeof bridge?.nativeSurfaceDescriptor !== 'function' || typeof bridge?.accountSidebarCommand !== 'function') throw Error('account sidebar controls unavailable')
      ctx.effect(() => {
        let live = true
        let script
        let loadNotice
        const showUnavailable = () => {
          if (!live || loadNotice) return
          loadNotice = document.createElement('div')
          loadNotice.setAttribute('role', 'status')
          loadNotice.className = 'tl-native-account-controls-unavailable'
          loadNotice.textContent = '侧栏调宽控件暂不可用'
          loadNotice.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 9px;border:1px solid var(--tl-theme-border,#cbd2dc);border-radius:6px;color:var(--tl-theme-text,#20242b);background:var(--tl-theme-panel,#fff);font:12px/1.35 sans-serif;pointer-events:none'
          document.body.appendChild(loadNotice)
        }
        const attach = async () => {
          const descriptor = await bridge.nativeSurfaceDescriptor()
          if (!live || descriptor?.kind !== 'account-sidebar' || !Number.isSafeInteger(descriptor.generation) || !Number.isSafeInteger(descriptor.accountGeneration)) return
          if (window.TradeLoomNativeAccountControls?.mountSidebarResize) {
            window.TradeLoomNativeAccountControls.mountSidebarResize(bridge, descriptor)
            return
          }
          script = document.createElement('script')
          script.src = 'dsh-app://app/source-shell/renderer/replica-ui/native-account-controls.js'
          script.async = true
          script.onload = () => {
            if (!live) return
            const controls = window.TradeLoomNativeAccountControls
            if (typeof controls?.mountSidebarResize === 'function') controls.mountSidebarResize(bridge, descriptor)
            else showUnavailable()
          }
          script.onerror = showUnavailable
          document.head.appendChild(script)
        }
        void attach().catch(showUnavailable)
        return () => {
          live = false
          window.TradeLoomNativeAccountControls?.unmountSidebarResize?.()
          script?.remove()
          loadNotice?.remove()
        }
      }, 'source-account-sidebar-controls')
    }
    function registerAccountSettings(ctx, bridge) {
      if (typeof ctx.effect !== 'function' || typeof bridge?.onSettingsOpenRequested !== 'function' || typeof bridge?.settingsOpenResult !== 'function' || typeof bridge?.settingsOpenClaim !== 'function' || typeof bridge?.settingsOpenStateChanged !== 'function') throw Error('settings bridge unavailable')
      ctx.effect(() => {
        let live = true
        let observedOpen
        let reportedOpen
        let stateReport = Promise.resolve()
        const openWaiters = new Set()
        const service = ctx.get('sourceSettingsOpen')
        if (typeof service?.subscribeOpen !== 'function') throw Error('settings state service unavailable')
        const stopState = service.subscribeOpen(open => {
          if (typeof open !== 'boolean') return
          observedOpen = open
          reportedOpen = open
          if (open) for (const resolve of openWaiters) resolve(true)
          stateReport = (async () => {
            try {
              const current = await bridge.nativeSurfaceDescriptor()
              if (!live || current?.kind !== 'account') return false
              const accepted = await bridge.settingsOpenStateChanged({ generation: current.generation, open })
              return open ? accepted === true : typeof accepted === 'boolean'
            } catch { return false }
          })()
          return stateReport
        })
        const waitForOpen = () => {
          if (observedOpen === true) return Promise.resolve(true)
          return new Promise(resolve => {
            let timer
            const finish = value => {
              clearTimeout(timer)
              openWaiters.delete(finish)
              resolve(value)
            }
            timer = setTimeout(() => finish(false), 1500)
            openWaiters.add(finish)
          })
        }
        const stop = bridge.onSettingsOpenRequested(async request => {
          let failure = 'listener-error'
          try {
            const current = await bridge.nativeSurfaceDescriptor()
            if (!live || current?.kind !== 'account' || current.generation !== request?.generation) return
            failure = 'service-missing'
            const currentService = ctx.get('sourceSettingsOpen')
            if (typeof currentService?.open !== 'function' || typeof currentService?.subscribeOpen !== 'function') throw Error('settings unavailable')
            const beforeClaim = await bridge.nativeSurfaceDescriptor()
            if (!live || beforeClaim?.kind !== 'account' || beforeClaim.generation !== current.generation) return
            failure = 'listener-error'
            await bridge.settingsOpenClaim(request)
            if (!live) return
            const afterClaim = await bridge.nativeSurfaceDescriptor()
            if (!live || afterClaim?.kind !== 'account' || afterClaim.generation !== current.generation) return
            failure = 'service-missing'
            const freshService = ctx.get('sourceSettingsOpen')
            if (typeof freshService?.open !== 'function' || typeof freshService?.subscribeOpen !== 'function') throw Error('settings unavailable')
            failure = 'open-threw'
            await freshService.open()
            if (!live) return
            const afterOpen = await bridge.nativeSurfaceDescriptor()
            if (!live || afterOpen?.kind !== 'account' || afterOpen.generation !== current.generation) return
            failure = 'open-state-missing'
            if (!await waitForOpen() || !live || observedOpen !== true || reportedOpen !== true) throw Error('settings state unavailable')
            failure = 'state-report-rejected'
            const openStateReport = stateReport
            if (await openStateReport !== true || !live || observedOpen !== true || reportedOpen !== true) throw Error('settings state rejected')
            if (!live) return
            failure = 'listener-error'
            await bridge.settingsOpenResult(request, { opened: true })
          } catch {
            if (live) await bridge.settingsOpenResult(request, { error: failure }).catch(() => {})
          }
        })
        return () => {
          live = false
          stop()
          stopState()
          for (const resolve of openWaiters) resolve(false)
          openWaiters.clear()
        }
      }, 'source-account-settings')
    }
    return { register, registerAccountInventory, registerAccountModelCatalog, registerAccountSettings, registerAccountSidebarControls }
  },
})




