// Runs in the page, before the Host's injected scripts and browser bundles.
// Checking the Host's Node global would miss an older Android WebView.
function installPromiseWithResolvers() {
  if (typeof Promise.withResolvers === "function") return;
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: {
      withResolvers() {
        let resolve;
        let reject;
        const promise = new this((onResolve, onReject) => {
          if (resolve !== undefined || reject !== undefined) {
            throw new TypeError("Promise capability already initialized");
          }
          resolve = onResolve;
          reject = onReject;
        });
        if (typeof resolve !== "function" || typeof reject !== "function") {
          throw new TypeError("Promise capability requires callable resolvers");
        }
        return { promise, resolve, reject };
      },
    }.withResolvers,
  });
}

// One native abort listener per live source, shared by all combinations.
// Subscribers and their output controllers are still strongly retained until
// a source aborts. Successful operations alone do not release those objects.
function installAbortSignalAny() {
  if (typeof AbortSignal.any === "function") return;
  const hubs = new WeakMap();
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: {
      any(signals) {
        const controller = new AbortController();
        const sources = [...new Set(signals)];
        const aborted = sources.find(source => source.aborted);
        if (aborted !== undefined) {
          controller.abort(aborted.reason);
          return controller.signal;
        }
        const bindings = [];
        let settled = false;
        const prepareAbort = reason => {
          if (settled) return;
          settled = true;
          for (const [source, hub] of bindings) {
            hub.subscribers.delete(prepareAbort);
            if (hub.subscribers.size === 0) {
              source.removeEventListener("abort", hub.callback);
              hubs.delete(source);
            }
          }
          bindings.length = 0;
          return () => controller.abort(reason);
        };
        for (const source of sources) {
          let hub = hubs.get(source);
          if (hub === undefined) {
            const subscribers = new Set();
            const callback = () => {
              const reason = source.reason;
              const pending = [];
              // Settle every group before an output observer can abort
              // another source and steal an already selected reason.
              for (const subscriber of [...subscribers]) {
                const abort = subscriber(reason);
                if (abort !== undefined) pending.push(abort);
              }
              for (const abort of pending) abort();
            };
            hub = { subscribers, callback };
            hubs.set(source, hub);
            source.addEventListener("abort", callback, { once: true });
          }
          hub.subscribers.add(prepareAbort);
          bindings.push([source, hub]);
        }
        return controller.signal;
      },
    }.any,
  });
}

const bootstrap = `<script>(${installPromiseWithResolvers.toString()})();(${installAbortSignalAny.toString()})();</script>`;

export function injectPromiseWithResolvers(html) {
  return html.replace(/<head(?:\s[^>]*)?>/i, open => `${open}${bootstrap}`);
}
