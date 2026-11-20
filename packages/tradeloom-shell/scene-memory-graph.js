import { createHash } from 'node:crypto'

const GRAPH_SCOPE = 'tradeloom-scene-memory-graph/v1'
const NODE_KINDS = new Set(['scene', 'profile', 'asset_ref', 'skill_ref', 'session_binding', 'handoff', 'progress', 'decision'])
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const MAX_QUERY_TEXT = 1000
const MAX_CURSOR_LENGTH = 8192
const validBindingRevision = value => (Number.isSafeInteger(value) && value >= 0)
  || (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,63})$/.test(value))

function graphError(code) { return Object.assign(new Error(code), { code }) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validKinds(value) {
  return Array.isArray(value) && value.length <= NODE_KINDS.size
    && value.every(kind => typeof kind === 'string' && NODE_KINDS.has(kind))
    && new Set(value).size === value.length
}

function validPageSize(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE_SIZE
}

function normalizeQueryKinds(value) {
  if (value === undefined || value === null) return null
  if (!validKinds(value)) throw graphError('invalid_arguments')
  return [...value].sort()
}

function validateCursorValue(value) {
  const keys = ['version', 'sessionId', 'sceneId', 'bindingRevision', 'profileRevision', 'handoffRevision',
    'progressTotal', 'decisionTotal', 'text', 'kinds', 'pageSize', 'offset']
  if (!exactKeys(value, keys) || value.version !== 1
    || typeof value.sessionId !== 'string' || !value.sessionId
    || typeof value.sceneId !== 'string' || !value.sceneId
    || !validBindingRevision(value.bindingRevision)
    || !['profileRevision', 'handoffRevision', 'progressTotal', 'decisionTotal', 'offset']
      .every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || typeof value.text !== 'string' || value.text.length > MAX_QUERY_TEXT
    || (value.kinds !== null && (!validKinds(value.kinds)
      || JSON.stringify(value.kinds) !== JSON.stringify([...value.kinds].sort())))
    || !validPageSize(value.pageSize)) {
    throw graphError('scene_graph_cursor_invalid')
  }
  return value
}

function decodeCursor(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(token)) throw graphError('scene_graph_cursor_invalid')
  try {
    return validateCursorValue(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')))
  } catch (error) {
    if (error?.code === 'scene_graph_cursor_invalid') throw error
    throw graphError('scene_graph_cursor_invalid')
  }
}

function normalizeQuery(raw = {}) {
  if (!isRecord(raw) || Object.keys(raw).some(key => !['text', 'kinds', 'pageSize', 'cursor'].includes(key))) {
    throw graphError('invalid_arguments')
  }
  if (raw.text !== undefined && (typeof raw.text !== 'string' || raw.text.length > MAX_QUERY_TEXT)) throw graphError('invalid_arguments')
  if (raw.pageSize !== undefined && !validPageSize(raw.pageSize)) {
    throw graphError('invalid_arguments')
  }
  const supplied = {
    text: raw.text ?? '',
    kinds: normalizeQueryKinds(raw.kinds),
    pageSize: raw.pageSize ?? DEFAULT_PAGE_SIZE,
  }
  if (raw.cursor === undefined) return { ...supplied, offset: 0, cursor: null }
  const cursor = decodeCursor(raw.cursor)
  if ((raw.text !== undefined && supplied.text !== cursor.text)
    || (raw.kinds !== undefined && JSON.stringify(supplied.kinds) !== JSON.stringify(cursor.kinds))
    || (raw.pageSize !== undefined && supplied.pageSize !== cursor.pageSize)) throw graphError('scene_graph_cursor_invalid')
  return { text: cursor.text, kinds: cursor.kinds, pageSize: cursor.pageSize, offset: cursor.offset, cursor }
}

function sceneGraphNodes(sceneId, scene, targetSessionId) {
  const sceneNodeId = `scene:${sceneId}`
  const profileNodeId = `profile:${sceneId}`
  const bindingNodeId = `session-binding:${sceneId}:${encodeURIComponent(targetSessionId)}`
  const nodes = [
    { id: sceneNodeId, kind: 'scene', label: sceneId, source: { scope: 'sceneMemory', record: 'scene', sceneId }, data: { sceneId } },
    {
      id: profileNodeId, kind: 'profile', label: scene.profile.responsibility || '场景配置',
      source: { scope: 'sceneMemory', record: 'profile', sceneId },
      data: { revision: scene.profile.revision, responsibility: scene.profile.responsibility,
        assetRefCount: scene.profile.assetRefs.length, primarySkill: scene.profile.primarySkill },
    },
    {
      id: bindingNodeId, kind: 'session_binding', label: '当前绑定会话',
      source: { scope: 'sceneMemory', record: 'sessionScenes', sceneId },
      data: { sessionId: targetSessionId, bindingRevision: scene.bindingRevision },
    },
  ]
  const edges = [
    { id: `edge:${sceneId}:profile`, source: sceneNodeId, target: profileNodeId, kind: 'has_profile' },
    { id: `edge:${sceneId}:binding`, source: sceneNodeId, target: bindingNodeId, kind: 'bound_to' },
  ]

  const refOccurrences = new Map()
  for (const ref of scene.profile.assetRefs) {
    const refKey = `${ref.kind}\0${ref.id}`
    const occurrence = refOccurrences.get(refKey) ?? 0
    refOccurrences.set(refKey, occurrence + 1)
    const digestInput = JSON.stringify([sceneId, ref.kind, ref.id, occurrence])
    const digest = createHash('sha256').update(digestInput, 'utf8').digest('hex')
    const id = `asset-ref:${sceneId}:${digest}:${occurrence}`
    nodes.push({
      id, kind: 'asset_ref', label: ref.label || ref.id,
      source: { scope: 'sceneMemory', record: 'profile.assetRefs', sceneId },
      data: { kind: ref.kind, id: ref.id, label: ref.label ?? null },
    })
    edges.push({ id: `edge:${profileNodeId}:${id}`, source: profileNodeId, target: id, kind: 'references_asset' })
  }
  if (scene.profile.primarySkill !== null) {
    const id = `skill-ref:${sceneId}:${encodeURIComponent(scene.profile.primarySkill)}`
    nodes.push({
      id, kind: 'skill_ref', label: scene.profile.primarySkill,
      source: { scope: 'sceneMemory', record: 'profile.primarySkill', sceneId },
      data: { skill: scene.profile.primarySkill },
    })
    edges.push({ id: `edge:${profileNodeId}:${id}`, source: profileNodeId, target: id, kind: 'references_skill' })
  }
  if (scene.handoff !== null) {
    const row = scene.handoff
    const id = `handoff:${sceneId}:${row.revision}`
    nodes.push({
      id, kind: 'handoff', label: row.text,
      source: { scope: 'sceneMemory', record: 'handoff', sceneId, recordId: String(row.revision), sourceSessionId: row.sourceSessionId },
      data: { revision: row.revision, text: row.text, updatedAt: row.updatedAt, operationId: row.operationId },
    })
    edges.push({ id: `edge:${sceneNodeId}:${id}`, source: sceneNodeId, target: id, kind: 'current_handoff' })
  }
  for (const [kind, rows] of [['progress', scene.progress], ['decision', scene.decisions]]) {
    for (const row of rows) {
      const nodeKind = kind === 'decision' ? 'decision' : 'progress'
      const id = `${nodeKind}:${sceneId}:${encodeURIComponent(row.entryId)}`
      nodes.push({
        id, kind: nodeKind, label: row.text,
        source: { scope: 'sceneMemory', record: kind, sceneId, recordId: row.entryId, sourceSessionId: row.sourceSessionId },
        data: { entryId: row.entryId, text: row.text, createdAt: row.createdAt },
      })
      edges.push({ id: `edge:${sceneNodeId}:${id}`, source: sceneNodeId, target: id,
        kind: kind === 'progress' ? 'records_progress' : 'records_decision' })
    }
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id))
  edges.sort((a, b) => a.id.localeCompare(b.id))
  return { sceneNodeId, nodes, edges }
}

