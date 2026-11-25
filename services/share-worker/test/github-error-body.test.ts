import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { makeCtx, makeEnv } from './fakes';

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function upstream(status: number) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    if (status === 200) {
      response.end(JSON.stringify({ stargazers_count: 42 }));
    } else {
      // A fresh Fetch response whose error body has not finished arriving.
      response.write('{"message":"synthetic error');
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback address');
  const fetch = globalThis.fetch.bind(globalThis);
  let cancellations = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toMatch(/^https:\/\/api\.github\.com\/repos\//);
    const response = await fetch(`http://127.0.0.1:${address.port}/`, init);
    if (response.body) {
      const cancel = response.body.cancel.bind(response.body);
      vi.spyOn(response.body, 'cancel').mockImplementation(reason => {
        cancellations++;
        return cancel(reason);
      });
    }
    return response;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { cancellations: () => cancellations };
}

it.each([404, 429, 503])('cancels the unused fresh Fetch body after upstream HTTP %i', async status => {
  const source = await upstream(status);
  const { env } = makeEnv();
  const { ctx } = makeCtx();
  const response = await worker.fetch(new Request('https://go.dshtui.com/api/github/stars'), env, ctx);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'unavailable' });
  expect(response.headers.get('retry-after')).toBe('60');
  expect(source.cancellations()).toBe(1);
});

it('still consumes a successful fresh Fetch response without canceling it', async () => {
  const source = await upstream(200);
  const { env } = makeEnv();
  const { ctx } = makeCtx();
  const response = await worker.fetch(new Request('https://go.dshtui.com/api/github/stars'), env, ctx);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ stars: 42 });
  expect(source.cancellations()).toBe(0);
});
