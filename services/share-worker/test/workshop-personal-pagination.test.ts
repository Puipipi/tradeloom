import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workshop } from '../src/workshop';
import { commitState, editState, loadState, type Owner, type State, type Submission } from '../src/workshop-state';
import { makeCtx, makeEnv } from './fakes';
import { PetBucket } from './pet-market-fakes';
import { metaFor, pet } from './workshop-fixtures';

const API = '/api/workshop/v1';
const OWNER: Owner = { accountOrigin: 'https://github.com', accountId: 42, username: 'Synthetic pagination owner' };
const START = Date.parse('2020-01-01T00:00:00.000Z'), COMMITTED = '2020-01-02T00:00:00.000Z';
const sid = (value: number) => value.toString(16).padStart(32, '0');
const bytes = pet(), metadata = metaFor(bytes);
type Page = { submissions: Submission[]; nextCursor: string | null };
const ids = (page: Page) => page.submissions.map(item => item.submissionId);

beforeEach(() => vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
  new Response(JSON.stringify({ id: OWNER.accountId, login: OWNER.username }))));
afterEach(() => vi.restoreAllMocks());

function row(value: number, millis: number, status: 'draft' | 'pending' = 'draft', owner = OWNER): Submission {
  const at = new Date(START + millis).toISOString();
  return { submissionId: sid(value), owner, metadata, status, createdAt: at, updatedAt: at,
    ...(status === 'pending' ? { submittedAt: at,
      validation: { validator: 'Synthetic pagination fixture', files: 2, expandedBytes: 512, sheets: 1 } } : {}) };
}
async function setup(initial: Submission[]) {
  const bucket = new PetBucket(), { env } = makeEnv({ BUCKET: bucket as unknown as R2Bucket });
  // Small legal rows pass the production state validator and CAS envelope.
  // Their chosen IDs deliberately decouple ID order from creation-time order.
  const change = async (update: (state: State) => void) => {
    const previous = await loadState(env), state = editState(previous); update(state);
    await commitState(env, previous, state, COMMITTED);
  };
  await change(state => state.submissions.push(...initial));
  const call = (path: string, method = 'GET', body?: object | Uint8Array, admin = false) =>
    workshop(new Request('https://example.org' + API + path, {
      method, headers: { Authorization: 'Bearer synthetic_pagination_token', 'X-Workshop-Account-Origin': OWNER.accountOrigin,
        ...(admin ? { 'X-Admin-Key': env.ADMIN_KEY! } : {}),
        ...(body ? { 'Content-Type': body instanceof Uint8Array ? 'application/zip' : 'application/json' } : {}) },
      ...(body ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
    }), env, makeCtx().ctx);
  const list = async (query = '', admin = false): Promise<Page> => {
    const response = await call(`${admin ? '/admin' : ''}/submissions${query ? '?' + query : ''}`, 'GET', undefined, admin);
    expect(response.status).toBe(200); return await response.json() as Page;
  };
  const withdraw = async (id: string) => {
    const response = await call(`/submissions/${id}/withdraw`, 'POST', { reason: 'Synthetic author withdrawal' });
    expect(response.status).toBe(200);
    return (await response.json() as { submission: Submission }).submission;
  };
  return { env, call, list, change, withdraw };
}

it('orders all author pages by creation time even when ID and insertion order disagree', async () => {
  const f = await setup([row(1, 0), row(15, 20), row(10, 10)]);
  const first = await f.list('limit=1');
  expect(ids(first)).toEqual([sid(15)]); expect(first.nextCursor).toBe(sid(15));
  const second = await f.list(`limit=1&cursor=${first.nextCursor}`);
  expect(ids(second)).toEqual([sid(10)]); expect(second.nextCursor).toBe(sid(10));
  const third = await f.list(`limit=1&cursor=${second.nextCursor}`);
  expect(ids(third)).toEqual([sid(1)]); expect(third.nextCursor).toBeNull();
  expect([...first.submissions, ...second.submissions, ...third.submissions].map(item => item.createdAt))
    .toEqual([row(15, 20).createdAt, row(10, 10).createdAt, row(1, 0).createdAt]);
});

it('uses ascending binary IDs to cross a same-millisecond group without duplicates or gaps', async () => {
  const f = await setup([row(14, 5), row(1, 5), row(11, 5), row(5, 5), row(9, 5)]);
  const first = await f.list('limit=2');
  expect(ids(first)).toEqual([sid(1), sid(5)]); expect(first.nextCursor).toBe(sid(5));
  const second = await f.list(`limit=2&cursor=${first.nextCursor}`);
  expect(ids(second)).toEqual([sid(9), sid(11)]); expect(second.nextCursor).toBe(sid(11));
  const third = await f.list(`limit=2&cursor=${second.nextCursor}`);
  expect(ids(third)).toEqual([sid(14)]); expect(third.nextCursor).toBeNull();
});

it('does not shift a loaded prefix when a newer record is inserted between pages', async () => {
  const f = await setup([row(4, 0), row(8, 10), row(2, 20)]);
  const first = await f.list('limit=1');
  expect(ids(first)).toEqual([sid(2)]); expect(first.nextCursor).toBe(sid(2));
  await f.change(state => state.submissions.push(row(1, 30)));
  const rest = await f.list(`limit=2&cursor=${first.nextCursor}`);
  expect(ids(rest)).toEqual([sid(8), sid(4)]); expect(rest.nextCursor).toBeNull();
  expect(ids(await f.list('limit=1'))).toEqual([sid(1)]);
});

it('places same-millisecond insertions on the correct side of an existing anchor', async () => {
  const f = await setup([row(9, 0), row(3, 0), row(7, 0)]);
  const first = await f.list('limit=2');
  expect(ids(first)).toEqual([sid(3), sid(7)]); expect(first.nextCursor).toBe(sid(7));
  await f.change(state => state.submissions.push(row(5, 0), row(8, 0)));
  const rest = await f.list(`limit=2&cursor=${first.nextCursor}`);
  expect(ids(rest)).toEqual([sid(8), sid(9)]); expect(rest.nextCursor).toBeNull();
  expect(ids(await f.list())).toEqual([sid(3), sid(5), sid(7), sid(8), sid(9)]);
});

it('resolves an anchor from all owned rows after it leaves the selected status', async () => {
  const f = await setup([row(1, 0, 'pending'), row(3, 20, 'pending'), row(2, 10, 'pending')]);
  const first = await f.list('status=pending&limit=2');
  expect(ids(first)).toEqual([sid(3), sid(2)]); expect(first.nextCursor).toBe(sid(2));
  const withdrawn = await f.withdraw(sid(2));
  expect(withdrawn.status).toBe('withdrawn'); expect(withdrawn.createdAt).toBe(row(2, 10).createdAt);
  const rest = await f.list(`status=pending&limit=2&cursor=${first.nextCursor}`);
  expect(ids(rest)).toEqual([sid(1)]); expect(rest.nextCursor).toBeNull();
  expect((await loadState(f.env)).state.submissions).toHaveLength(3);
});

it('does not promote an older submission when a real withdrawal updates it', async () => {
  const f = await setup([row(1, 0), row(2, 10), row(3, 20)]);
  const withdrawn = await f.withdraw(sid(1));
  expect(withdrawn.createdAt).toBe(row(1, 0).createdAt);
  expect(withdrawn.updatedAt > row(3, 20).createdAt).toBe(true);
  const page = await f.list();
  expect(ids(page)).toEqual([sid(3), sid(2), sid(1)]);
  expect(page.submissions[2]!.status).toBe('withdrawn');
});

it('keeps live status membership on its own side of the creation-time cursor', async () => {
  const f = await setup([row(1, 0, 'pending'), row(2, 10), row(4, 20, 'pending'), row(6, 30)]);
  const first = await f.list('status=pending&limit=1');
  expect(ids(first)).toEqual([sid(4)]); expect(first.nextCursor).toBe(sid(4));
  for (const id of [sid(6), sid(2)]) {
    const response = await f.call(`/submissions/${id}/archive`, 'PUT', bytes);
    expect(response.status).toBe(200);
    expect((await response.json() as { submission: Submission }).submission.status).toBe('pending');
  }
  expect(ids(await f.list(`status=pending&cursor=${first.nextCursor}`))).toEqual([sid(2), sid(1)]);
  expect(ids(await f.list('status=pending'))).toEqual([sid(6), sid(4), sid(2), sid(1)]);
  await f.withdraw(sid(1));
  const rest = await f.list(`status=pending&cursor=${first.nextCursor}`);
  expect(ids(rest)).toEqual([sid(2)]); expect(rest.nextCursor).toBeNull();
});

it('rejects missing and other-owner anchors identically while retaining query format limits', async () => {
  const f = await setup([row(1, 0), row(2, 10, 'draft', { ...OWNER, accountId: 43 })]);
  for (const query of [`cursor=${sid(2)}`, `cursor=${sid(99)}`, 'cursor=invalid', 'limit=0', 'limit=101', 'status=other']) {
    const response = await f.call('/submissions?' + query);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'workshop_bad_query' });
  }
  expect(ids(await f.list())).toEqual([sid(1)]);
  const end = await f.list(`cursor=${sid(1)}`);
  expect(end).toEqual({ submissions: [], nextCursor: null });
});

it('leaves the shared administrator ID pagination unchanged', async () => {
  const f = await setup([row(1, 0), row(15, 20), row(10, 10)]);
  const first = await f.list('limit=1', true);
  expect(ids(first)).toEqual([sid(1)]); expect(first.nextCursor).toBe(sid(1));
  const second = await f.list(`limit=2&cursor=${first.nextCursor}`, true);
  expect(ids(second)).toEqual([sid(10), sid(15)]); expect(second.nextCursor).toBeNull();
  expect(ids(await f.list())).toEqual([sid(15), sid(10), sid(1)]);
});
