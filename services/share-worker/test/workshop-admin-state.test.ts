import { expect, it } from 'vitest';
import { encoder } from '../src/workshop-common';
import { approve, commitState, editState, loadState, resolveReport, STATE_CAP, STATE_KEY, withdrawSubmission, type Report, type State } from '../src/workshop-state';
import { makeEnv } from './fakes';
import { PetBucket } from './pet-market-fakes';
import { metaFor, pet } from './workshop-fixtures';

const now = '2026-11-12T00:00:00.000Z', owner = { accountOrigin: 'https://github.com', accountId: 42, username: 'Synthetic owner' };
function context() { const bucket = new PetBucket(); return { bucket, env: makeEnv({ BUCKET: bucket as unknown as R2Bucket }).env }; }
function published(state: State) {
  const submission = { submissionId: 'a'.repeat(32), owner, metadata: metaFor(pet()), status: 'pending' as const,
    createdAt: now, updatedAt: now, submittedAt: now, validation: { validator: 'synthetic-fixture', files: 2, expandedBytes: 512, sheets: 1 } };
  state.submissions.push(submission); approve(state, submission, now, 'Initial synthetic approval'); return submission;
}
function report(n: number): Report { return { reportId: n.toString(16).padStart(32, '0'), kind: 'pet', id: 'sample', version: '1.0.0', reason: 'Synthetic report', reporter: owner, createdAt: now }; }
function budget(state: State) {
  const live = state.submissions.filter(item => item.status !== 'withdrawn').length, active = state.releases.length - state.withdrawn.length;
  const open = state.reports.filter(item => item.resolution === undefined).length;
  return { bytes: encoder.encode(JSON.stringify(state)).length + live * 24576 + active * 12288 + open * 20480,
    slots: state.audit.length + live + active + open, open, live, active };
}
it('adds report capacity to withdrawal reserves instead of replacing or taking their maximum', async () => {
  const f = context(), previous = await loadState(f.env), state = editState(previous); published(state);
  const base = encoder.encode(JSON.stringify(state)).length, each = encoder.encode(JSON.stringify(report(1))).length + 1;
  // A few hundred small rows (<200KiB JSON), not a maximum-size state or
  // decompression fixture. Pick the boundary by integer arithmetic.
  const count = Math.floor((STATE_CAP - base + 1) / (each + 20480)); expect(count).toBeLessThan(500);
  for (let n = 1; n <= count; n++) state.reports.push(report(n));
  const bytes = encoder.encode(JSON.stringify(state)).length;
  expect(bytes).toBeLessThan(200 * 1024);
  expect(bytes + count * 20480).toBeLessThanOrEqual(STATE_CAP);
  expect(bytes + count * 20480 + 24576 + 12288).toBeGreaterThan(STATE_CAP);
  await expect(commitState(f.env, previous, state, now)).rejects.toMatchObject({ code: 'capacity', status: 503 });
  expect(f.bucket.objects.has(STATE_KEY)).toBe(false);
});
it('resolving one report spends its own byte and audit reservation while preserving all withdrawals', async () => {
  const f = context(); let previous = await loadState(f.env), state = editState(previous); published(state); state.reports.push(report(1), report(2));
  await commitState(f.env, previous, state, now);
  previous = await loadState(f.env); state = editState(previous); const before = budget(state), originalBytes = encoder.encode(JSON.stringify(state)).length;
  const reason = '😀'.repeat(2000); resolveReport(state, state.reports[0]!, now, 'handled', reason);
  await commitState(f.env, previous, state, now);
  state = (await loadState(f.env)).state; const after = budget(state);
  expect(after.open).toBe(before.open - 1); expect(after.slots).toBe(before.slots); expect(after.live).toBe(before.live); expect(after.active).toBe(before.active);
  expect(encoder.encode(JSON.stringify(state)).length - originalBytes).toBeLessThan(20480); expect(after.bytes).toBeLessThan(before.bytes);
  expect(state.reports[0]!.resolution).toMatchObject({ actor: 'admin', decision: 'handled', reason });
  expect(state.audit.filter(event => event.action === 'resolve_report')).toHaveLength(1);
  previous = await loadState(f.env); state = editState(previous); const beforeWithdrawal = budget(state);
  withdrawSubmission(state, state.submissions[0]!, now, 'Independent withdrawal', 'admin'); await commitState(f.env, previous, state, now);
  const withdrawn = (await loadState(f.env)).state; expect(withdrawn.current).toEqual([]); expect(withdrawn.withdrawn).toHaveLength(1);
  expect(budget(withdrawn).open).toBe(1); expect(budget(withdrawn).bytes).toBeLessThan(beforeWithdrawal.bytes);
});
it('does not append a second event for the same report outcome and rejects a changed outcome', async () => {
  const f = context(), previous = await loadState(f.env), state = editState(previous); published(state); const item = report(1); state.reports.push(item);
  resolveReport(state, item, now, 'dismissed', 'First reason'); const saved = JSON.stringify(state);
  resolveReport(state, item, now, 'dismissed', 'A retry cannot replace the first reason'); expect(JSON.stringify(state)).toBe(saved);
  expect(() => resolveReport(state, item, now, 'handled', 'Different decision')).toThrow('report_state'); expect(JSON.stringify(state)).toBe(saved);
  await commitState(f.env, previous, state, now); expect((await loadState(f.env)).state.reports[0]!.resolution?.reason).toBe('First reason');
});
it('reads the previous open-report shape but rejects malformed persisted resolution fields', async () => {
  const f = context(), previous = await loadState(f.env), state = editState(previous); published(state); state.reports.push(report(1));
  await commitState(f.env, previous, state, now); expect((await loadState(f.env)).state.reports[0]!.resolution).toBeUndefined();
  const invalid = JSON.parse(JSON.stringify(state)); invalid.reports[0].resolution = { at: now, decision: 'handled', reason: 'Resolution', actor: 'a named key holder was not authenticated' };
  await f.bucket.put(STATE_KEY, encoder.encode(JSON.stringify(invalid)), {});
  await expect(loadState(f.env)).rejects.toMatchObject({ code: 'state_invalid', status: 503 });
});
