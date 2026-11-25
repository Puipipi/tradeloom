// Test-only native plugin (runtime/tests/native-bridge.mjs). Panel "usage" has a view function and
// a data feed the test drives through /native-fixture/emit; strip "cost" mirrors it; panel "plain"
// is a view without data. /native-fixture/* also toggles loader entries (cache invalidation test).
export const name = "dsh-go-fixture-usage";

const state = { feeds: new Map(), dataStarts: 0, dataCancels: 0, viewCalls: 0, lastCaps: null };

export function apply(ctx) {
  ctx.inject(["dshGo"], (ctx) => {
    ctx.dshGo.panel("usage", {
      view: (scope, caps) => {
        state.viewCalls++;
        state.lastCaps = caps;
        return { type: "stack", title: `usage ${scope.sessionId ?? "global"}`, children: [
          { type: "metric", label: "count", value: { $: "data.count" } },
          { type: "text", text: { $: "data.note" } },
        ] };
      },
      data: (scope, emit, caps) => {
        state.dataStarts++;
        state.dataCaps = caps;
        const key = JSON.stringify(scope);
        const feed = { emit, count: 0 };
        state.feeds.set(key, feed);
        emit({ count: 0, note: "start", nested: { a: 1, b: 2 } });
        return () => { state.dataCancels++; if (state.feeds.get(key) === feed) state.feeds.delete(key); };
      },
      actions: {
        bump: (scope) => {
          const feed = state.feeds.get(JSON.stringify({ sessionId: scope.sessionId }));
          if (feed) { feed.count++; feed.emit({ count: feed.count, note: "bumped", nested: { a: 1, b: 2 } }); }
          return [{ toast: `bumped ${feed?.count ?? -1}` }, { patch: { note: "patched" } }];
        },
      },
    });
    ctx.dshGo.panel("plain", { view: { type: "text", text: "plain" } });
    ctx.dshGo.strip("cost", (scope, emit) => {
      emit({ text: `本对话 ¥0.42 · ${scope.sessionId ?? "-"} 这是一段超过二十四个字的状态条文字用来测试截断`, tone: "warn", extra: "dropped" });
    });

    ctx.inject(["webServer"], (web) => {
      const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      web.effect(() => web.webServer.register({
        kind: "prefix",
        path: "/native-fixture",
        handler: async (req, res) => {
          const url = new URL(req.url, "http://x");
          const op = url.pathname.slice("/native-fixture/".length);
          if (op === "state") return json(res, 200, { ...state, feeds: [...state.feeds.keys()], quick: globalThis.__dshGoFixtureQuick ?? null });
          if (op === "emit") {
            const feed = state.feeds.get(url.searchParams.get("scope") ?? "{}");
            if (!feed) return json(res, 404, { error: "no feed" });
            const n = Number(url.searchParams.get("n") ?? 1);
            for (let i = 0; i < n; i++) { feed.count++; feed.emit({ count: feed.count, note: url.searchParams.get("note") ?? "emit", nested: { a: 1, b: feed.count } }); }
            return json(res, 200, { count: feed.count });
          }
          if (op === "emit-raw") {
            const feed = state.feeds.get(url.searchParams.get("scope") ?? "{}");
            if (!feed) return json(res, 404, { error: "no feed" });
            const size = Number(url.searchParams.get("bytes") ?? 0);
            feed.emit({ count: -1, blob: "x".repeat(size) });
            return json(res, 200, { ok: true });
          }
          if (op === "refresh") { ctx.dshGo.refresh("usage", JSON.parse(url.searchParams.get("scope") ?? "{}")); return json(res, 200, { ok: true }); }
          if (op === "toggle") {
            const id = url.searchParams.get("entry");
            const entry = [...ctx.get("loader").entries()].find((e) => e.options.id === id);
            if (!entry) return json(res, 404, { error: "no entry" });
            await entry.update({ disabled: url.searchParams.get("disabled") === "1" ? true : null });
            return json(res, 200, { disabled: entry.disabled, hasFiber: entry.fiber !== undefined });
          }
          if (op === "attribution") {
            // Calling the service without a plugin context must throw, not mis-attribute.
            const raw = ctx.get("dshGo");
            let error = null;
            try { const { panel } = raw; panel("usage", { view: {} }); } catch (e) { error = String(e.message ?? e); }
            return json(res, 200, { error });
          }
          return json(res, 404, { error: "unknown op" });
        },
      }), "native-fixture: control routes");
    });
  });
}
