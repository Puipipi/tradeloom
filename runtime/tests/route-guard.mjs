// Route-guard regression test against a running `dsh web` that loads the route-probe plugin.
//
//   node runtime/tests/route-guard.mjs <base-url> <launch-token> [--guard patched|bridge|none] [--expect-unguarded]
//
// Checks every registered exact/prefix/upgrade route: no credentials -> rejected by the guard
// (x-dsh-go-guard: reject), browser cookie -> reaches its handler, cross-site Origin /
// Sec-Fetch-Site and a rebound Host -> rejected even with the cookie. Then the flows the official
// client, our WebView and the app's Dart client use (index, static assets, plugin bundles,
// /api/remote.mux) and, when present, the dsh-go-bridge API. --guard bridge expects the bridge's
// fallback guard (unpatched webserver) instead of the patch, --guard none a bridge with
// guardRoutes: false on an unpatched webserver (routeGuard must read false); --expect-unguarded inverts the
// no-credential check to demonstrate the hole on an unpatched build. Node built-ins only.
import http from "node:http";
import { randomBytes } from "node:crypto";

const [baseArg, token, ...flags] = process.argv.slice(2);
if (!baseArg || !token) {
  console.error("usage: route-guard.mjs <base-url> <launch-token> [--expect-unguarded]");
  process.exit(2);
}
const expectUnguarded = flags.includes("--expect-unguarded");
const expectGuard = flags.includes("--guard") ? flags[flags.indexOf("--guard") + 1] : "patched";
const base = new URL(baseArg);
const authority = base.host;
// Routes that authenticate without the browser cookie (launch token / OAuth state).
const OPEN = new Set(["exact /connect", "exact /oauth/callback"]);

