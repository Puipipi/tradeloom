import { createHash } from 'node:crypto';

export const SIGNAL_EVENT_BYTES = 1024;
export const SIGNAL_META = 'dsh-go/companion-result';
const keys = (value, expected) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const id = (value) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256
  && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
const nullableInteger = (value, min, max) => value === null || integer(value, min, max);

// This validates the private producer's metadata. It does not grant authority to
// arbitrary Session/tool metadata; the caller must use the committed publisher.
export function projectRunResult(record, generation) {
  if (typeof generation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generation)) return null;
  if (!keys(record, ['source', 'metadata'])) return null;
  const { source, metadata } = record;
  if (!keys(source, ['sessionId', 'turn', 'step', 'callId', 'seq'])
    || !id(source.sessionId) || !id(source.callId) || !integer(source.turn, 1)
    || !integer(source.step, 1) || !integer(source.seq, 0)) return null;
  if (!keys(metadata, ['v', 'runId', 'runKind', 'result', 'exitCode', 'durationMs', 'passed', 'failed', 'skipped'])
    || metadata.v !== 1 || metadata.runId !== source.callId
    || !['build', 'test', 'command'].includes(metadata.runKind)
    || !['succeeded', 'failed', 'cancelled', 'not_run', 'unknown'].includes(metadata.result)
    || !nullableInteger(metadata.exitCode, -2147483648, 2147483647)
    || !nullableInteger(metadata.durationMs, 0, 604800000)
    || metadata.passed !== null || metadata.failed !== null || metadata.skipped !== null) return null;
  if (metadata.runKind === 'command' && ['succeeded', 'failed'].includes(metadata.result)) return null;
  if (metadata.result === 'succeeded' && metadata.exitCode !== 0
    || metadata.result === 'failed' && (metadata.exitCode === null || metadata.exitCode === 0)) return null;
  const eventId = createHash('sha256').update(JSON.stringify([source.sessionId, source.callId, source.seq])).digest('base64url');
  const { v: ignored, ...payload } = metadata;
  const event = Object.freeze({ v: 1, id: eventId, generation,
    source: Object.freeze({ ...source }), payload: Object.freeze(payload) });
  return Buffer.byteLength(JSON.stringify(event), 'utf8') <= SIGNAL_EVENT_BYTES ? event : null;
}
