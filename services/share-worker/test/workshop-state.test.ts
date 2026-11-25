import { afterEach, expect, it, vi } from 'vitest';
import { AUDIT_RETENTION_MS, audit, commitState, editState, loadState, STATE_KEY } from '../src/workshop-state';
import { makeEnv } from './fakes';
import { PetBucket } from './pet-market-fakes';
import { metaFor, pet } from './workshop-fixtures';
afterEach(() => vi.useRealTimers());
const owner = { accountOrigin: 'https://github.com', accountId: 42, username: 'Synthetic owner' };
function context() { const bucket = new PetBucket(); return { bucket, env: makeEnv({ BUCKET: bucket as unknown as R2Bucket }).env }; }
it('reserves withdrawal capacity before admitting drafts instead of filling all authority bytes', async () => {
  const f = context(), previous = await loadState(f.env), state = editState(previous), now = '2026-11-11T00:00:00.000Z', metadata = metaFor(pet());
  for (let n = 0; n < 500; n++) state.submissions.push({ submissionId: n.toString(16).padStart(32, '0'), owner, metadata, status: 'draft', createdAt: now, updatedAt: now });
  // Their JSON fits below8MiB; their admitted future withdrawal/audit budget
  // does not. Refusing here preserves the ability to moderate existing work.
  await expect(commitState(f.env, previous, state, now)).rejects.toMatchObject({ code: 'capacity', status: 503 });
  expect(f.bucket.objects.has(STATE_KEY)).toBe(false);
});
it('retains every audit event for186days and prunes only older events on a later CAS', async () => {
  const f = context(), start = Date.parse('2026-11-11T00:00:00.000Z'), metadata = metaFor(pet());
  let previous = await loadState(f.env), state = editState(previous);
  const sid = 'a'.repeat(32), at = new Date(start).toISOString();
  state.submissions.push({ submissionId: sid, owner, metadata, status: 'draft', createdAt: at, updatedAt: at });
  audit(state, at, { action: 'create', actor: owner, submissionId: sid }); await commitState(f.env, previous, state, at);
  previous = await loadState(f.env); state = editState(previous);
  await commitState(f.env, previous, state, new Date(start + AUDIT_RETENTION_MS).toISOString());
  expect((await loadState(f.env)).state.audit).toHaveLength(1);
  previous = await loadState(f.env); state = editState(previous);
  await commitState(f.env, previous, state, new Date(start + AUDIT_RETENTION_MS + 1).toISOString());
  const current = (await loadState(f.env)).state; expect(current.audit).toEqual([]); expect(current.submissions).toHaveLength(1);
});