let failed = 0;
let passed = 0;
const pass = (msg) => { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${msg}`); };
const fail = (msg) => { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); };
const check = (ok, msg) => (ok ? pass(msg) : fail(msg));

function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: base.hostname, port: base.port, method, path,
      headers: { host: authority, ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
    }, (res) => {
      if (String(res.headers["content-type"]).startsWith("text/event-stream")) {   // a live stream never ends
        resolve({ status: res.statusCode, headers: res.headers, body: "" });
        res.destroy();
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error(`timeout ${method} ${path}`)));
    if (body) req.write(body);
    req.end();
  });
}

/** Raw upgrade request; resolves with the status code and whether the guard answered. */
function upgrade(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: base.hostname, port: base.port, path,
      headers: {
        host: authority, connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), ...headers,
      },
    });
    const done = (status, hdrs, socket) => {
      socket?.destroy();
      resolve({ status, guard: hdrs?.["x-dsh-go-guard"] === "reject" });
    };
    req.on("upgrade", (res, socket) => done(res.statusCode, res.headers, socket));
    req.on("response", (res) => { res.resume(); done(res.statusCode, res.headers, res.socket); });
    req.on("error", (e) => (e.code === "ECONNRESET" ? resolve({ status: 0, guard: false, reset: true }) : reject(e)));
    req.setTimeout(15000, () => req.destroy(new Error(`timeout upgrade ${path}`)));
    req.end();
  });
}

const guarded = (r) => r.headers["x-dsh-go-guard"] === "reject";
const probePath = (kind, path) => (kind === "prefix" ? `${path}/dsh-go-probe` : path);

console.log("== login (what the WebView and the Dart client do)");
const login = await request("GET", `/?token=${encodeURIComponent(token)}`);
const setCookie = [].concat(login.headers["set-cookie"] ?? []).find((c) => c.startsWith("dsh-auth-"));
check(login.status === 303 && setCookie, `GET /?token -> ${login.status} + dsh-auth cookie`);
if (!setCookie) process.exit(1);
const cookie = setCookie.split(";")[0];
const C = { cookie };

console.log("== route table");
const list = await request("GET", "/route-probe/routes", { headers: C });
check(list.status === 200, `route list with cookie -> ${list.status}`);
const table = JSON.parse(list.body);
console.log(`  guard=${table.guard}; exact=${table.exact.join(" ")}; prefix=${table.prefix.join(" ")}; upgrade=${table.upgrade.join(" ")}`);
if (!expectUnguarded) check(table.guard === expectGuard, `webserver reports guard=${table.guard}`);

console.log("== every HTTP route");
for (const kind of ["exact", "prefix"]) {
  for (const path of table[kind]) {
    const key = `${kind} ${path}`;
    const p = probePath(kind, path);
    const anon = await request("GET", p);
    if (OPEN.has(key)) {
      check(!guarded(anon), `${key}: open route, no cookie -> ${anon.status} from its own handler`);
      continue;
    }
    if (expectUnguarded) {
      check(!guarded(anon), `${key}: no cookie -> ${anon.status} (unpatched: not guarded)`);
      continue;
    }
    check(anon.status === 401 && guarded(anon), `${key}: no cookie -> ${anon.status}${guarded(anon) ? " (guard)" : ""}`);
    const authed = await request("GET", p, { headers: C });
    check(!guarded(authed) && authed.status !== 401 && authed.status !== 403, `${key}: cookie -> ${authed.status} (handler)`);
    const csrf = await request("POST", p, { headers: { ...C, origin: "http://evil.example", "content-type": "text/plain" }, body: "x" });
    check(csrf.status === 403 && guarded(csrf), `${key}: cookie + cross-site Origin -> ${csrf.status}`);
    const site = await request("GET", p, { headers: { ...C, "sec-fetch-site": "cross-site" } });
    check(site.status === 403 && guarded(site), `${key}: cookie + Sec-Fetch-Site cross-site -> ${site.status}`);
    const rebound = await request("GET", p, { headers: { ...C, host: `evil.example:${base.port}` } });
    check(rebound.status === 403 && guarded(rebound), `${key}: cookie + rebound Host -> ${rebound.status}`);
  }
}

console.log("== every upgrade route");
for (const path of table.upgrade) {
  const anon = await upgrade(path);
  if (expectUnguarded) { check(!anon.guard, `upgrade ${path}: no cookie -> ${anon.status} (unpatched)`); continue; }
  check(anon.status === 401 && anon.guard, `upgrade ${path}: no cookie -> ${anon.status}${anon.guard ? " (guard)" : ""}`);
  const evil = await upgrade(path, { ...C, origin: "http://evil.example" });
  check(evil.status === 403 && evil.guard, `upgrade ${path}: cookie + cross-site Origin -> ${evil.status}`);
  const authed = await upgrade(path, C);
  check(!authed.guard && authed.status !== 401 && authed.status !== 403,
    `upgrade ${path}: cookie -> ${authed.status}${authed.reset ? " (handler closed)" : ""}`);
}

console.log("== official client / WebView / Dart client flows");
const index = await request("GET", "/", { headers: C });
check(index.status === 200, `GET / with cookie -> ${index.status}`);
const anonIndex = await request("GET", "/");
check(anonIndex.status === 401 && !guarded(anonIndex), `GET / without cookie -> ${anonIndex.status} (frontend-static, unchanged)`);
const asset = /(?:src|href)="\.(\/assets\/[^"]+\.(?:js|css))"/.exec(index.body)?.[1];
if (asset) {
  const a = await request("GET", asset);
  check(a.status === 200, `static ${asset} without cookie -> ${a.status} (unchanged)`);
}
const bundles = [...index.body.matchAll(/"(plugins\/\?\?[^"]+)"/g)].map((m) => `/${m[1].replaceAll("&amp;", "&")}`);
check(bundles.length > 0, `index references ${bundles.length} plugin bundle URLs`);
for (const b of bundles.slice(0, 3)) {
  const withCookie = await request("GET", b, { headers: { ...C, "sec-fetch-site": "same-origin", "sec-fetch-dest": "script" } });
  check(withCookie.status === 200, `same-origin <script> ${b.slice(0, 48)}… -> ${withCookie.status}`);
}
const api = await request("POST", "/api/settings/describe", {
  headers: { ...C, "content-type": "application/json", origin: base.origin, "sec-fetch-site": "same-origin" },
  body: JSON.stringify({ type: "client-request", rpcId: "t1", method: "settings/describe", payload: {} }),
});
check(api.status === 200 && api.body.includes("server-response"), `POST /api/settings/describe (page fetch) -> ${api.status}`);
const mux = await upgrade("/api/remote.mux", C);
check(mux.status === 101, `WebSocket /api/remote.mux with cookie (Dart client) -> ${mux.status}`);

if (table.prefix.includes("/dsh-go")) {
  console.log("== dsh-go-bridge");
  const capabilitiesAnon = await request("GET", "/dsh-go/v1/capabilities");
  check(capabilitiesAnon.status === 401, `capabilities without cookie -> ${capabilitiesAnon.status}`);
  const capabilities = await request("GET", "/dsh-go/v1/capabilities", { headers: C });
  let negotiated = {};
  try { negotiated = JSON.parse(capabilities.body); } catch {}
  check(capabilities.status === 200 && negotiated.v === 1 && typeof negotiated.bridge === "string"
    && Array.isArray(negotiated.capabilities) && negotiated.capabilities.includes("native-ui"),
    `capabilities with cookie -> ${capabilities.status}, v=${negotiated.v}`);
  const capabilitiesRefused = await request("GET", "/dsh-go/v1/capabilities", { headers: { ...C, origin: "http://evil.example" } });
  check(capabilitiesRefused.status === 403, `capabilities with cross-site Origin -> ${capabilitiesRefused.status}`);
  const anon = await request("GET", "/dsh-go/v1/inventory");
  check(anon.status === 401, `inventory without cookie -> ${anon.status}`);
  const inv = await request("GET", "/dsh-go/v1/inventory", { headers: C });
  let body = {};
  try { body = JSON.parse(inv.body); } catch {}
  check(inv.status === 200 && body.v === 1 && Array.isArray(body.packages), `inventory with cookie -> ${inv.status}, v=${body.v}, ${body.packages?.length ?? 0} packages`);
  check(typeof body.currentRev === "string" && body.release?.version, `inventory currentRev=${body.currentRev} release=${body.release?.version}`);
  const guardOn = expectGuard !== "none";
  check(body.routeGuard === guardOn && body.routeGuardMode === (guardOn ? expectGuard : "off"),
    `inventory routeGuard=${body.routeGuard} (measured), mode=${body.routeGuardMode}`);
  check(body.packages?.some((p) => p.name === "dsh-go-bridge" && p.hasClient), "bridge lists its own browser half");
  check(body.slots === null && body.bootRev === undefined, "no page has reported yet -> slots null, no bootRev (app probes)");
  const report = {
    bootRev: body.currentRev,
    attribution: "start",
    unresolved: 1,
    slots: {
      "settings.section": [
        { package: "dsh-pet", cell: "dsh-pet-config", order: 50.4, label: "桌宠配置", priority: 0, active: true },
        { package: null, cell: "mystery", order: 0, priority: 0, active: true },
        { package: "dsh-go-bridge", cell: "mask", order: 0, priority: -1000000007, active: true },
      ],
      "sidebar.right.pane.tab": [
        { package: "dsh-pet", cell: "dsh-pet:panel", order: 0, label: "桌宠", active: true,
          tab: { id: "dsh-pet:panel", kind: "dsh-pet-panel", title: "桌宠", guide: [{ id: "dsh-pet-panel", title: "桌宠", order: 5.2 }, { order: 1 }] } },
      ],
    },
  };
  const post = await request("POST", "/dsh-go/v1/occupancy", {
    headers: { ...C, "content-type": "application/json", origin: base.origin }, body: JSON.stringify(report),
  });
  check(post.status === 204, `occupancy report -> ${post.status}`);
  const bad = await request("POST", "/dsh-go/v1/occupancy", { headers: { ...C, "content-type": "text/plain" }, body: "{}" });
  check(bad.status === 415, `occupancy with text/plain -> ${bad.status}`);
  const evil = await request("POST", "/dsh-go/v1/occupancy", {
    headers: { ...C, "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify(report),
  });
  check(evil.status === 403, `occupancy from a cross-site page -> ${evil.status}`);
  const worse = { ...report, unresolved: 9, slots: { "settings.section": [{ package: "other", cell: "x", order: 0 }] } };
  await request("POST", "/dsh-go/v1/occupancy", { headers: { ...C, "content-type": "application/json" }, body: JSON.stringify(worse) });
  const after = JSON.parse((await request("GET", "/dsh-go/v1/inventory", { headers: C })).body);
  const list = after.slots?.["settings.section"] ?? [];
  check(list.length === 1 && list[0].package === "dsh-pet" && list[0].official === false && list[0].order === 50,
    `wire occupants: ${JSON.stringify(list)}`);
  const tab = after.slots?.["sidebar.right.pane.tab"]?.[0];
  check(tab?.label === "桌宠" && tab.tab?.id === "dsh-pet:panel" && tab.tab.kind === "dsh-pet-panel"
    && tab.tab.guide.length === 1 && tab.tab.guide[0].order === 5,
    `right pane tab occupant keeps its type: ${JSON.stringify(tab?.tab)}`);
  check(after.bootRev === body.currentRev && after.occupancy?.stale === false && after.occupancy?.unresolved === 1,
    `inventory bootRev=${after.bootRev} stale=${after.occupancy?.stale}; a less attributed report of the same graph was ignored`);
}

console.log(`== route guard: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
