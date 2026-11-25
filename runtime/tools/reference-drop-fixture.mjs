import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function load(prefix) {
  const require = createRequire(resolve(prefix, 'package.json'));
  const get = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
  return {
    ...(await get('cordis')), ...(await get('dsh-session')),
    ...(await get('dsh-session-query')), ...(await get('dsh-session-reference')),
    ...(await get('dsh-llm')), ...(await get('dsh-compaction')), ...(await get('dsh-spill-local')),
  };
}

export function fixture(api, texts, maxReferenceBytes = 4096) {
  const ctx = new api.Context();
  new api.SessionStore(ctx);
  const target = ctx.sessions.create('reference-target', { meta: { cwd: '/reference-fixture', createdAt: 1 } });
  const source = ctx.sessions.create('reference-source', { meta: { cwd: '/reference-fixture', createdAt: 2 } });
  for (const value of texts) {
    const text = typeof value === 'string' ? value : value.text;
    const sourceKind = typeof value === 'string' || !value.checkpoint ? { kind: 'user' } : api.compactCheckpointSource('fixture-compaction');
    source.append('user/message', api.createUserMessage({ source: sourceKind, content: [{ type: 'text', text }] }), { surfaceOp: 'append' });
  }
  const query = new api.SessionQueryEngine(ctx);
  const resolver = new api.SessionReferenceResolver(ctx, maxReferenceBytes === null ? {} : { maxReferenceBytes });
  // The receiving Agent identity is a fixed boundary. Source Session, corpus
  // readSurface and resolver preparation are the real runtime implementations.
  const agent = { id: target.id, session: target, options: {} };
  const prepare = () => resolver.prepare(agent, [{ type: 'text', text: 'read this reference' }], [{ sessionId: source.id, label: 'source' }]);
  return { ctx, source, target, query, resolver, agent, prepare };
}

export function preparedData(result) {
  const prompt = result.additionalContext.content[0].text;
  const start = prompt.indexOf('<referenced-sessions>\n') + '<referenced-sessions>\n'.length;
  const end = prompt.indexOf('\n</referenced-sessions>', start);
  return JSON.parse(prompt.slice(start, end));
}

export async function serializedDuring(action) {
  const original = JSON.stringify;
  const counts = { fullCalls: 0, fullBytes: 0, itemCalls: 0, itemBytes: 0 };
  JSON.stringify = function (value, ...args) {
    const result = Reflect.apply(original, this, [value, ...args]);
    if (value?.sessionId === 'reference-source' && Array.isArray(value.conversation)) {
      counts.fullCalls++;
      counts.fullBytes += Buffer.byteLength(result, 'utf8');
    } else if (value?.role === 'user' && typeof value.text === 'string' && Object.keys(value).length === 2) {
      counts.itemCalls++;
      counts.itemBytes += Buffer.byteLength(result, 'utf8');
    }
    return result;
  };
  try { return { result: await action(), counts }; }
  finally { JSON.stringify = original; }
}
