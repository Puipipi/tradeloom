import { projectNativeWorkflowRun } from '../packages/tradeloom-shell/workflow-native-ui.js'
const MAX = 2 * 1024 * 1024 + 4096
let size = 0
const chunks = []
try {
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX) throw Error('limit')
    chunks.push(chunk)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!input || Object.keys(input).sort().join(',') !== 'attempt,fileIndex,nodeId,seq,snapshot') throw Error('input')
  const { snapshot, nodeId, attempt, seq, fileIndex } = input
  if (typeof nodeId !== 'string' || nodeId.length > 128 || !Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(fileIndex) || fileIndex < 0) throw Error('input')
  if (!Number.isSafeInteger(snapshot?.revision) || snapshot.revision < 1 || Buffer.byteLength(JSON.stringify({snapshot,expectedRevision:snapshot.revision-1})) > 2 * 1024 * 1024) throw Error('limit')
  const projected = projectNativeWorkflowRun(snapshot)
  const node = projected.nodes.find(item => item.id === nodeId && item.attempt === attempt)
  if (!node?.settled || node.terminalReceipt?.source !== 'subagent/end' || node.artifactState !== 'declared') throw Error('source')
  const entries = node.artifactEvidence.declarations.filter(item => item.sourceSessionSeq === seq && item.fileIndex === fileIndex)
  if (entries.length !== 1) throw Error('source')
  const source = entries[0], original = snapshot.nodes[nodeId]
  const name = Array.from(source.path.split(/[\\/]/).pop() || 'file').slice(0,255).join('').replace(/[\u0000-\u001f\u007f]/g, '_')
  const result = {ok:true, runId:projected.id, nodeId, attempt, childSessionId:node.childId, nativeRunId:node.nativeRunId,
    requestId:original.requestId, toolCallId:node.toolCallId, parentAgentId:snapshot.parentAgentId, parentSessionId:snapshot.sessionId,
    bindingRevision:snapshot.bindingRevision, definitionRevision:snapshot.definitionRevision, seq, fileIndex, callId:source.presentCallId, turn:source.sourceTurn, name}
  process.stdout.write(JSON.stringify(result))
} catch {
  process.stdout.write('{"ok":false,"code":"source_unverified"}')
}