function searchText(node) {
  return [node.id, node.kind, node.label, ...Object.values(node.source), ...Object.values(node.data)]
    .filter(value => typeof value === 'string')
    .join('\n')
    .toLocaleLowerCase('en-US')
}

function contextForPage(graph, pageNodes) {
  const selected = new Set(pageNodes.map(node => node.id))
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  const contextIds = new Set()
  const pending = [...selected]
  while (pending.length) {
    const child = pending.pop()
    for (const edge of graph.edges) {
      if (edge.target !== child || selected.has(edge.source) || contextIds.has(edge.source)) continue
      contextIds.add(edge.source)
      pending.push(edge.source)
    }
  }
  for (const id of selected) contextIds.delete(id)
  const visible = new Set([...selected, ...contextIds])
  const contextNodes = [...contextIds].map(id => nodeById.get(id)).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id))
  const edges = graph.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target))
  return { contextNodes, edges }
}

export function projectSceneMemoryGraph({ sessionId, sceneId, bindingRevision, scene, query = {} }) {
  const normalized = normalizeQuery(query)
  if (normalized.cursor) {
    const cursor = normalized.cursor
    if (cursor.sessionId !== sessionId || cursor.sceneId !== sceneId
      || cursor.bindingRevision !== bindingRevision || cursor.profileRevision !== scene.profile.revision
      || cursor.handoffRevision !== scene.handoffRevision
      || cursor.progressTotal > scene.progress.length || cursor.decisionTotal > scene.decisions.length) {
      throw graphError('scene_graph_snapshot_changed')
    }
  }
  // Journals are append-only. A continuation reads the original prefix, so
  // later appends do not shift offsets or leak new rows into an old snapshot.
  const snapshotProgressTotal = normalized.cursor?.progressTotal ?? scene.progress.length
  const snapshotDecisionTotal = normalized.cursor?.decisionTotal ?? scene.decisions.length
  const snapshotScene = normalized.cursor
    ? { ...scene, progress: scene.progress.slice(0, snapshotProgressTotal), decisions: scene.decisions.slice(0, snapshotDecisionTotal) }
    : scene
  const snapshotGraph = sceneGraphNodes(sceneId, snapshotScene, sessionId)
  const needle = normalized.text.toLocaleLowerCase('en-US')
  const matching = snapshotGraph.nodes.filter(node => (!normalized.kinds || normalized.kinds.includes(node.kind))
    && (!needle || searchText(node).includes(needle)))
  if (normalized.cursor && normalized.offset >= matching.length) throw graphError('scene_graph_cursor_invalid')
  const pageNodes = matching.slice(normalized.offset, normalized.offset + normalized.pageSize)
  const hasMore = normalized.offset + pageNodes.length < matching.length
  const nextCursor = hasMore ? Buffer.from(JSON.stringify({
    version: 1,
    sessionId,
    sceneId,
    bindingRevision,
    profileRevision: scene.profile.revision,
    handoffRevision: scene.handoffRevision,
    progressTotal: snapshotProgressTotal,
    decisionTotal: snapshotDecisionTotal,
    text: normalized.text,
    kinds: normalized.kinds,
    pageSize: normalized.pageSize,
    offset: normalized.offset + pageNodes.length,
  })).toString('base64url') : null
  const related = contextForPage(snapshotGraph, pageNodes)
  return {
    scope: GRAPH_SCOPE,
    status: matching.length === 0 ? 'empty' : 'available',
    target: { sessionId, sceneId, bindingRevision },
    nodes: pageNodes,
    contextNodes: related.contextNodes,
    edges: related.edges,
    pagination: { pageSize: normalized.pageSize, offset: normalized.offset, totalMatches: matching.length,
      hasMore, nextCursor },
  }
}

