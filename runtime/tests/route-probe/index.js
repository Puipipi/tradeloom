// Test-only DSH plugin (never shipped): registers one route of each kind the way third-party
// plugins do (no auth of their own) and lists every registered route, so the route-guard test
// can probe them all. Loaded with an extra `dsh web --patch` by runtime/tests/run-guard-tests.sh
// and runtime/test-host.sh.
export const name = "dsh-app-route-probe";

const ORIGINAL = Symbol.for("cordis.original");

export function apply(ctx) {
  ctx.inject(["webServer"], (webCtx) => {
    const ws = webCtx.webServer;
    const raw = ws[ORIGINAL] ?? ws;
    const text = (res, body) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    webCtx.effect(() => ws.register({ kind: "exact", path: "/route-probe/exact", handler: (req, res) => text(res, "probe-exact\n") }),
      "route-probe: exact");
    webCtx.effect(() => ws.register({ kind: "prefix", path: "/route-probe/prefix", handler: (req, res) => text(res, "probe-prefix\n") }),
      "route-probe: prefix");
    webCtx.effect(() => ws.registerUpgrade({
      path: "/route-probe/ws",
      handler: (req, socket) => {
        socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 14\r\n\r\nprobe-upgrade\n");
      },
    }), "route-probe: upgrade");
    webCtx.effect(() => ws.register({
      kind: "exact",
      path: "/route-probe/routes",
      handler: (req, res) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({
          guard: typeof raw.dshGoRouteRejection === "function" ? "patched" : raw[Symbol.for("dsh-go.guarded")] ? "bridge" : "none",
          exact: [...raw.exact.keys()].sort(),
          prefix: [...raw.prefixes.keys()].sort(),
          upgrade: [...raw.upgrades.keys()].sort(),
        }));
      },
    }), "route-probe: route list");
  });
}
