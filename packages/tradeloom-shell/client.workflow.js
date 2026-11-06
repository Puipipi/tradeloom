window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell',
  chunk: 'client.workflow.js',
  factory(require) {
    // 工作流（wf）画布：拖动节点、端口连线、双击或键盘打开节点草稿浮层。
    const React = require('react')
    const h = React.createElement
    const ROUTE = '/tradeloom/workflows'
    const NODE_W = 244
    const NODE_H = 112
    const STATUS_LABEL = { pending: '等待', running: '运行中', waiting: '待确认', done: '已完成', failed: '失败', skipped: '已跳过', interrupted: '已中止', cancelled: '已取消', unknown: '状态未知' }
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

    function edgePath(a, b, width = NODE_W, height = NODE_H) {
      const x1 = a.x + width, y1 = a.y + height / 2, x2 = b.x, y2 = b.y + height / 2
      if (x2 < x1) {
        const bend = Math.min(48, Math.max(24, width / 10))
        const lane = b.y >= a.y + height ? (a.y + height + b.y) / 2
          : a.y >= b.y + height ? (b.y + height + a.y) / 2 : Math.max(a.y, b.y) + height + bend
        return `M${x1},${y1} C${x1 + bend},${y1} ${x1 + bend},${lane} ${x1},${lane} L${x2},${lane} C${x2 - bend},${lane} ${x2 - bend},${y2} ${x2},${y2}`
      }
      const dx = Math.max(width / 4, Math.abs(x2 - x1) / 2)
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
      const [draft, setDraft] = React.useState(() => initial?.editing === false ? null : initial?.doc?.nodes.find(node => node.id === initial?.selected) ?? null)
      const [fontSize, setFontSize] = React.useState(14)
      const [editorLayout, setEditorLayout] = React.useState(null)
      const [message, setMessage] = React.useState({ text: '', issues: [] })
      const [linking, setLinking] = React.useState(null)
      const [view, setView] = React.useState({ x: 0, y: 0, scale: 1 })
      const drag = React.useRef(null)
      const surface = React.useRef(null)
      const root = React.useRef(null)
      const dialog = React.useRef(null)
      const draftRef = React.useRef(draft)
      const draftWorkflow = React.useRef(initial?.doc?.id ?? null)
      const editorView = React.useRef(null)
      const currentDoc = React.useRef(doc?.id ?? null)
      const currentRun = React.useRef(run?.id ?? null)
      const openGeneration = React.useRef(0)
      const opening = React.useRef(false)
      const nodeWidth = NODE_W * fontSize / 14
      const nodeHeight = NODE_H * fontSize / 14
      const dirtyRef = React.useRef(false)
      dirtyRef.current = dirty
      draftRef.current = draft
      currentDoc.current = doc?.id ?? null
      currentRun.current = run?.id ?? null


      // Native runs have their own identity and lifecycle; the mock canvas run stays untouched.
      const [native, setNative] = React.useState({ open: false, phase: 'idle', prepared: null, intent: null, run: null, records: [], canvasProjection: null, resumePlan: null, resumeIntent: null, resumeAccepted: false, error: '', blocked: false })
      const nativeRef = React.useRef(native)
      const nativeFlight = React.useRef(false)
      const nativeGeneration = React.useRef(0)
      const nativeController = React.useRef(null)
      const nativeTimer = React.useRef(null)
      const nativeTrigger = React.useRef(null)
      const nativeClose = React.useRef(null)
      const nativeResumeFocus = React.useRef(false)
      const [artifactImports, setArtifactImports] = React.useState({})
      const artifactImportControllers = React.useRef(new Map())
      const nativeSignature = JSON.stringify(doc)
      const nativeContext = React.useRef('')
      nativeContext.current = `${nativeSignature}|${dirty}|${Boolean(draft)}`
      const patchNative = change => {
        nativeRef.current = { ...nativeRef.current, ...change }
        setNative(nativeRef.current)
      }
      function stopNativeObservation() {
        ++nativeGeneration.current
        clearTimeout(nativeTimer.current)
        nativeController.current?.abort()
        nativeFlight.current = false
      }
      React.useEffect(() => {
        stopNativeObservation()
        patchNative({ prepared: null, intent: null, run: null, records: [], canvasProjection: null, cancelOperation: null, cancellation: null, resumePlan: null, resumeIntent: null, resumeAccepted: false, phase: 'idle', error: '', blocked: false })
        return stopNativeObservation
      }, [nativeSignature, dirty, Boolean(draft)])
      React.useEffect(() => () => {
        for (const controller of artifactImportControllers.current.values()) controller.abort()
        artifactImportControllers.current.clear()
      }, [])
      async function importNativeArtifact(node, item, key) {
        if (artifactImportControllers.current.has(key)) return
        const controller = new AbortController(), runId = native.run?.id
        artifactImportControllers.current.set(key, controller)
        setArtifactImports(current => ({ ...current, [key]: { status: 'pending' } }))
        try {
          const response = await fetch('/tradeloom/workflows/native/artifacts', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runId, nodeId: node.id, attempt: node.attempt, sourceSessionSeq: item.sourceSessionSeq, fileIndex: item.fileIndex }),
          })
          let value
          try { value = await response.json() } catch { throw new Error('invalid-response') }
          if (!response.ok || value?.ok !== true || !value.version || typeof value.version.id !== 'string'
            || value.version.runId !== runId || value.version.nodeId !== node.id || value.version.attempt !== node.attempt
            || value.version.source?.seq !== item.sourceSessionSeq || value.version.source?.index !== item.fileIndex
            || !['ready', 'unavailable'].includes(value.version.availability)) throw new Error('import-failed')
          const downloadUrl = value.version.availability === 'ready' && typeof value.version.downloadUrl === 'string'
            && value.version.downloadUrl.startsWith('/tradeloom/workflows/native/artifacts?') ? value.version.downloadUrl : null
          if (!controller.signal.aborted) setArtifactImports(current => ({ ...current, [key]: { status: 'registered', version: { ...value.version, downloadUrl } } }))
        } catch {
          if (!controller.signal.aborted) setArtifactImports(current => ({ ...current, [key]: { status: 'failed' } }))
        } finally {
          if (artifactImportControllers.current.get(key) === controller) artifactImportControllers.current.delete(key)
        }
      }
      const nativeEligibility = dirty || draft ? '请先保存并关闭节点草稿。'
        : !list.some(item => item.id === doc?.id) ? '请先保存工作流。'
          : !doc?.confirmed ? '请先确认工作流草稿。'
            : !Array.isArray(doc.nodes) || doc.nodes.length < 1 || doc.nodes.length > 40
              || doc.nodes.some(node => node.kind !== 'agent' || typeof node.agent !== 'string' || !node.agent || node.agent === 'center')
              ? '原生运行支持非中心助手节点；其他节点仍可模拟运行。' : ''
      const nativeErrorText = code => ({
        center_session_not_live: '请先打开真实中心助手会话，再重新准备。',
        run_parent_mismatch: '中心绑定已变化，已停止旧记录查询；请重新准备。',
        definition_revision_mismatch: '工作流定义已变化，请重新准备并确认。',
        binding_revision_mismatch: '中心绑定已变化，请重新准备并确认。',
        submission_identity_conflict: '本次操作已属于另一确认身份，请重新准备并确认。',
        unsupported_workflow_graph: '当前节点结构暂不支持原生运行。',
        unsupported_model_selection: '所选模型暂不支持原生执行，请调整节点模型后重新准备。',
        upstream_terminal_unverified: '上游节点的结束回执尚未核验，当前节点不能继续。',
        upstream_output_unavailable: '上游节点没有可传递的完整结果，请检查上游记录。',
        native_prompt_too_large: '节点输入超过当前执行上限，请缩减任务或上游内容后重新准备。',
        resume_blocked: '当前记录不能恢复，请重新检查恢复条件。',
        resume_plan_conflict: '恢复计划已变化，请重新检查并确认。',
        resume_revision_conflict: '运行记录已变化，请重新检查恢复条件。',
        operation_conflict: '操作身份与此前请求不一致，请重新检查恢复条件。',
        operation_aborted: '恢复请求尚未核验；请查询状态，重试时沿用同一次操作。',
        workflow_not_confirmed: '工作流尚未确认。',
        authentication_required: '当前请求需要身份验证。',
        request_forbidden: '当前请求没有访问权限。',
        run_store_unavailable: '运行存储暂不可用，请手动重新查询。',
        native_workflow_unavailable: '原生执行暂不可用，请手动重试。',
        invalid_native_response: '原生返回格式无法核验，已停止查询。',
      }[code] ?? '原生执行请求失败，请检查当前权限与服务后手动重试。')
      function nativeFailure(error) {
        if (error.name === 'AbortError') return
        const resumeConflict = error.status === 409 && ['prepare_resume', 'resume'].includes(nativeFlight.current)
          && ['resume_blocked', 'resume_plan_conflict', 'resume_revision_conflict', 'operation_conflict'].includes(error.code)
        const blocked = error.status === 403 || error.status === 401 || error.status === 409 && !resumeConflict
        patchNative({ phase: 'error', error: nativeErrorText(error.code), blocked,
          ...(blocked ? { prepared: null, intent: null, resumePlan: null, resumeIntent: null, resumeAccepted: false } : {}),
          ...(resumeConflict ? { resumePlan: null, resumeIntent: null, resumeAccepted: false } : {}) })
      }
      async function nativeRequest(action, body, accept) {
        if (nativeFlight.current) return
        nativeFlight.current = action
        clearTimeout(nativeTimer.current)
        const generation = nativeGeneration.current, context = nativeContext.current
        const controller = new AbortController()
        nativeController.current = controller
        const current = () => generation === nativeGeneration.current && context === nativeContext.current && !controller.signal.aborted
        try {
          const response = await fetch('/tradeloom/workflows/native', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }),
          })
          const value = await response.json()
          if (!current()) return
          if (!response.ok) throw Object.assign(new Error('native request'), { status: response.status, code: value?.error_code })
          if (value?.schemaVersion !== 1 || value.ok !== true || value.executionMode !== 'native_dsh' || value.action !== action
            || response.status !== (action === 'submit' || action === 'resume' ? 202 : 200)) throw Object.assign(new Error('native response'), { code: 'invalid_native_response' })
          accept(value)
        } catch (error) { if (current()) nativeFailure(error) }
        finally { if (generation === nativeGeneration.current) { nativeFlight.current = false; nativeController.current = null } }
      }
      function prepareNative(event) {
        if (nativeEligibility || nativeFlight.current) return
        if (event?.currentTarget) nativeTrigger.current = event.currentTarget
        const previous = nativeRef.current
        if (previous.resumeIntent && !previous.resumeAccepted) {
          patchNative({ open: true, phase: 'error', error: '上次恢复请求结果尚未核验；重试将复用同一次操作。' })
          return
        }
        if (previous.intent && previous.prepared && !previous.blocked && !previous.run?.settled) {
          patchNative({ open: true, ...(!previous.run?.id ? { phase: 'error', error: '上次提交结果尚未核验；重试将复用同一次操作。' } : {}) })
          return
        }
        stopNativeObservation()
        patchNative({ open: true, phase: 'preparing', prepared: null, intent: null, run: null, records: [], canvasProjection: null, cancelOperation: null, cancellation: null, resumePlan: null, resumeIntent: null, resumeAccepted: false, error: '', blocked: false })
        void nativeRequest('prepare', { workflowId: doc.id }, value => {
          const prepared = value.prepared
          const nodes = prepared?.graph?.nodes ?? (prepared?.node ? [prepared.node] : [])
          const graph = prepared?.graph
          const sameNodes = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length
            && left.every((node, index) => node?.id === right[index]?.id && node.roleId === right[index]?.roleId && node.agentPreset === right[index]?.agentPreset)
          if (prepared?.workflowId !== doc.id || prepared.eligible !== true || prepared.confirmed !== true
            || prepared.executionMode !== 'native_dsh' || !/^sha256:[a-f0-9]{64}$/.test(prepared.definitionRevision ?? '')
            || !/^(?:0|[1-9][0-9]{0,63})$/.test(prepared.bindingRevision ?? '')
            || prepared.center?.roleId !== 'center' || prepared.center.archiveState !== 'unarchived'
            || typeof prepared.center.sessionId !== 'string' || !prepared.center.sessionId
            || typeof prepared.center.workspaceId !== 'string' || !prepared.center.workspaceId
            || !Array.isArray(nodes) || nodes.length !== doc.nodes.length
            || nodes.some((node, index) => node?.id !== doc.nodes[index].id || node.roleId !== doc.nodes[index].agent || typeof node.agentPreset !== 'string' || !node.agentPreset)
            || new Set(nodes.map(node => node.id)).size !== nodes.length
            || (graph ? graph.nodeCount !== nodes.length || graph.edgeCount !== doc.edges.length || graph.maxConcurrent !== 1
              || JSON.stringify(graph.roleIds) !== JSON.stringify([...new Set(nodes.map(node => node.roleId))])
              || (nodes.length === 1 ? !sameNodes([prepared.node], nodes) : Object.hasOwn(prepared, 'node') || !sameNodes(prepared.nodes, nodes))
              : nodes.length !== 1 || doc.edges.length !== 0)) throw Object.assign(new Error('prepare'), { code: 'invalid_native_response' })
          patchNative({ prepared: { ...prepared, nodes }, phase: 'confirming' })
        })
      }
      function checkNativeRun(value, expected) {
        const validNode = node => {
          if (!node || typeof node.id !== 'string' || !node.id || typeof node.status !== 'string'
            || !Number.isSafeInteger(node.attempt) || node.attempt < 0 || typeof node.settled !== 'boolean' || typeof node.succeeded !== 'boolean') return false
          if (!node.settled) return node.succeeded === false && node.terminalReceipt == null
          const receipt = node.terminalReceipt
          if (!receipt || receipt.workflowRunId !== value.id || receipt.nodeId !== node.id || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) return false
          if (receipt.source === 'subagent/end') {
            const status = receipt.stopReason === 'completed' ? 'done' : receipt.stopReason === 'aborted' ? 'interrupted' : 'failed'
            const receiptStatus = status === 'done' ? 'completed' : status
            return typeof receipt.stopReason === 'string' && Boolean(receipt.stopReason) && receipt.status === receiptStatus && node.status === status
              && node.attempt > 0 && receipt.attempt === node.attempt
              && ['childId', 'nativeRunId', 'toolCallId'].every(key => typeof node[key] === 'string' && node[key] && receipt[key] === node[key])
              && node.succeeded === (status === 'done')
          }
          return receipt.source === 'native-run-journal' && receipt.status === 'skipped' && receipt.reason === 'UPSTREAM_FAILED'
            && node.status === 'skipped' && node.attempt === 0 && node.succeeded === false
            && ['childId', 'nativeRunId', 'toolCallId'].every(key => node[key] == null)
            && Array.isArray(receipt.blockedBy) && receipt.blockedBy.length > 0
            && receipt.blockedBy.every(id => id !== node.id && value.nodes.some(parent => parent.id === id && ['failed', 'skipped'].includes(parent.status)))
        }
        if (!value || value.executionMode !== 'native_dsh' || value.workflowId !== doc.id || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 40
          || !value.nodes.every(validNode) || new Set(value.nodes.map(node => node.id)).size !== value.nodes.length
          || typeof value.sessionId !== 'string' || !value.sessionId || !/^sha256:[a-f0-9]{64}$/.test(value.definitionRevision ?? '')
          || !/^(?:0|[1-9][0-9]{0,63})$/.test(value.bindingRevision ?? '')
          || typeof value.settled !== 'boolean' || typeof value.succeeded !== 'boolean' || !/^[a-f0-9-]{36}$/.test(value.id ?? '')
          || (expected?.id && value.id !== expected.id)
          || (expected?.sessionId && value.sessionId !== expected.sessionId)
          || (expected?.definitionRevision && value.definitionRevision !== expected.definitionRevision)
          || (expected?.bindingRevision && value.bindingRevision !== expected.bindingRevision)
          || (expected?.nodes && (value.nodes.length !== expected.nodes.length || !expected.nodes.every(node => value.nodes.some(actual => actual.id === node.id
            && (node.roleId == null || actual.roleId == null || actual.roleId === node.roleId)
            && (node.agentPreset == null || actual.agentPreset == null || actual.agentPreset === node.agentPreset)))))
          || value.settled !== value.nodes.every(node => node.settled)
          || (value.settled && (!Array.isArray(value.terminalReceipt) || value.terminalReceipt.length !== value.nodes.length
            || value.terminalReceipt.some((receipt, index) => !receipt || typeof receipt !== 'object'
              || JSON.stringify(Object.entries(receipt).sort()) !== JSON.stringify(Object.entries(value.nodes[index].terminalReceipt).sort()))))
          || (value.succeeded && (!value.settled || value.status !== 'done' || !value.nodes.every(node => node.succeeded)))) {
          throw Object.assign(new Error('run identity'), { code: 'invalid_native_response' })
        }
        return value
      }
      function observeNative(runId, expected, count = 0) {
        void nativeRequest('get', { runId }, value => {
          const result = checkNativeRun(value.run, { ...expected, id: runId })
          patchNative({ run: result, phase: result.settled ? 'settled' : count >= 29 ? 'paused' : 'observing', error: '' })
          if (!result.settled && count < 29) nativeTimer.current = setTimeout(() => observeNative(runId, result, count + 1), document.hidden ? 4000 : 1000)
        })
      }
      function submitNative() {
        const state = nativeRef.current
        if (nativeFlight.current || !state.prepared || state.blocked || nativeEligibility) return
        const intent = state.intent ?? { workflowId: state.prepared.workflowId, operationId: window.crypto.randomUUID(),
          expectedDefinitionRevision: state.prepared.definitionRevision, expectedBindingRevision: state.prepared.bindingRevision, confirm: true }
        patchNative({ intent, phase: 'submitting', error: '' })
        void nativeRequest('submit', intent, value => {
          if (value.operationId !== intent.operationId || value.submission?.accepted !== true || value.submission.settled !== false
            || !/^[a-f0-9-]{36}$/.test(value.submission.runId ?? '')) throw Object.assign(new Error('submission'), { code: 'invalid_native_response' })
          patchNative({ phase: 'accepted', run: { id: value.submission.runId }, error: '', canvasProjection: {
            signature: nativeSignature, workflowId: intent.workflowId, runId: value.submission.runId,
            definitionRevision: intent.expectedDefinitionRevision, bindingRevision: intent.expectedBindingRevision,
            sessionId: state.prepared.center.sessionId, nodes: state.prepared.nodes,
          } })
          nativeTimer.current = setTimeout(() => observeNative(value.submission.runId, {
            sessionId: state.prepared.center.sessionId, definitionRevision: intent.expectedDefinitionRevision, bindingRevision: intent.expectedBindingRevision,
            nodes: state.prepared.nodes,
          }), 1000)
        })
      }
      function nativeRunIdentity(state) {
        if (state.run?.definitionRevision) return state.run
        return state.prepared ? { ...state.run, sessionId: state.prepared.center.sessionId,
          definitionRevision: state.prepared.definitionRevision, bindingRevision: state.prepared.bindingRevision, nodes: state.prepared.nodes } : state.run
      }
      function cancelNative() {
        const state = nativeRef.current
        if (!state.run?.id || state.blocked || state.run.settled) return
        // A stop request takes priority over a local read, never over another mutation.
        if (nativeFlight.current === 'get') stopNativeObservation()
        if (nativeFlight.current) return
        const operationId = state.cancelOperation ?? window.crypto.randomUUID()
        patchNative({ phase: 'cancelling', cancelOperation: operationId, error: '' })
        void nativeRequest('cancel', { runId: state.run.id, operationId }, value => {
          if (value.operationId !== operationId || value.cancellation?.runId !== state.run.id || value.cancellation.settled !== false) throw Object.assign(new Error('cancel'), { code: 'invalid_native_response' })
          patchNative({ phase: 'cancel-requested', cancellation: value.cancellation })
          nativeTimer.current = setTimeout(() => observeNative(state.run.id, nativeRunIdentity(state)), 1000)
        })
      }
      function prepareNativeResume() {
        const state = nativeRef.current
        if (!state.run?.definitionRevision || !['interrupted', 'waiting'].includes(state.run.status) || state.blocked) return
        if (state.resumeIntent && !state.resumeAccepted) {
          patchNative({ phase: 'error', error: '上次恢复请求结果尚未核验；请查询状态或重试同一次操作。' })
          return
        }
        if (nativeFlight.current === 'get') stopNativeObservation()
        if (nativeFlight.current) return
        stopNativeObservation()
        patchNative({ phase: 'preparing-resume', resumePlan: null, resumeIntent: null, resumeAccepted: false, error: '' })
        void nativeRequest('prepare_resume', { runId: state.run.id }, value => {
          const plan = value.preparedResume
          const known = new Set(state.run.nodes.map(node => node.id))
          const nodeIds = ids => Array.isArray(ids) && ids.length <= known.size && new Set(ids).size === ids.length && ids.every(id => known.has(id))
          const blocked = plan?.blocked
          const listed = plan && Array.isArray(blocked) && nodeIds(plan.eligibleNodeIds) && nodeIds(plan.completedNodeIds)
            ? [...plan.eligibleNodeIds, ...plan.completedNodeIds, ...blocked.filter(item => item?.nodeId != null).map(item => item.nodeId)] : []
          if (!plan || plan.runId !== state.run.id || !Number.isSafeInteger(plan.expectedRunRevision) || plan.expectedRunRevision < 1
            || Number.isSafeInteger(state.run.revision) && plan.expectedRunRevision < state.run.revision
            || plan.definitionRevision !== state.run.definitionRevision || plan.bindingRevision !== state.run.bindingRevision
            || !/^sha256:[a-f0-9]{64}$/.test(plan.resumePlanHash ?? '') || typeof plan.eligible !== 'boolean'
            || !nodeIds(plan.eligibleNodeIds) || !nodeIds(plan.completedNodeIds) || !Array.isArray(blocked) || blocked.length > known.size + 2
            || blocked.some(item => !item || item.nodeId !== null && !known.has(item.nodeId) || typeof item.reason !== 'string' || !item.reason)
            || new Set(listed).size !== listed.length || listed.length !== known.size
            || plan.eligible !== (plan.eligibleNodeIds.length > 0 && blocked.length === 0)) throw Object.assign(new Error('resume plan'), { code: 'invalid_native_response' })
          patchNative({ resumePlan: plan, phase: plan.eligible ? 'resume-confirming' : 'resume-blocked' })
        })
      }
      function resumeNative() {
        const state = nativeRef.current, plan = state.resumePlan
        if (nativeFlight.current || state.blocked || !plan?.eligible || !state.run?.id || state.resumeAccepted || nativeEligibility) return
        const intent = state.resumeIntent ?? { runId: state.run.id, operationId: window.crypto.randomUUID(), expectedRunRevision: plan.expectedRunRevision,
          expectedDefinitionRevision: plan.definitionRevision, expectedBindingRevision: plan.bindingRevision, resumePlanHash: plan.resumePlanHash, confirm: true }
        nativeResumeFocus.current = true
        // A prior activation's cancel operation cannot cancel a resumed activation.
        // Only this explicit new resume confirmation discards that prior cancel ID.
        patchNative({ resumeIntent: intent, phase: 'resuming', error: '', ...(!state.resumeIntent ? { cancelOperation: null, cancellation: null } : {}) })
        void nativeRequest('resume', intent, value => {
          if (value.operationId !== intent.operationId || value.resumption?.runId !== intent.runId || value.resumption.accepted !== true
            || value.resumption.settled !== false || typeof value.resumption.reused !== 'boolean') throw Object.assign(new Error('resume acknowledgement'), { code: 'invalid_native_response' })
          patchNative({ phase: 'resume-accepted', resumeAccepted: true, error: '' })
          nativeTimer.current = setTimeout(() => observeNative(intent.runId, nativeRunIdentity(state)), 1000)
        })
      }
      function listNative(event) {
        if (nativeFlight.current) return
        if (event?.currentTarget) nativeTrigger.current = event.currentTarget
        stopNativeObservation()
        patchNative({ open: true, phase: 'listing', error: '', records: [], cancelOperation: null, cancellation: null,
          ...(nativeRef.current.blocked ? { blocked: false, prepared: null, intent: null, run: null } : {}) })
        void nativeRequest('list', { workflowId: doc.id }, value => {
          if (!Array.isArray(value.runs)) throw Object.assign(new Error('list'), { code: 'invalid_native_response' })
          patchNative({ records: value.runs.map(item => checkNativeRun(item)), phase: 'listed' })
        })
      }
      function closeNative() {
        stopNativeObservation()
        patchNative({ open: false, phase: nativeRef.current.run?.id ? 'paused' : 'idle' })
        nativeTrigger.current?.focus()
      }
      React.useEffect(() => { if (native.open) nativeClose.current?.focus() }, [native.open])
      React.useEffect(() => {
        if (nativeResumeFocus.current && native.phase !== 'resuming') {
          nativeResumeFocus.current = false
          if (native.open) nativeClose.current?.focus()
        }
      }, [native.phase, native.open])

      // Geometry follows the inherited native text setting; viewport width never changes text size.
      React.useEffect(() => {
        const measure = () => { if (root.current) setFontSize(parseFloat(getComputedStyle(root.current).fontSize) || 14) }
        measure()
        const observer = new MutationObserver(measure)
        for (let element = root.current; element; element = element.parentElement) observer.observe(element, { attributes: true, attributeFilter: ['style', 'class'] })
        return () => observer.disconnect()
      }, [Boolean(doc)])

      React.useEffect(() => {
        if (!draft) return
        const previous = document.activeElement
        const nodeId = draft.id
        dialog.current?.querySelector('input,button,select,textarea')?.focus({ preventScroll: true })
        return () => {
          const node = [...(root.current?.querySelectorAll('[data-node-id]') ?? [])].find(item => item.dataset.nodeId === nodeId)
          if (node) node.focus({ preventScroll: true })
          else if (previous?.isConnected && previous !== document.body) previous.focus({ preventScroll: true })
          else root.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
        }
      }, [draft?.id])

      React.useEffect(() => {
        if (!draft || !surface.current) return
        if (!editorView.current) editorView.current = { ...view }
        const place = () => {
          const rect = surface.current?.getBoundingClientRect()
          const frame = root.current?.getBoundingClientRect()
          if (!rect || !frame || !editorView.current) return
          const scale = editorView.current.scale, width = nodeWidth * scale, height = nodeHeight * scale, gap = 16
          const sideWidth = Math.min(400, rect.width - width - gap * 3)
          let layout, target
          if (sideWidth >= 300 && rect.height >= Math.max(height + gap * 2, 260)) {
            const panelHeight = Math.min(560, rect.height - gap * 2)
            layout = { left: rect.width - sideWidth - gap, top: (rect.height - panelHeight) / 2, width: sideWidth, height: panelHeight, mode: 'side' }
            target = { x: (layout.left - gap - width) / 2, y: (rect.height - height) / 2 }
          } else if (rect.width >= width + gap * 2 && rect.height >= height + 220 + gap * 3) {
            const panelWidth = Math.min(400, rect.width - gap * 2), panelHeight = Math.min(420, rect.height - height - gap * 3)
            layout = { left: (rect.width - panelWidth) / 2, top: rect.height - panelHeight - gap, width: panelWidth, height: panelHeight, mode: 'stack' }
            target = { x: (rect.width - width) / 2, y: gap }
          } else {
            layout = { left: gap, top: gap, width: Math.max(0, rect.width - gap * 2), height: Math.max(0, rect.height - gap * 2), mode: 'overlay-fallback' }
          }
          if (layout.mode === 'overlay-fallback') {
            layout = { ...layout, left: gap, top: gap, width: Math.max(0, frame.width - gap * 2), height: Math.max(0, frame.height - gap * 2) }
          } else {
            layout = { ...layout, left: layout.left + rect.left - frame.left, top: layout.top + rect.top - frame.top }
          }
          setEditorLayout(layout)
          if (target) setView({ x: target.x - draft.position.x * scale, y: target.y - draft.position.y * scale, scale })
        }
        place()
        const observer = new ResizeObserver(place)
        observer.observe(surface.current)
        observer.observe(root.current)
        return () => observer.disconnect()
      }, [draft?.id, fontSize])

      const refreshList = React.useCallback(async () => {
        const value = await api('GET')
        setCatalog(value.catalog)
        setList(value.workflows)
        return value.workflows
      }, [])

      const open = React.useCallback(async id => {
        const generation = ++openGeneration.current
        opening.current = true
        try {
          const value = await api('GET', null, `?id=${encodeURIComponent(id)}`)
          if (generation !== openGeneration.current) return
          currentDoc.current = value.workflow?.id ?? null; currentRun.current = value.run?.id ?? null
          opening.current = false
          closeEditor(); setDoc(value.workflow); setRun(value.run); setDirty(false); setSelected(null)
        } catch (error) {
          if (generation !== openGeneration.current) return
          opening.current = false
          setMessage({ text: `打开工作流失败：${error.message}`, issues: [] })
        }
      }, [])

      React.useEffect(() => {
        if (initial) return
        const generation = openGeneration.current
        refreshList().then(items => { if (generation === openGeneration.current) return items[0] ? open(items[0].id) : setDoc(emptyWorkflow()) })
          .catch(error => setMessage({ text: `工作流服务不可用：${error.message}`, issues: [] }))
      }, [])

      // 运行中快速轮询节点状态；空闲时慢速同步，接住中心 agent 提交的草稿或发起的运行。
      const active = run && !run.finishedAt
      React.useEffect(() => {
        let disposed = false
        const timer = setInterval(async () => {
          const generation = openGeneration.current, docId = doc?.id ?? null, runId = run?.id ?? null
          const isCurrent = () => !disposed && !opening.current && generation === openGeneration.current && currentDoc.current === docId && currentRun.current === runId
          try {
            if (!isCurrent()) return
            if (active) {
              const value = await api('GET', null, `?run=${runId}`)
              if (isCurrent()) setRun(value.run)
              return
            }
            const items = await refreshList()
            if (isCurrent() && docId && !dirtyRef.current && !draftRef.current && items.some(item => item.id === docId)) {
              const value = await api('GET', null, `?id=${encodeURIComponent(docId)}`)
              if (isCurrent() && !dirtyRef.current && !draftRef.current) { setDoc(value.workflow); setRun(value.run) }
            }
          } catch { /* 下次轮询重试 */ }
        }, active ? 800 : 4000)
        return () => { disposed = true; clearInterval(timer) }
      }, [active, run?.id, doc?.id, Boolean(draft)])

      function edit(next) { dirtyRef.current = true; setDoc(next); setDirty(true) }
      function newWorkflow() {
        const next = emptyWorkflow()
        ++openGeneration.current; opening.current = false
        currentDoc.current = next.id; currentRun.current = null
        closeEditor(); edit(next); setRun(null); setSelected(null)
      }
      function updateNode(id, patch) { edit({ ...doc, nodes: doc.nodes.map(node => node.id === id ? { ...node, ...patch } : node) }) }
      function closeEditor() {
        setDraft(null); setEditorLayout(null)
        if (editorView.current) setView(editorView.current)
        editorView.current = null
      }
      function openEditor(node) {
        draftWorkflow.current = doc.id
        draftRef.current = { ...node, model: node.model ? { ...node.model } : node.model }
        setSelected(node.id); setDraft(draftRef.current)
      }
      function updateDraft(patch) { setDraft(current => ({ ...current, ...patch })) }
      function applyDraft() {
        if (!draft || editingRun) return
        if (draftWorkflow.current !== doc.id || !doc.nodes.some(node => node.id === draft.id)) {
          closeEditor()
          show('节点或工作流已变化，未应用草稿。请重新打开节点。')
          return
        }
        // Position may have changed before opening; only editable fields are applied.
        const { title, instruction, agent, model, platform } = draft
        const fields = { title, instruction }
        if (draft.kind === 'agent') Object.assign(fields, { agent, model })
        if (draft.kind === 'external') fields.platform = platform
        updateNode(draft.id, fields)
        closeEditor()
        show('已应用到本地草稿，尚未保存。请使用工具栏“保存”持久化。')
      }
      function dialogKeys(event) {
        if (event.key === 'Escape') { event.preventDefault(); closeEditor(); return }
        if (event.key !== 'Tab') return
        const items = [...dialog.current.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(item => !item.disabled)
        const first = items[0], last = items[items.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
      function fit() {
        const rect = surface.current?.getBoundingClientRect()
        if (!rect || !doc.nodes.length) return
        // Confirmation controls scale with the canvas, so include them in graph bounds rather than screen padding.
        const unit = fontSize / 14
        const bounds = doc.nodes.map(node => {
          const side = (!nativeCanvas && nodeState(node.id)?.status === 'waiting' ? 58 : 8) * unit
          return { left: node.position.x - side, right: node.position.x + nodeWidth + side, top: node.position.y - 8 * unit, bottom: node.position.y + nodeHeight + 8 * unit }
        })
        const left = Math.min(...bounds.map(box => box.left)), top = Math.min(...bounds.map(box => box.top))
        const width = Math.max(...bounds.map(box => box.right)) - left
        const height = Math.max(...bounds.map(box => box.bottom)) - top
        const padding = Math.min(24, rect.width / 10, rect.height / 10)
        const scale = Math.min(1.6, Math.max(.05, Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height)))
        setView({ x: (rect.width - width * scale) / 2 - left * scale, y: (rect.height - height * scale) / 2 - top * scale, scale })
      }
      function arrange() {
        // Stable dependency columns, with disconnected nodes in the first column.
        const depths = new Map(doc.nodes.map(node => [node.id, 0]))
        for (let i = 0; i < doc.nodes.length; i++) {
          let changed = false
          for (const edge of doc.edges) if (depths.has(edge.from) && depths.has(edge.to)) {
            const next = Math.min(doc.nodes.length - 1, depths.get(edge.from) + 1)
            if (next > depths.get(edge.to)) { depths.set(edge.to, next); changed = true }
          }
          if (!changed) break
        }
        const rows = new Map()
        edit({ ...doc, nodes: doc.nodes.map(node => {
          const column = depths.get(node.id), row = rows.get(column) || 0
          rows.set(column, row + 1)
          return { ...node, position: { x: 40 + column * (nodeWidth + 72), y: 40 + row * (nodeHeight + 48) } }
        }) })
        show('节点已整理到本地草稿，尚未保存。')
      }
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
        closeEditor()
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
        const scale = Math.min(2, Math.max(0.05, view.scale * (event.deltaY < 0 ? 1.1 : 0.9)))
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
          x: Math.round(rect.width / 2 - (target.position.x + nodeWidth / 2) * current.scale),
          y: Math.round(rect.height / 2 - (target.position.y + nodeHeight / 2) * current.scale),
        }))
      }, [waitingKey])

      if (!doc) return h('div', { className: 'tl-wf-empty', role: 'status' }, message.text || '加载工作流…')
      const byId = new Map(doc.nodes.map(node => [node.id, node]))
      // Only this view's confirmed current definition owns graph status. Historical
      // records remain readable in the native list without borrowing current nodes.
      const projection = native.canvasProjection
      const nativeCanvas = Boolean(projection && projection.signature === nativeSignature
        && projection.workflowId === doc.id && !dirty && !draft)
      const currentNativeRun = native.run
      const nativeGraphMatches = nativeCanvas && !native.blocked && currentNativeRun?.id === projection.runId
        && currentNativeRun.workflowId === projection.workflowId && currentNativeRun.sessionId === projection.sessionId
        && currentNativeRun.definitionRevision === projection.definitionRevision && currentNativeRun.bindingRevision === projection.bindingRevision
        && Array.isArray(currentNativeRun.nodes) && currentNativeRun.nodes.length === doc.nodes.length
        && currentNativeRun.nodes.every(node => projection.nodes.some(expected => node.id === expected.id
          && node.roleId === expected.roleId && node.agentPreset === expected.agentPreset
          && doc.nodes.some(current => current.id === node.id && current.agent === expected.roleId)))
      const displayNativeState = node => {
        const status = node.status === 'done' ? node.settled && node.succeeded ? 'done' : 'unknown'
          : ['failed', 'interrupted', 'cancelled', 'skipped'].includes(node.status) ? node.settled && !node.succeeded ? node.status : 'unknown'
            : ['pending', 'running', 'waiting'].includes(node.status) && !node.settled ? node.status : 'unknown'
        return { ...node, status }
      }
      const nativeGraphNodes = nativeGraphMatches ? new Map(currentNativeRun.nodes.map(node => [node.id, displayNativeState(node)])) : null
      const nodeState = id => nativeCanvas ? nativeGraphNodes?.get(id) ?? { status: 'unknown' } : run?.nodes?.[id]
      const editingRun = Boolean(active)
      const selectedNode = selected ? byId.get(selected) : null
      const models = modelGroups.flatMap(group => group.models)


      const nativeBusy = ['preparing', 'submitting', 'listing', 'cancelling', 'preparing-resume', 'resuming'].includes(native.phase)
      const nativeLabels = { idle: '尚未准备', preparing: '正在核对原生执行条件…', confirming: '已准备，尚未启动；请确认本次真实执行。',
        submitting: '正在提交本次确认…', accepted: '请求已接受，尚未核验执行结果。', observing: '正在查询真实执行状态，尚未核验终结。',
        paused: '查询已暂停；可手动重新查询，后台执行不因此停止。', listing: '正在读取当前绑定的原生记录…', listed: '已读取当前绑定的原生记录。',
        cancelling: '正在请求停止…', 'cancel-requested': '已收到停止请求回执，尚未核验终结。', error: '原生请求未完成。',
        'preparing-resume': '正在核对恢复条件…', 'resume-confirming': '恢复条件已核对，尚未执行；请检查所列节点。',
        'resume-blocked': '已核对条件，暂不能恢复。', resuming: '正在提交本次恢复确认…', 'resume-accepted': '恢复请求已接受，尚未核验执行结果。' }
      const resumeUnknown = Boolean(native.resumeIntent && !native.resumeAccepted)
      const resumeBlockReason = reason => ({ run_not_interrupted: '记录未处于可恢复状态。', child_terminal_unverified: '子执行结束尚未核验，暂不能重试。', run_active_in_service: '当前服务仍在执行此记录。' }[reason] ?? `未识别的阻塞原因：${reason}`)
      const nativeStatusLabels = { pending: '等待执行', running: '运行中', waiting: '等待确认', done: '完成记录', failed: '失败记录', interrupted: '中止记录', cancelled: '取消记录', skipped: '已跳过', unknown: '状态未知' }
      const nativeRoleLabel = roleId => (catalog?.agents ?? []).find(agent => agent.id === roleId)?.label ?? roleId ?? '角色未提供'
      function nativeArtifactSection(node) {
        const evidence = node.artifactEvidence, range = evidence?.range, entries = evidence?.declarations
        // This presentation guard does not replace the server's terminal/evidence validation or grant file access.
        const declared = node.artifactState === 'declared' && node.settled && node.terminalReceipt?.source === 'subagent/end'
          && evidence?.schema === 'tradeloom.presented-evidence/v1' && range?.childSessionId === node.childId && range?.nativeRunId === node.nativeRunId
          && Number.isSafeInteger(range?.startInclusive) && Number.isSafeInteger(range?.endExclusive) && range.startInclusive >= 0 && range.endExclusive >= range.startInclusive
          && Array.isArray(entries) && entries.length <= 64 && entries.every(item => item && typeof item.path === 'string' && item.path.length > 0
            && (item.description == null || typeof item.description === 'string') && typeof item.presentCallId === 'string' && item.presentCallId.length > 0
            && Number.isSafeInteger(item.sourceSessionSeq) && item.sourceSessionSeq >= range.startInclusive && item.sourceSessionSeq < range.endExclusive
            && Number.isSafeInteger(item.fileIndex) && item.fileIndex >= 0 && Number.isSafeInteger(item.sourceTurn) && item.sourceTurn >= 0)
        return h('section', { className: 'tl-wf-artifacts', 'aria-label': `节点 ${node.id} 的文件声明`, 'data-artifact-state': declared ? 'declared' : 'unknown' },
          !declared ? h('p', { className: 'tl-wf-artifact-note' }, '产物信息未知') : h(React.Fragment, null,
            h('header', null, h('strong', null, '文件声明'), h('span', null, `${entries.length} 项`)),
            entries.length === 0 ? h('p', null, '本次执行无文件声明') : h('ul', { className: 'tl-wf-artifact-list' }, entries.map((item, index) =>
              h('li', { key: index, className: 'tl-wf-artifact-card' },
                h('span', { className: 'tl-wf-artifact-icon', 'aria-hidden': true }, '▤'),
                h('div', null, h('strong', null, item.path.split(/[\\/]/).pop() || item.path),
                  item.description && h('p', { className: 'tl-wf-artifact-description' }, item.description),
                  h('details', null, h('summary', null, '查看声明来源'),
                    h('code', null, item.path), item.description && h('p', null, item.description),
                    h('p', null, `执行子会话：${range.childSessionId}`), h('p', null, `原生运行：${range.nativeRunId}`),
                    h('p', null, `会话序号：${item.sourceSessionSeq} · 文件索引：${item.fileIndex} · 轮次：${item.sourceTurn}`),
                    h('p', null, `声明调用：${item.presentCallId}`)),
                  (() => {
                    const key = JSON.stringify([native.run?.id, node.id, node.attempt, item.sourceSessionSeq, item.fileIndex])
                    const state = artifactImports[key]
                    return h(React.Fragment, null,
                      h('button', { type: 'button', disabled: state?.status === 'pending' || state?.status === 'registered',
                        onClick: () => { void importNativeArtifact(node, item, key) } },
                      state?.status === 'pending' ? '正在导入…' : state?.status === 'registered' ? '已登记' : '导入产物'),
                      state?.status === 'pending' && h('p', { className: 'tl-wf-artifact-note', role: 'status' }, '正在导入声明的文件…'),
                      state?.status === 'failed' && h('p', { className: 'tl-wf-artifact-note', role: 'alert' }, '导入失败，可重试。'),
                      state?.status === 'registered' && h('p', { className: 'tl-wf-artifact-note', role: 'status' },
                        '已登记：', state.version.name,
                        state.version.downloadUrl && h('a', { href: state.version.downloadUrl }, ' 下载登记版本')))
                  })())))),
            h('p', { className: 'tl-wf-artifact-note' }, '仅为执行声明；导入成功后会显示服务返回的登记版本。')))
      }
      const nativePanel = native.open && h('section', { className: 'tl-wf-native', 'aria-label': '原生执行详情', onKeyDown: event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeNative() }
      } },
        h('header', null, h('strong', null, '原生执行 · 独立于模拟记录'), h('button', { ref: nativeClose, type: 'button', onClick: closeNative, 'aria-label': '关闭原生执行详情' }, '关闭')),
        h('p', { role: 'status', 'aria-live': 'polite' }, native.phase === 'settled'
          ? native.run.succeeded ? '原生执行已成功结束（真实回执已核验）。'
            : native.run.status === 'interrupted' ? '原生执行已中止（真实回执已核验）。' : native.run.status === 'failed' ? '原生执行已失败结束（真实回执已核验）。' : '原生执行已结束，成功状态尚未核验。'
          : nativeLabels[native.phase]),
        native.error && h('p', { role: 'alert' }, native.error),
        native.prepared && h('div', { className: 'tl-wf-native-summary' },
          h('p', null, `${native.prepared.title} · ${native.prepared.nodes.length} 个助手节点`),
          h('p', null, native.prepared.graph ? `${native.prepared.graph.edgeCount} 条连线 · 实际并发上限 ${native.prepared.graph.maxConcurrent}` : '单节点执行'),
          h('ul', null, native.prepared.nodes.map(node => h('li', { key: node.id }, `${nativeRoleLabel(node.roleId)} · 节点 ${node.id}`))),
          h('details', null, h('summary', null, '确认详情'),
            native.prepared.nodes.map(node => h('p', { key: node.id }, `节点 ${node.id} · 角色 ${node.roleId} · 预设 ${node.agentPreset}`)),
            h('p', null, `中心会话 ${native.prepared.center.sessionId} · 工作区 ${native.prepared.center.workspaceId}`),
            h('p', null, `定义 ${native.prepared.definitionRevision}`), h('p', null, `绑定 ${native.prepared.bindingRevision}`))),
        native.phase === 'confirming' && h('button', { type: 'button', onClick: submitNative }, '确认并启动真实原生执行'),
        native.phase === 'error' && native.intent && native.prepared && !native.blocked && !native.run?.id
          && h('button', { type: 'button', onClick: submitNative }, '重试同一次提交'),
        native.run?.id && h('div', null,
          h('p', null, native.run.status ? `运行状态：${nativeStatusLabels[native.run.status] ?? '状态未知'}` : '原生运行记录'),
          native.run.status && !native.run.settled && h('p', null, '该记录尚无可核验终结回执；不等于已完成。'),
          h('div', { className: 'tl-wf-native-actions' },
            h('button', { type: 'button', disabled: nativeBusy || native.blocked, onClick: () => observeNative(native.run.id, nativeRunIdentity(native)) }, '重新查询原生状态'),
            h('button', { type: 'button', disabled: nativeBusy || native.blocked || native.run.settled, onClick: cancelNative }, '请求停止原生执行'),
            h('button', { type: 'button', disabled: nativeBusy || native.blocked || resumeUnknown || !['interrupted', 'waiting'].includes(native.run.status), onClick: prepareNativeResume }, '检查恢复条件')),
          native.cancellation && h('p', null, native.cancellation.abortRequested ? '停止信号已请求，等待真实结束事件。'
            : native.cancellation.reason === 'already_terminal' ? '服务报告记录已终态，仍需查询真实回执。'
              : native.cancellation.intentPersisted || native.cancellation.reason === 'already_requested' ? '停止请求已记录，尚未核验执行结束。' : '当前服务未接受停止信号；请查询记录。'),
          native.resumePlan && h('section', { className: 'tl-wf-native-node', 'aria-label': '恢复计划' },
            h('strong', null, native.resumePlan.eligible ? '可恢复节点' : '暂不能恢复'),
            native.resumePlan.eligibleNodeIds.length > 0 && h('ul', null, native.resumePlan.eligibleNodeIds.map(id => h('li', { key: id }, id))),
            h('p', null, '本次保留、不重跑'),
            native.resumePlan.completedNodeIds.length > 0 ? h('ul', null, native.resumePlan.completedNodeIds.map(id => h('li', { key: id }, id))) : h('p', null, '未提供保留节点。'),
            native.resumePlan.blocked.length > 0 && h('ul', null, native.resumePlan.blocked.map((item, index) => h('li', { key: index }, `${item.nodeId ?? '运行记录'} · ${resumeBlockReason(item.reason)}`))),
            !native.resumePlan.eligible && native.resumePlan.blocked.length === 0 && h('p', null, '没有可恢复的节点。'),
            h('details', null, h('summary', null, '恢复计划版本'),
              h('p', null, `记录修订 ${native.resumePlan.expectedRunRevision}`), h('p', null, `定义 ${native.resumePlan.definitionRevision}`),
              h('p', null, `绑定 ${native.resumePlan.bindingRevision}`), h('p', null, `计划 ${native.resumePlan.resumePlanHash}`)),
            native.phase === 'resume-confirming' && native.resumePlan.eligible && h('button', { type: 'button', disabled: nativeBusy, onClick: resumeNative }, '确认恢复所列节点')),
          resumeUnknown && !nativeBusy && !native.blocked && h('button', { type: 'button', onClick: resumeNative }, '重试同一次恢复请求'),
          h('details', null, h('summary', null, '执行详情'),
            h('p', null, `运行 ID ${native.run.id} · 原始状态 ${native.run.status ?? '未提供'}`),
            h('p', null, `中心会话 ${native.run.sessionId ?? native.prepared?.center.sessionId ?? '未提供'}`),
            h('p', null, `定义 ${native.run.definitionRevision ?? native.prepared?.definitionRevision ?? '未提供'}`),
            h('p', null, `绑定 ${native.run.bindingRevision ?? native.prepared?.bindingRevision ?? '未提供'}`)),
          (native.run.nodes ?? []).map(node => h('section', { key: node.id, className: 'tl-wf-native-node', 'aria-label': `原生节点 ${node.id}` },
            h('strong', null, `${nativeRoleLabel(node.roleId)} · ${node.id}`),
            h('p', null, `${nativeStatusLabels[node.status] ?? '状态未知'} · ${node.settled ? '结束回执已核验' : '结束回执尚未核验'}`),
            node.terminalReceipt?.source === 'native-run-journal' && h('p', null, `上游失败，未派发 · 上游节点 ${node.terminalReceipt.blockedBy.join('、')}`),
            h('details', null, h('summary', null, '节点身份与回执'),
              h('p', null, `角色 ${node.roleId ?? '未提供'} · 预设 ${node.agentPreset ?? '未提供'} · 面板：未提供`),
              h('p', null, `执行子会话 ${node.childId ?? '未派发或未提供'}`),
              h('p', null, `原生运行 ${node.nativeRunId ?? '未提供'} · 工具调用 ${node.toolCallId ?? '未提供'}`),
              h('p', null, `原始状态 ${node.status} · 尝试 ${node.attempt} · 回执来源 ${node.terminalReceipt?.source ?? '未提供'}`)),
            node.output && h('pre', { className: 'tl-wf-output' }, typeof node.output === 'string' ? node.output : Array.isArray(node.output)
              ? node.output.map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '结果文本格式尚不可显示。').join('\n')
              : '结果文本格式尚不可显示。'),
            nativeArtifactSection(node),
            node.error && h('p', null, nativeErrorText(node.error))))),
        native.phase === 'listed' && native.records.length === 0 && h('p', null, '当前绑定未返回原生记录。'),
        native.records.length > 0 && h('ul', { 'aria-label': '当前绑定的原生运行记录' }, native.records.map((record, index) => h('li', { key: record.id },
          h('button', { type: 'button', 'aria-label': `查看原生记录 ${index + 1}`, disabled: nativeBusy || native.blocked || resumeUnknown, onClick: () => { patchNative({ run: record, prepared: null, intent: null, cancelOperation: null, cancellation: null, resumePlan: null, resumeIntent: null, resumeAccepted: false }); observeNative(record.id, record) } }, `原生记录 ${index + 1} · ${nativeStatusLabels[record.status] ?? '状态未知'}`)))),
        h('p', null, '提供方 / 模型：未知。文件声明不代表可预览或下载。'))

      // Toolbar menus stay within their own canvas; no workspace-wide overlay or hidden command.
      function placeToolbarMenu(event) {
        const details = event.currentTarget
        if (event.target !== details || !details.open || !root.current) return
        if (details.classList.contains('tl-wf-status-menu') && details.closest('.tl-wf-view-actions')) return
        const menu = [...details.children].find(node => node.tagName !== 'SUMMARY')
        const summary = details.querySelector('summary')
        if (!menu || !summary) return
        const frame = root.current.getBoundingClientRect(), anchor = summary.getBoundingClientRect(), host = details.getBoundingClientRect(), padding = 8
        const below = Math.max(0, frame.bottom - anchor.bottom - padding), above = Math.max(0, anchor.top - frame.top - padding)
        const needed = Math.min(menu.scrollHeight, Math.max(0, frame.height - padding * 2))
        const upward = below < Math.min(needed, 140) && above > below
        const height = Math.max(1, Math.min(needed, upward ? above : below))
        const width = Math.min(menu.getBoundingClientRect().width, Math.max(0, frame.width - padding * 2))
        const left = Math.max(frame.left + padding, Math.min(anchor.left, frame.right - width - padding))
        const top = upward ? anchor.top - height : anchor.bottom + 4
        Object.assign(menu.style, { left: `${left - host.left}px`, right: 'auto', top: `${top - host.top}px`, bottom: 'auto', maxWidth: `${width}px`, maxHeight: `${height}px` })
      }
      const closeMenuAfter = action => event => {
        const menu = event?.currentTarget?.closest?.('details')
        action()
        if (menu) menu.open = false
      }

      const toolbar = h('div', { className: 'tl-wf-toolbar', role: 'toolbar', 'aria-label': '工作流操作', inert: draft ? '' : undefined },
        h('select', {
          'aria-label': '选择工作流', value: list.some(item => item.id === doc.id) ? doc.id : '',
          onChange: event => event.target.value && open(event.target.value),
        }, !list.some(item => item.id === doc.id) && h('option', { value: '' }, `${doc.title}（未保存）`),
          list.map(item => h('option', { key: item.id, value: item.id }, `${item.source === 'agent' ? '🤖 ' : ''}${item.title}${item.confirmed ? '' : '（待确认）'}`))),
        h('button', { type: 'button', onClick: save, disabled: editingRun }, dirty ? '保存*' : '保存'),
        h('details', { className: 'tl-wf-doc-menu', onToggle: placeToolbarMenu },
          h('summary', { 'aria-label': '工作流文档操作', title: '重命名、新建、确认草稿、删除' }, '⋯'),
          h('div', { className: 'tl-wf-doc-actions', role: 'group', 'aria-label': '工作流文档操作菜单' },
            h('label', null, '工作流名称', h('input', { 'aria-label': '工作流名称', value: doc.title, disabled: editingRun, onChange: event => edit({ ...doc, title: event.target.value }) })),
            h('button', { type: 'button', onClick: event => { newWorkflow(); event.currentTarget.closest('details').open = false } }, '新建'),
            !doc.confirmed && h('button', { type: 'button', className: 'is-primary', onClick: confirm }, '确认草稿'),
            h('button', { type: 'button', onClick: remove, disabled: editingRun || !list.some(item => item.id === doc.id) }, '删除'))),
        h('details', { className: 'tl-wf-execution-menu', onToggle: placeToolbarMenu },
          h('summary', { ref: nativeTrigger, 'aria-label': '工作流执行与记录', title: '模拟运行、原生运行与原生记录' }, active ? '运行中' : '执行'),
          h('div', { className: 'tl-wf-execution-actions', role: 'group', 'aria-label': '工作流执行与记录菜单' },
            h('p', { className: 'tl-wf-execution-note' }, '模拟执行未连接真实 Agent/外部平台；模拟运行记录仅在当前窗口内存保留 30 条。'),
            active ? h('button', { type: 'button', className: 'is-danger', onClick: closeMenuAfter(cancel) }, '停止')
              : h('button', { type: 'button', className: 'is-primary', onClick: closeMenuAfter(start), disabled: !doc.confirmed }, '▶ 模拟运行'),
            h('button', { type: 'button', onClick: closeMenuAfter(prepareNative), disabled: nativeBusy || Boolean(nativeEligibility), title: nativeEligibility || '准备真实原生执行，核对节点与连线' }, '原生运行…'),
            h('button', { type: 'button', onClick: closeMenuAfter(listNative), disabled: nativeBusy }, '原生记录'))),
        h('span', { className: `tl-wf-runstate${nativeCanvas ? ' tl-wf-source' : ''}`, role: 'status', 'aria-live': 'polite' },
          nativeCanvas ? `原生运行 · ${nativeGraphMatches ? '当前返回状态' : '等待状态核验'}`
            : `模拟执行 · ${doc.source === 'agent' && !doc.confirmed ? '草稿待确认' : run ? RUN_LABEL[run.status] ?? run.status : '未运行'}`),
        h('details', { className: 'tl-wf-kinds', onToggle: placeToolbarMenu },
          h('summary', { 'aria-label': '添加节点', title: '添加输入、助手、人工确认、网页平台或输出节点' }, '＋', h('span', { className: 'tl-wf-kind-label' }, ' 节点')),
          h('div', { className: 'tl-wf-kind-menu', role: 'group', 'aria-label': '添加节点' },
          (catalog?.kinds ?? []).map(kind => h('button', {
            key: kind.kind, type: 'button', disabled: editingRun, onClick: event => { addNode(kind.kind); event.currentTarget.closest('details').open = false },
            title: `添加${kind.label}节点`, style: { '--tl-wf-color': kind.color },
          }, h('span', { 'aria-hidden': true }, kind.icon), ` ${kind.label}`)))),
        h('div', { className: 'tl-wf-view-tools', role: 'group', 'aria-label': '画布视图' },
          h('button', { type: 'button', onClick: fit, title: '适应全部节点（主动缩放）', 'aria-label': '适应全部节点' }, '⊡', h('span', { className: 'tl-wf-tool-label' }, ' 适应')),
          h('button', { type: 'button', onClick: () => setView(current => ({ ...current, scale: Math.max(.05, current.scale / 1.1) })), 'aria-label': '缩小画布' }, '−'),
          h('button', { type: 'button', onClick: () => setView(current => ({ ...current, scale: 1 })), 'aria-label': '重置画布缩放' }, `${Math.round(view.scale * 100)}%`),
          h('button', { type: 'button', onClick: () => setView(current => ({ ...current, scale: Math.min(2, current.scale * 1.1) })), 'aria-label': '放大画布' }, '＋'),
          h('details', { className: 'tl-wf-view-menu', onToggle: placeToolbarMenu },
            h('summary', { 'aria-label': '更多画布操作', title: '缩放、整理、编辑节点与节点状态' }, '视图', h('span', { className: 'tl-wf-view-level' }, ` ${Math.round(view.scale * 100)}%`)),
            h('div', { className: 'tl-wf-view-actions', role: 'group', 'aria-label': '更多画布操作菜单' },
              h('div', { className: 'tl-wf-overflow-zoom' },
                h('button', { type: 'button', onClick: () => setView(current => ({ ...current, scale: Math.max(.05, current.scale / 1.1) })), 'aria-label': '缩小画布' }, '− 缩小画布'),
                h('button', { type: 'button', onClick: () => setView(current => ({ ...current, scale: 1 })), 'aria-label': '重置画布缩放' }, `${Math.round(view.scale * 100)}% · 重置缩放`),
                h('button', { type: 'button', onClick: () => setView(current => ({ ...current, scale: Math.min(2, current.scale * 1.1) })), 'aria-label': '放大画布' }, '＋ 放大画布')),
              h('button', { type: 'button', onClick: closeMenuAfter(arrange), disabled: editingRun, title: '整理节点', 'aria-label': '整理节点' }, '☷ 整理节点'),
              h('button', { type: 'button', disabled: !selectedNode, onClick: closeMenuAfter(() => openEditor(selectedNode)), title: '编辑选中节点', 'aria-label': '编辑节点' }, '✎ 编辑节点'),
              h('details', { className: 'tl-wf-status-menu', onToggle: placeToolbarMenu }, h('summary', { title: '节点状态', 'aria-label': '节点状态' }, '◷ 节点状态'),
                h('div', { className: 'tl-wf-status-list' }, Object.entries(STATUS_LABEL).map(([status, label]) => h('span', { key: status }, `${label}：${doc.nodes.filter(node => (nodeState(node.id)?.status ?? 'pending') === status).length}`)))))))
      )

      const edges = h('svg', { className: 'tl-wf-edges', 'aria-hidden': true },
        doc.edges.map(edge => {
          const a = byId.get(edge.from), b = byId.get(edge.to)
          if (!a || !b) return null
          const flowing = ['running', 'waiting'].includes(nodeState(edge.to)?.status) && nodeState(edge.from)?.status === 'done'
          const done = nodeState(edge.to)?.status === 'done'
          return h('path', {
            key: `${edge.from}-${edge.to}`, d: edgePath(a.position, b.position, nodeWidth, nodeHeight),
            className: `tl-wf-edge${flowing ? ' is-flowing' : ''}${done ? ' is-done' : ''}`,
            onDoubleClick: () => !editingRun && edit({ ...doc, edges: doc.edges.filter(item => item !== edge) }),
          }, h('title', null, '双击删除连线'))
        }),
        linking && h('path', { className: 'tl-wf-edge is-preview', d: edgePath(byId.get(linking.from).position, { x: linking.point.x, y: linking.point.y - nodeHeight / 2 }, nodeWidth, nodeHeight) }))

      const nodes = doc.nodes.map(node => {
        const look = appearance(catalog, node)
        const status = nodeState(node.id)?.status
        const model = node.kind === 'agent' && node.model ? models.find(item => item.provider === node.model.provider && item.id === node.model.model) : null
        const sub = node.kind === 'agent' ? `${look.label} · ${model?.name ?? (node.model ? node.model.model : '默认模型')}`
          : node.kind === 'external' ? node.platform : look.label
        return h('div', {
          key: node.id, role: 'button', tabIndex: 0, 'data-node-id': node.id,
          'aria-label': `${node.title}，${sub}${status ? `，${STATUS_LABEL[status]}` : ''}`,
          'aria-pressed': selected === node.id,
          className: `tl-wf-node${status ? ` is-${status}` : ''}${selected === node.id ? ' is-selected' : ''}`,
          style: { left: node.position.x, top: node.position.y, width: nodeWidth, height: nodeHeight, '--tl-wf-color': look.color },
          onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEditor(node) } },
          onDoubleClick: () => openEditor(node),
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
            h('small', null, sub),
            h('span', { className: 'tl-wf-description', title: node.instruction || '双击编辑节点说明' }, node.instruction || '双击编辑节点说明')),
          status && h('span', { className: 'tl-wf-badge' }, h('i', { 'aria-hidden': true }, ({ pending: '○', running: '◌', waiting: '◇', done: '✓', failed: '×', skipped: '–', interrupted: '!', cancelled: '■', unknown: '?' })[status]), STATUS_LABEL[status]),
          node.kind !== 'output' && !editingRun && h('span', {
            className: 'tl-wf-port is-out', title: '拖到另一个节点上连线',
            onPointerDown: event => { event.stopPropagation(); setLinking({ from: node.id, point: toCanvas(event) }) },
          }))
      })

      // 待确认节点两侧的快捷按钮：左绿通过、右红驳回
      const quickDecisions = doc.nodes.filter(node => !nativeCanvas && nodeState(node.id)?.status === 'waiting').map(node =>
        h('div', {
          key: `decide-${node.id}`, className: 'tl-wf-quick', role: 'group', 'aria-label': `${node.title}：人工确认`,
          style: { left: node.position.x, top: node.position.y, width: nodeWidth, height: nodeHeight },
          onPointerDown: event => event.stopPropagation(),
        },
          h('button', { type: 'button', className: 'tl-wf-quick-btn is-approve', title: '通过', 'aria-label': `通过「${node.title}」`, onClick: () => decide(node.id, true) }, '✓'),
          h('button', { type: 'button', className: 'tl-wf-quick-btn is-reject', title: '驳回', 'aria-label': `驳回「${node.title}」`, onClick: () => decide(node.id, false) }, '✕')))

      // 审核时要看的内容：上游节点的输出
      const reviewInputs = selectedNode?.kind === 'review'
        ? doc.edges.filter(edge => edge.to === selectedNode.id).map(edge => ({ node: byId.get(edge.from), output: nodeState(edge.from)?.output })).filter(item => item.node && item.output)
        : []

      const inspector = draft && h('div', { className: 'tl-wf-dialog-backdrop', onPointerDown: event => event.stopPropagation() },
        h('aside', { ref: dialog, className: 'tl-wf-inspector', style: editorLayout ? { left: editorLayout.left, top: editorLayout.top, width: editorLayout.width, height: editorLayout.height } : undefined, 'data-placement': editorLayout?.mode, role: 'dialog', 'aria-modal': true, 'aria-label': '节点设置', 'aria-describedby': 'tl-wf-draft-hint', onKeyDown: dialogKeys },
        h('header', { className: 'tl-wf-dialog-header' }, h('strong', null, `编辑节点 · ${draft.title}`), h('button', { type: 'button', 'aria-label': '关闭节点设置', onClick: closeEditor }, '×')),
        h('p', { id: 'tl-wf-draft-hint', className: 'tl-wf-draft-hint' }, '本地草稿，点工具栏“保存”持久化。'),
        h('div', { className: 'tl-wf-dialog-fields' },
        reviewInputs.length > 0 && h('div', { className: 'tl-wf-review' },
          h('strong', null, '待审核内容'),
          reviewInputs.map(item => h('div', { key: item.node.id },
            h('small', null, item.node.title),
            h('pre', { className: 'tl-wf-output' }, item.output)))),
        h('label', null, '名称', h('input', { value: draft.title, disabled: editingRun, onChange: event => updateDraft({ title: event.target.value }) })),
        draft.kind === 'agent' && h('label', null, 'Agent',
          h('select', { value: draft.agent, disabled: editingRun, onChange: event => updateDraft({ agent: event.target.value }) },
            draft.agent && !(catalog?.agents ?? []).some(agent => agent.id === draft.agent) && h('option', { value: draft.agent }, `${draft.agent}（当前目录未列出）`),
            (catalog?.agents ?? []).map(agent => h('option', { key: agent.id, value: agent.id }, `${agent.icon} ${agent.label}`)))),
        draft.kind === 'agent' && h('label', null, '模型',
          h('select', {
            value: modelKey(draft.model), disabled: editingRun,
            onChange: event => {
              const [provider, modelId] = event.target.value.split('\u0000')
              updateDraft({ model: event.target.value ? { provider, model: modelId } : null })
            },
          },
            h('option', { value: '' }, '跟随 agent 默认模型'),
            draft.model && !models.some(item => modelKey({ provider: item.provider, model: item.id }) === modelKey(draft.model))
              && h('option', { value: modelKey(draft.model) }, `${draft.model.provider} · ${draft.model.model}`),
            modelGroups.map(group => h('optgroup', { key: group.provider, label: group.providerName },
              group.models.map(item => h('option', { key: item.id, value: modelKey({ provider: item.provider, model: item.id }) }, item.name)))))),
        draft.kind === 'external' && h('label', null, '外部平台', h('input', { value: draft.platform ?? '', disabled: editingRun, onChange: event => updateDraft({ platform: event.target.value }) })),
        h('label', null, '说明', h('textarea', { rows: 4, value: draft.instruction ?? '', disabled: editingRun, onChange: event => updateDraft({ instruction: event.target.value }) })),
        !nativeCanvas && nodeState(draft.id)?.status === 'waiting' && h('div', { className: 'tl-wf-decide' },
          h('button', { type: 'button', className: 'is-primary', onClick: () => decide(draft.id, true) }, '通过'),
          h('button', { type: 'button', className: 'is-danger', onClick: () => decide(draft.id, false) }, '驳回')),
        nodeState(draft.id)?.output && h('p', { className: 'tl-wf-draft-hint' }, '节点文本结果 · 文件与 artifact 关联尚未接入'),
        nodeState(draft.id)?.output && h('pre', { className: 'tl-wf-output' }, nodeState(draft.id).output),
        nodeState(draft.id)?.error && h('p', { className: 'tl-wf-error', role: 'alert' }, nodeState(draft.id).error),
        !editingRun && h('button', { type: 'button', className: 'is-danger', onClick: () => deleteNode(draft.id) }, '删除节点')),
        h('footer', { className: 'tl-wf-dialog-actions' },
          h('button', { type: 'button', onClick: closeEditor }, '取消'),
          h('button', { type: 'button', className: 'is-primary', disabled: editingRun, onClick: applyDraft }, '应用到草稿'))))

      return h('section', { ref: root, className: 'tl-wf', 'aria-label': '工作流画布', 'data-state-owner': nativeCanvas ? 'native' : run ? 'simulation' : 'none' },
        h('style', null, WORKFLOW_CSS),
        toolbar,
        nativePanel,
        (message.text || message.issues.length > 0) && h('div', { className: 'tl-wf-message', role: 'status' },
          message.text, message.issues.length > 0 && h('ul', null, message.issues.map(issue => h('li', { key: issue }, issue)))),
        h('div', { className: 'tl-wf-body' },
          h('div', {
            ref: surface, className: 'tl-wf-surface', inert: draft ? '' : undefined,
            onPointerDown: event => {
              if (event.button !== 0) return
              setSelected(null)
              drag.current = { type: 'pan', sx: event.clientX, sy: event.clientY, vx: view.x, vy: view.y }
            },
            onPointerMove, onPointerUp, onPointerLeave: onPointerUp, onWheel,
          },
            h('div', { className: 'tl-wf-layer', style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` } }, edges, nodes, quickDecisions))),
        inspector)
    }

    const WORKFLOW_CSS = `
      .tl-wf { --tl-success:var(--tl-theme-success,var(--dsw-alias-state-success-primary,#0f635a)); --tl-warning:var(--tl-theme-warning,#76501b); --tl-danger:var(--tl-theme-danger,var(--dsw-alias-state-error-primary,#ba2121)); --tl-wf-status-button-ink:var(--tl-theme-canvas,var(--tl-surface,#fff)); position:relative; container-type:size; display:flex; flex-direction:column; height:100%; min-height:0; color:var(--tl-ink,#202b3a); font-size:inherit; }
      .tl-wf-empty { padding:16px; color:var(--tl-muted,#68778c); }
      .tl-wf-native { flex:0 1 auto; box-sizing:border-box; min-height:0; max-height:45%; overflow:auto; padding:.6em .8em; border-bottom:1px solid var(--tl-border,#cbd5e2); background:var(--tl-surface,#fff); overflow-wrap:anywhere; }
      .tl-wf-native ~ .tl-wf-body { min-height:min(4em,25cqh); }
      .tl-wf-native header,.tl-wf-native-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:.5em; }
      .tl-wf-native p { margin:.5em 0; }
      .tl-wf-native ul { margin:.4em 0; padding-inline-start:1.4em; }
      .tl-wf-native-node { margin:.6em 0; padding:.5em .65em; border:1px solid var(--tl-border,#cbd5e2); border-radius:6px; min-width:0; }
      .tl-wf-native button { font:inherit; min-height:2em; max-width:100%; white-space:normal; color:inherit; background:var(--tl-surface,#fff); border:1px solid var(--tl-border,#cbd5e2); border-radius:6px; padding:.3em .6em; }
      .tl-wf-native button:disabled { opacity:.45; }
      .tl-wf-artifacts { margin-top:.5em; min-width:0; }
      .tl-wf-artifacts > header { display:flex; align-items:center; justify-content:space-between; gap:.5em; }
      .tl-wf-native .tl-wf-artifact-list { list-style:none; padding:0; margin:.4em 0; display:flex; flex-direction:column; gap:.4em; }
      .tl-wf-artifact-card { display:flex; align-items:flex-start; gap:.5em; padding:.5em; border:1px solid var(--tl-border,#cbd5e2); border-radius:6px; background:var(--tl-surface-soft,#eef3f9); min-width:0; }
      .tl-wf-artifact-card > div { flex:1; min-width:0; }
      .tl-wf-artifact-icon { flex:none; color:var(--tl-accent,#356fc4); font-size:1.2em; }
      .tl-wf-artifact-card strong, .tl-wf-artifact-card code { display:block; overflow-wrap:anywhere; white-space:normal; font-size:inherit; }
      .tl-wf-artifact-card code, .tl-wf-artifact-note { color:var(--tl-muted,#68778c); font-size:.85em; }
      .tl-wf-artifact-description { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .tl-wf-artifact-card details { margin-top:.4em; }
      .tl-wf-artifact-card summary { font-size:.85em; }
      .tl-wf-toolbar { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px solid var(--tl-border,#cbd5e2); }
      .tl-wf-toolbar button, .tl-wf-inspector button { border:1px solid var(--tl-border,#cbd5e2); background:var(--tl-surface,#fff); color:inherit; border-radius:6px; padding:3px 9px; cursor:pointer; }
      .tl-wf-toolbar button[style] { border-color:var(--tl-wf-color); }
      .tl-wf-toolbar button:disabled { opacity:.45; cursor:default; }
      .tl-wf button.is-primary { background:var(--tl-accent,#356fc4); border-color:var(--tl-accent,#356fc4); color:var(--tl-theme-button-ink,#fff); }
      .tl-wf button.is-danger { border-color:var(--tl-danger,#c0392b); color:var(--tl-danger,#c0392b); }
      .tl-wf-title { width:12em; min-width:0; }
      .tl-wf-kinds, .tl-wf-status-menu, .tl-wf-doc-menu { position:relative; }
      .tl-wf summary { list-style:none; border:1px solid var(--tl-border,#cbd5e2); border-radius:6px; padding:.3em .6em; cursor:pointer; background:var(--tl-surface,#fff); }
      .tl-wf summary::-webkit-details-marker { display:none; }
      .tl-wf-kind-menu, .tl-wf-status-list, .tl-wf-doc-actions { position:absolute; top:calc(100% + 5px); left:0; z-index:12; display:flex; flex-direction:column; gap:4px; padding:6px; min-width:10em; border:1px solid var(--tl-border,#cbd5e2); border-radius:8px; background:var(--tl-surface,#fff); box-shadow:0 8px 24px #0003; }
      .tl-wf-kind-menu button { text-align:left; white-space:nowrap; }
      .tl-wf-status-menu { margin-left:0; }
      .tl-wf-doc-actions { right:0; left:auto; width:min(20em,calc(100vw - 24px)); max-height:min(26em,65vh); overflow:auto; scrollbar-gutter:stable; }
      .tl-wf-doc-actions label { display:flex; flex-direction:column; gap:.3em; min-width:0; }
      .tl-wf-doc-actions input { width:100%; }
      .tl-wf-doc-actions::-webkit-scrollbar { width:5px; }
      .tl-wf-doc-actions::-webkit-scrollbar-thumb { background:var(--tl-muted,#68778c); border-radius:5px; }
      .tl-wf-status-list { right:0; left:auto; font-size:.9em; }
      .tl-wf-overflow-zoom, .tl-wf-view-level { display:none; }
      .tl-wf-overflow-zoom > button { text-align:left; white-space:normal; }
      .tl-wf-view-actions .tl-wf-status-list { position:static; min-width:0; max-height:none; border:0; box-shadow:none; }
      @container (max-height:24em) {
        .tl-wf-view-tools > button:not([aria-label="适应全部节点"]) { display:none; }
        .tl-wf-overflow-zoom { display:flex; flex-direction:column; gap:.25em; }
        .tl-wf-view-level { display:inline; }
      }
      .tl-wf-execution-menu, .tl-wf-view-menu { position:relative; flex:none; }
      .tl-wf-execution-actions, .tl-wf-view-actions { position:absolute; z-index:24; top:calc(100% + 4px); left:0; box-sizing:border-box; min-width:10em; max-width:calc(100cqw - 16px); display:flex; flex-direction:column; gap:.25em; padding:.4em; border:1px solid var(--tl-border,#cbd5e2); border-radius:var(--tl-corner-radius,6px); background:var(--tl-surface,#fff); box-shadow:0 8px 24px #0003; }
      .tl-wf-execution-actions > button, .tl-wf-view-actions > button { text-align:left; white-space:normal; }
      .tl-wf :is(.tl-wf-doc-actions,.tl-wf-execution-actions,.tl-wf-view-actions,.tl-wf-kind-menu,.tl-wf-status-list) { box-sizing:border-box; overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
      @container (max-width:900px) {
        .tl-wf-view-tools > button .tl-wf-tool-label, .tl-wf-kind-label { display:none; }
        .tl-wf-toolbar > select { flex-basis:7em; max-width:12em; }
      }
      .tl-wf-view-tools { display:contents; }
      .tl-wf-view-tools button { flex-shrink:0; }
      .tl-wf-toolbar input, .tl-wf-toolbar select, .tl-wf-toolbar button { font:inherit; min-width:0; max-width:100%; box-sizing:border-box; }
      .tl-wf-toolbar input, .tl-wf-toolbar select { background:var(--tl-surface,#fff); color:inherit; border:1px solid var(--tl-border,#cbd5e2); border-radius:6px; padding:.3em .5em; }
      .tl-wf-toolbar > select { width:12em; flex:1 1 8em; max-width:18em; }
      .tl-wf-toolbar button { padding:.3em .6em; }
      .tl-wf-toolbar summary, .tl-wf-toolbar button { min-height:2em; }
      .tl-wf-toolbar summary { box-sizing:border-box; }
      .tl-wf-execution-note { margin:.25em 0; color:var(--tl-muted,#68778c); font-size:.85em; overflow-wrap:anywhere; }
      @container (max-width:32em) {
        .tl-wf-toolbar > select { width:0; flex-basis:calc(100% - 7em - 12px); max-width:none; }
        .tl-wf-view-tools > button:not([aria-label="适应全部节点"]) { display:none; }
        .tl-wf-overflow-zoom { display:flex; flex-direction:column; gap:.25em; }
        .tl-wf-view-level { display:none; }
      }
      .tl-wf button:focus-visible, .tl-wf summary:focus-visible, .tl-wf input:focus-visible, .tl-wf select:focus-visible, .tl-wf textarea:focus-visible { outline:2px solid var(--tl-accent,#356fc4); outline-offset:2px; }
      .tl-wf-runstate { order:10; flex-basis:100%; color:var(--tl-muted,#68778c); font-size:.85em; overflow-wrap:anywhere; }
      .tl-wf-message { padding:4px 10px; background:var(--tl-surface-soft,#eef3f9); }
      .tl-wf-message ul { margin:2px 0 0 18px; padding:0; color:var(--tl-danger,#c0392b); }
      .tl-wf-body { flex:1 1 0; min-height:0; min-width:0; display:flex; position:relative; }
      .tl-wf-surface { flex:1; min-height:0; min-width:0; position:relative; overflow:hidden; cursor:grab; touch-action:none;
        background-color:var(--tl-surface-soft,#f4f7fb); background-image:radial-gradient(var(--tl-border,#cbd5e2) 1px, transparent 1px); background-size:20px 20px; }
      .tl-wf-layer { position:absolute; inset:0; transform-origin:0 0; }
      .tl-wf-edges { position:absolute; left:0; top:0; width:4000px; height:3000px; overflow:visible; }
      .tl-wf-edge { fill:none; stroke:var(--tl-muted,#8b97ab); stroke-width:2; pointer-events:stroke; cursor:pointer; }
      .tl-wf-edge:hover { stroke:var(--tl-accent,#356fc4); stroke-width:3; }
      .tl-wf-edge.is-done { stroke:var(--tl-muted,#8b97ab); opacity:.6; }
      .tl-wf-edge.is-flowing { stroke:var(--tl-accent,#356fc4); stroke-dasharray:6 6; animation:tl-wf-flow .6s linear infinite; }
      .tl-wf-edge.is-preview { stroke-dasharray:4 4; pointer-events:none; }
      @keyframes tl-wf-flow { to { stroke-dashoffset:-12; } }
      .tl-wf-node { position:absolute; box-sizing:border-box; display:flex; align-items:center; gap:.6em; padding:.7em .8em;
        background:var(--tl-surface,#fff); border:1px solid var(--tl-border,#cbd5e2); border-left:3px solid var(--tl-wf-color); border-radius:8px;
        box-shadow:0 1px 3px rgba(0,0,0,.12); cursor:pointer; user-select:none; transition:opacity .3s, box-shadow .3s; font-size:inherit; }
      .tl-wf-node:focus-visible { outline:2px solid var(--tl-accent,#356fc4); outline-offset:2px; }
      .tl-wf-node.is-selected { outline:1px solid var(--tl-accent,#356fc4); outline-offset:1px; box-shadow:0 0 10px color-mix(in srgb,var(--tl-accent,#356fc4) 22%,transparent); }
      .tl-wf-icon { flex:none; align-self:flex-start; width:1.65em; height:1.65em; display:grid; place-items:center; border-radius:5px; font-size:1em; color:#fff; background:var(--tl-wf-color); }
      .tl-wf-text { display:flex; flex:1; flex-direction:column; gap:.2em; min-width:0; padding-bottom:1em; }
      .tl-wf-text strong, .tl-wf-text small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .tl-wf-text small { color:var(--tl-muted,#68778c); font-size:.86em; }
      .tl-wf-description { color:var(--tl-muted,#68778c); font-size:.86em; line-height:1.35; overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow-wrap:anywhere; }
      .tl-wf-badge { position:absolute; bottom:.4em; right:.7em; display:flex; align-items:center; gap:.3em; font-size:.75em; color:var(--tl-muted,#68778c); }
      .tl-wf-badge i { display:grid; place-items:center; width:1.1em; height:1.1em; font-style:normal; border:1px solid currentColor; border-radius:3px; line-height:1; }
      .tl-wf-node.is-running { box-shadow:0 0 0 1px var(--tl-accent,#356fc4), 0 0 14px color-mix(in srgb,var(--tl-accent,#356fc4) 35%,transparent); animation:tl-wf-pulse 1.2s ease-in-out infinite; }
      .tl-wf-node.is-running .tl-wf-badge { color:var(--tl-accent,#356fc4); }
      .tl-wf-node.is-waiting { box-shadow:0 0 0 1px var(--tl-warning,#b07d00), 0 0 12px color-mix(in srgb,var(--tl-warning,#b07d00) 25%,transparent); animation:tl-wf-pulse 1.6s ease-in-out infinite; }
      .tl-wf-node.is-waiting .tl-wf-badge { color:var(--tl-warning,#b07d00); }
      .tl-wf-node.is-done { border-color:var(--tl-success,#2f7d4f); }
      .tl-wf-node.is-done .tl-wf-badge { color:var(--tl-success,#2f7d4f); }
      .tl-wf-node.is-failed { border-color:var(--tl-danger,#c0392b); box-shadow:0 0 0 1px var(--tl-danger,#c0392b); }
      .tl-wf-node.is-failed .tl-wf-badge { color:var(--tl-danger,#c0392b); }
      .tl-wf-node.is-skipped { opacity:.7; border-style:dashed; }
      .tl-wf-node:is(.is-interrupted,.is-cancelled) { border-color:var(--tl-warning,#b07d00); border-style:dashed; }
      .tl-wf-node:is(.is-interrupted,.is-cancelled) .tl-wf-badge { color:var(--tl-warning,#b07d00); }
      .tl-wf-node.is-unknown { border-style:dashed; }
      .tl-wf-node.is-pending .tl-wf-badge i { border-radius:50%; }
      .tl-wf-node.is-waiting .tl-wf-badge i { border-radius:0; }
      @keyframes tl-wf-pulse { 50% { filter:brightness(1.08); } }
      @media (prefers-reduced-motion: reduce) { .tl-wf-node, .tl-wf-edge { animation:none !important; } }
      .tl-wf-port { position:absolute; top:50%; box-sizing:border-box; width:.85em; height:.85em; transform:translateY(-50%); border-radius:50%; background:var(--tl-surface,#fff); border:2px solid var(--tl-wf-color); }
      .tl-wf-port.is-in { left:calc(-.425em - 3px); }
      .tl-wf-port.is-out { right:calc(-.425em - 1px); cursor:crosshair; }
      .tl-wf-dialog-backdrop { position:absolute; inset:0; z-index:20; display:grid; place-items:center; background:color-mix(in srgb,var(--tl-surface-soft,#f4f7fb) 20%,transparent); }
      .tl-wf-inspector { position:absolute; box-sizing:border-box; width:min(40em,100%); max-height:100%; min-height:0; display:flex; flex-direction:column; border:1px solid var(--tl-accent,#356fc4); border-radius:12px; box-shadow:0 0 0 1px color-mix(in srgb,var(--tl-accent,#356fc4) 35%,transparent),0 14px 44px #0004; background:var(--tl-surface,#fff); }
      .tl-wf-dialog-header { display:flex; gap:8px; align-items:center; justify-content:space-between; padding:.7em .85em .35em; }
      .tl-wf-dialog-header, .tl-wf-inspector > .tl-wf-draft-hint, .tl-wf-dialog-actions { flex-shrink:0; }
      .tl-wf-dialog-header strong { overflow-wrap:anywhere; min-width:0; }
      .tl-wf-dialog-header button { flex:none; font:inherit; }
      .tl-wf-draft-hint { margin:.3em .9em; color:var(--tl-muted,#68778c); font-size:.85em; line-height:1.4; overflow-wrap:anywhere; }
      .tl-wf-dialog-fields { flex:1; min-height:0; overflow:auto; padding:.6em .9em .9em; display:flex; flex-direction:column; gap:.65em; scrollbar-gutter:stable; }
      .tl-wf-dialog-fields > * { flex-shrink:0; }
      .tl-wf-inspector label { display:flex; flex-direction:column; gap:.3em; color:var(--tl-muted,#68778c); min-width:0; }
      .tl-wf-inspector input, .tl-wf-inspector select, .tl-wf-inspector textarea { box-sizing:border-box; width:100%; min-width:0; max-width:100%; color:var(--tl-ink,#202b3a); background:var(--tl-surface-soft,#eef3f9); border:1px solid var(--tl-border,#cbd5e2); border-radius:6px; padding:.45em .55em; font:inherit; }
      .tl-wf-inspector textarea { resize:vertical; min-height:5em; line-height:1.4; }
      .tl-wf-dialog-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:.5em; padding:.6em .9em; border-top:1px solid var(--tl-border,#cbd5e2); }
      .tl-wf-inspector button { font:inherit; padding:.3em .65em; }
      .tl-wf-inspector[data-placement="stack"] .tl-wf-dialog-header { padding:.35em .6em; }
      .tl-wf-inspector[data-placement="stack"] .tl-wf-dialog-header button { padding:.15em .4em; }
      .tl-wf-inspector[data-placement="stack"] .tl-wf-dialog-actions { padding:.35em .6em; }
      @container (max-height:380px) {
        .tl-wf-inspector[data-placement="overlay-fallback"] .tl-wf-dialog-header { padding:.3em .6em; }
        .tl-wf-inspector[data-placement="overlay-fallback"] .tl-wf-dialog-actions { padding:.3em .6em; }
        .tl-wf-inspector[data-placement="overlay-fallback"] > .tl-wf-draft-hint { margin:.2em .6em; }
        .tl-wf-inspector[data-placement="overlay-fallback"] textarea { height:3em; min-height:3em; }
      }
      .tl-wf :is(.tl-wf-native,.tl-wf-dialog-fields,.tl-wf-output)::-webkit-scrollbar { width:5px; height:5px; }
      .tl-wf :is(.tl-wf-native,.tl-wf-dialog-fields,.tl-wf-output)::-webkit-scrollbar-thumb { background:var(--tl-muted,#68778c); border-radius:5px; }
      @media(max-width:800px) { .tl-wf-toolbar { gap:4px; } .tl-wf-tool-label { display:none; } .tl-wf-toolbar > select { max-width:12em; } }
      .tl-wf-decide { display:flex; gap:6px; }
      .tl-wf-quick { position:absolute; pointer-events:none; }
      .tl-wf-quick-btn { pointer-events:auto; position:absolute; top:50%; width:calc(40px * var(--tl-ui-scale,1)); height:calc(40px * var(--tl-ui-scale,1)); margin-top:calc(-20px * var(--tl-ui-scale,1)); border:0; border-radius:50%; color:var(--tl-wf-status-button-ink); font-size:calc(20px * var(--tl-ui-scale,1)); font-weight:700; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.35); }
      .tl-wf-quick-btn.is-approve { left:calc(-54px * var(--tl-ui-scale,1)); background:var(--tl-success,#2f7d4f); }
      .tl-wf-quick-btn.is-reject { right:calc(-54px * var(--tl-ui-scale,1)); background:var(--tl-danger,#c0392b); }
      .tl-wf-quick-btn:hover, .tl-wf-quick-btn:focus-visible { transform:scale(1.1); outline:2px solid var(--tl-accent,#356fc4); outline-offset:2px; }
      .tl-wf-review { display:flex; flex-direction:column; gap:4px; padding:6px; border:1px solid var(--tl-warning,#b07d00); border-radius:6px; }
      .tl-wf-review small { color:var(--tl-muted,#68778c); }
      .tl-wf-output { white-space:pre-wrap; margin:0; padding:6px; max-height:12em; overflow:auto; background:var(--tl-surface-soft,#eef3f9); border-radius:6px; font-size:.9em; overflow-wrap:anywhere; }
      .tl-wf-error { color:var(--tl-danger,#c0392b); margin:0; }
    `

    return { WorkflowCanvas }
  },
})
