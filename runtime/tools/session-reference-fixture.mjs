import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function load(prefix) {
  const require = createRequire(resolve(prefix, 'package.json'));
  const get = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
  return {
    ...(await get('cordis')), ...(await get('dsh-session')),
    ...(await get('dsh-session-query')), ...(await get('dsh-session-reference')),
    ...(await get('dsh-llm')),
  };
}

export function fixture(api, texts, maxReferenceBytes = 4096) {
  const ctx = new api.Context();
  new api.SessionStore(ctx);
  const target = ctx.sessions.create('reference-target', { meta: { cwd: '/reference-fixture', createdAt: 1 } });
  const source = ctx.sessions.create('reference-source', { meta: { cwd: '/reference-fixture', createdAt: 2 } });
  for (const text of texts) {
    source.append('user/message', api.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' });
  }
  const query = new api.SessionQueryEngine(ctx);
  const resolver = new api.SessionReferenceResolver(ctx, { maxReferenceBytes });
  // The receiving Agent identity is a fixed boundary. Source Session, corpus
  // readSurface and resolver preparation are the real runtime implementations.
  const agent = { id: target.id, session: target };
  const prepare = () => resolver.prepare(agent, [{ type: 'text', text: 'read this reference' }], [{ sessionId: source.id, label: 'source' }]);
  return { ctx, source, target, query, resolver, agent, prepare };
}

export function preparedData(result) {
  const prompt = result.additionalContext.content[0].text;
  const start = prompt.indexOf('<referenced-sessions>\n') + '<referenced-sessions>\n'.length;
  const end = prompt.indexOf('\n</referenced-sessions>', start);
  return JSON.parse(prompt.slice(start, end));
}

export async function encodedDuring(text, action) {
  const original = TextEncoder.prototype.encode;
  let calls = 0;
  let bytes = 0;
  TextEncoder.prototype.encode = function (...args) {
    const value = Reflect.apply(original, this, args);
    if (args[0] === text) { calls++; bytes += value.byteLength; }
    return value;
  };
  try { return { result: await action(), calls, bytes }; }
  finally { TextEncoder.prototype.encode = original; }
}
