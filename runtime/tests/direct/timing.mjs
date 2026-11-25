// Test-only §1 startup probe; the same physical --import path works in both modes.
import http from 'node:http';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';

if (isMainThread && process.argv.some((value) => value.endsWith('/@deepseek-ai/dsh/lib/bin.js')) && process.argv.includes('web')) {
  const emit = (event, extra = {}) => fs.writeSync(2, `[direct-host-timing] ${JSON.stringify({ event,
    atMs: performance.now(), timeOrigin: performance.timeOrigin, pid: process.pid, ...extra })}\n`);
  emit('preload', { execPathBeforeDirectPreload: process.execPath });
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    this.once('listening', () => emit('listen', { address: this.address(), cpuUsage: process.cpuUsage(), maxRssKiB: process.resourceUsage().maxRSS }));
    const seen = new Set();
    this.on('request', (req, res) => {
      const route = (req.url || '').split('?', 1)[0];
      if (!['/', '/api/session/modelCatalog', '/api/session/list', '/direct-host-probe/files'].includes(route) || seen.has(route)) return;
      seen.add(route);
      const start = performance.now();
      emit('request', { method: req.method, route });
      res.once('finish', () => emit('response', { method: req.method, route, status: res.statusCode, durationMs: performance.now() - start }));
    });
    return Reflect.apply(listen, this, args);
  };
  const write = process.stdout.write;
  let token = false;
  process.stdout.write = function (chunk, ...args) {
    if (!token && String(chunk).includes('dsh web: http')) { token = true; emit('token'); }
    return Reflect.apply(write, this, [chunk, ...args]);
  };
}
