import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function load(prefix) {
  const require = createRequire(resolve(prefix, 'package.json'));
  const get = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
  return { ...(await get('cordis')), ...(await get('dsh-session')), ...(await get('dsh-session-query')) };
}
export function createCorpus(api, count) {
  const ctx = new api.Context();
  new api.SessionStore(ctx);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = 'fixture-session-' + String(i).padStart(6, '0');
    ids.push(id);
    ctx.sessions.create(id, { meta: { cwd: i % 5 === 0 ? '/other-workspace' : '/workspace', createdAt: 1000 + i } });
  }
  const query = new api.SessionQueryEngine(ctx);
  return { ctx, query, ids };
}
export function filtersFor(ids, count) {
  const values = Array.from({ length: count }, (_, i) => ids.length
    ? ids[Math.floor(i * ids.length / count)] : 'fixture-session-' + String(i).padStart(6, '0'));
  return [{ kind: 'id', values }, { kind: 'cwd', values: ['/workspace'] }];
}
export function countIncludes(action) {
  const original = Array.prototype.includes;
  let calls = 0;
  Array.prototype.includes = function (...args) {
    if (this.length > 1 && typeof this[0] === 'string' && this[0].startsWith('fixture-session-')) calls++;
    return Reflect.apply(original, this, args);
  };
  return Promise.resolve().then(action).then(value => ({ value, calls })).finally(() => { Array.prototype.includes = original; });
}