export function resolveSceneGraphTarget({ sessionId, sceneId, roleId, bindingRevision, scene, nodeId, expectedTarget }) {
  if (typeof nodeId !== 'string' || !nodeId || nodeId.length > 2048
    || !exactKeys(expectedTarget, ['sessionId', 'sceneId', 'bindingRevision'])
    || typeof expectedTarget.sessionId !== 'string' || typeof expectedTarget.sceneId !== 'string'
    || !validBindingRevision(expectedTarget.bindingRevision)) {
    throw graphError('invalid_arguments')
  }
  const target = { sessionId, sceneId, bindingRevision }
  if (expectedTarget.sessionId !== sessionId || expectedTarget.sceneId !== sceneId
    || expectedTarget.bindingRevision !== bindingRevision) throw graphError('scene_graph_target_changed')
  const node = sceneGraphNodes(sceneId, scene, sessionId).nodes.find(item => item.id === nodeId)
  if (!node) throw graphError('scene_graph_node_not_found')
  // A stored reference is not permission to navigate an arbitrary session,
  // scene, path or URL. Only the current Host-verified role binding can use
  // the existing native owner-checked openSession consumer. Other records
  // have an explicit detail consumer or a visible unsupported result.
  const currentReference = node.kind === 'asset_ref' && (
    node.data.kind === 'session' && node.data.id === sessionId
    || node.data.kind === 'scene' && node.data.id === sceneId
    || node.data.kind === 'role' && typeof roleId === 'string' && node.data.id === roleId)
  const navigation = ['scene', 'profile', 'session_binding'].includes(node.kind) || currentReference
    ? { kind: 'bound-role', sessionId, sceneId, roleId: roleId ?? null, bindingRevision }
    : (node.kind === 'skill_ref' || node.kind === 'asset_ref' && node.data.kind === 'skill')
      && typeof roleId === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(node.kind === 'skill_ref' ? node.data.skill : node.data.id)
      ? { kind: 'skill', name: node.kind === 'skill_ref' ? node.data.skill : node.data.id, roleId, sessionId }
    : ['handoff', 'progress', 'decision'].includes(node.kind)
      ? { kind: 'record', record: { id: node.id, kind: node.kind, data: node.data, source: node.source } }
      : { kind: 'unsupported', reason: 'reference_target_not_authorized' }
  return {
    status: 'resolved',
    selected: { id: node.id, kind: node.kind, label: node.label, source: node.source },
    target,
    referenceSessionId: node.source.sourceSessionId ?? null,
    navigation,
  }
}

export const SCENE_GRAPH_NODE_KINDS = Object.freeze([...NODE_KINDS])
