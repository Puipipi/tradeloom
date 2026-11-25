import { CompanionError, fields, integer, uuid } from './schema.js';
import { RECALL_SELECTOR } from './recall-selector.js';

export const recallError = (status, code, message) => new CompanionError(status, `recall-${code}`, message);
export const recallInvalid = () => recallError(400, 'invalid-request', 'Invalid companion recall request');
export const canonicalUuid = (value) => uuid(value) && value === value.toLowerCase();
export const validRecallSessionId = (value) => typeof value === 'string' && value.length > 0
  && [...value].length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  && [...value].every((part) => { const cp = part.codePointAt(0); return cp < 0xd800 || cp > 0xdfff; });

export function validateBind(input) {
  if (!fields(input, ['v', 'operationId', 'storeId', 'expectedMemoryRevision', 'sessionId', 'consumerId', 'consent'])
    || input.v !== 1 || !canonicalUuid(input.operationId) || !canonicalUuid(input.storeId)
    || !integer(input.expectedMemoryRevision) || !validRecallSessionId(input.sessionId)
    || !canonicalUuid(input.consumerId) || input.consent !== RECALL_SELECTOR) throw recallInvalid();
  return { v: 1, operationId: input.operationId, storeId: input.storeId,
    expectedMemoryRevision: input.expectedMemoryRevision, sessionId: input.sessionId,
    consumerId: input.consumerId, consent: input.consent };
}

export function validateRevoke(input) {
  if (!fields(input, ['v', 'operationId', 'bindingId', 'reason']) || input.v !== 1
    || !canonicalUuid(input.operationId) || !canonicalUuid(input.bindingId) || input.reason !== 'user-off') throw recallInvalid();
  return { v: 1, operationId: input.operationId, bindingId: input.bindingId, reason: 'user-off' };
}
