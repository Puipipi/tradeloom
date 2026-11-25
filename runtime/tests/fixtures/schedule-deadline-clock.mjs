// Test-only controllable deadline. Does not replace scheduling, authorization or persistence.
export const name = 'schedule-deadline-clock';
export const inject = ['webServer', 'connection'];
export function apply(ctx) {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let armed = false, captured, count = 0, unexpected = 0, fired = false, cleared = false;
  const handle = Object.freeze({ fixture: 'schedule-deadline' });
  function wrappedSet(callback, delay, ...args) {
    if (armed && delay === 120000) {
      const stack = new Error().stack ?? '';
      if (/at Proxy\.dshGoAuthorize/.test(stack) && /dsh-schedule\/lib\/index\.js/.test(stack)) {
        count++;
        if (count !== 1) throw Error('More than one schedule deadline captured');
        captured = () => callback(...args);
        return handle;
      }
      unexpected++;
    }
    return originalSet(callback, delay, ...args);
  }
  function wrappedClear(timer) {
    if (timer === handle) { cleared = true; return; }
    return originalClear(timer);
  }
  const state = () => ({ armed, count, unexpected, fired, cleared });
  ctx.effect(() => {
    const unregister = ctx.webServer.register({ kind: 'exact', path: '/schedule-deadline-clock', handler: async (req, res) => {
      const rejected = ctx.connection.requestRejection(req);
      if (rejected !== undefined) { res.writeHead(rejected); res.end(); return; }
      try {
        if (req.method !== 'POST') throw Error('POST required');
        let body = ''; for await (const chunk of req) body += chunk;
        const { action } = JSON.parse(body);
        if (action === 'arm') {
          if (armed || count) throw Error('Clock already armed');
          armed = true; globalThis.setTimeout = wrappedSet; globalThis.clearTimeout = wrappedClear;
        } else if (action === 'fire') {
          if (!armed || count !== 1 || unexpected || fired || cleared) throw Error('Deadline is not uniquely pending');
          armed = false; fired = true; captured();
        } else if (action === 'restore') {
          armed = false; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
        } else if (action !== 'state') throw Error('Unknown action');
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state()));
      } catch (error) { res.writeHead(409); res.end(JSON.stringify({ error: error.message })); }
    } });
    return () => {
      armed = false; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; unregister();
    };
  });
}
