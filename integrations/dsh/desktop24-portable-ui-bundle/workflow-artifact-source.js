// Bounded source coordinates for declared current files; never immutable bytes.
export const ARTIFACT_EVIDENCE_SCHEMA = 'tradeloom.presented-evidence/v1'
export const MAX_DECLARATIONS = 64
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, required, optional = []) => record(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const text = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const seq = value => Number.isSafeInteger(value) && value >= 0

export function validateArtifactRangeStart(value) {
  return exact(value, ['childSessionId', 'nativeRunId', 'startInclusive'])
    && text(value.childSessionId) && text(value.nativeRunId) && seq(value.startInclusive)
    ? { childSessionId: value.childSessionId, nativeRunId: value.nativeRunId, startInclusive: value.startInclusive } : null
}

export function validateArtifactEvidence(value, expected) {
  if (!validateArtifactRangeStart(expected) || !exact(value, ['schema', 'range', 'declarations'])
    || value.schema !== ARTIFACT_EVIDENCE_SCHEMA
    || !exact(value.range, ['childSessionId', 'nativeRunId', 'startInclusive', 'endExclusive'])
    || !seq(value.range.endExclusive) || value.range.endExclusive < expected.startInclusive
    || ['childSessionId', 'nativeRunId', 'startInclusive'].some(key => value.range[key] !== expected[key])
    || !Array.isArray(value.declarations) || value.declarations.length > MAX_DECLARATIONS) return null
  const coordinates = new Set()
  for (const item of value.declarations) {
    if (!exact(item, ['sourceSessionSeq', 'fileIndex', 'presentCallId', 'sourceTurn', 'path'], ['description'])
      || !seq(item.sourceSessionSeq) || item.sourceSessionSeq < expected.startInclusive || item.sourceSessionSeq >= value.range.endExclusive
      || !seq(item.fileIndex) || item.fileIndex >= MAX_DECLARATIONS || !text(item.presentCallId)
      || !Number.isSafeInteger(item.sourceTurn) || item.sourceTurn < 1 || !text(item.path, 4096)
      || (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 2000))) return null
    const key = `${item.sourceSessionSeq}:${item.fileIndex}`
    if (coordinates.has(key)) return null
    coordinates.add(key)
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 128 * 1024) return null
  return structuredClone(value)
}
