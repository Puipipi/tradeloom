// Test-only native plugin (runtime/tests/native-bridge.mjs): invoke handlers and every kind of
// misbehaviour the bridge must contain (throws, timeouts, bad effects, oversize views, bad data).
export const name = "dsh-go-fixture-quick";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const seen = [];
// Shared with native-usage's /native-fixture/state so the test can see aborts.
const Q = (globalThis.__dshGoFixtureQuick ??= { aborted: [] });

export function apply(ctx) {
  ctx.inject(["dshGo"], (ctx) => {
    ctx.dshGo.on("translate", async (scope, event) => {
      seen.push({ id: "translate", scope, event });
      return { insert: `EN(${scope.clipboard ?? ""})|draft=${scope.draft === undefined ? "absent" : "present"}`, toast: "已翻译" };
    });
    ctx.dshGo.on("speak", (scope) => ({ copy: `msg:${scope.message ?? "absent"}:${scope.messageId}` }));
    ctx.dshGo.on("slow", async () => { await sleep(5000); return { toast: "too late" }; });
    ctx.dshGo.panel("tools", {
      view: (scope, caps) => ({ type: "stack", children: [{ type: "text", text: `locale=${caps.locale}` }, { type: "actions", items: [{ label: "好", action: "good" }] }] }),
      actions: {
        good: () => [{ type: "open", page: "panel:tools" }, { link: "https://example.com/a?b=1" }, { command: { name: "compact", args: "now" } }, { refresh: true }],
        mixed: () => [
          { type: "link", url: "http://insecure.example" },
          { type: "link", url: "https://user:pw@example.com" },
          { type: "open", page: "panel:nope" },
          { type: "play", asset: "x" },
          { type: "toast", text: "这是一条非常非常长的提示文字，一共超过了四十个字符的上限，所以应该被桥接截断掉才对的呢呢" },
        ],
        many: () => [{ toast: "1" }, { toast: "2" }, { toast: "3" }, { toast: "4" }, { toast: "5" }],
        garbage: () => 42,
        throws: () => { throw new Error("handler boom"); },
        echo: (scope, event) => ({ toast: `${event.action}:${JSON.stringify(event.value)}:${scope.draft ?? "nodraft"}` }),
        // deferred results (protocol §4.7)
        later: () => ({
          pending: { label: "翻译中，请稍候片刻马上就好了呢呢呢", timeoutMs: 5000 },
          result: sleep(600).then(() => [{ insert: "later" }, { toast: "完成" }, { link: "https://x.example" }, { patch: { note: "deferred" } }]),
        }),
        fast: () => ({ pending: true, result: Promise.resolve({ copy: "fast" }) }),
        clamp: () => ({ pending: { timeoutMs: 999999 }, result: sleep(100).then(() => ({ toast: "ok" })) }),
        forever: () => ({
          pending: { timeoutMs: 1200 },
          result: (signal) => new Promise((resolve) => signal.addEventListener("abort", () => {
            Q.aborted.push("forever");
            setTimeout(() => resolve({ insert: "too late" }), 50);
          })),
        }),
        hold: (scope, event) => ({
          pending: { label: "等待", timeoutMs: 20000 },
          result: (signal) => new Promise((resolve) => signal.addEventListener("abort", () => {
            Q.aborted.push(`hold:${event.value?.tag ?? ""}`);
            resolve({ insert: "dropped" });
          })),
        }),
        fail: () => ({ pending: true, result: async () => { throw new Error("network down"); } }),
        failEager: () => ({ pending: true, result: Promise.reject(new Error("eager failure")) }),
        nowork: () => ({ pending: { label: "x" } }),
        eager: () => ({ pending: true, result: sleep(300).then(() => ({ insert: "eager" })), toast: "ignored" }),
      },
    });
    ctx.dshGo.panel("boom", { view: () => { throw new Error("view boom"); }, data: () => { throw new Error("data boom"); } });
    ctx.dshGo.panel("huge", { view: () => ({ type: "text", text: "y".repeat(40000) }) });
    ctx.dshGo.panel("late", { view: async () => { await sleep(4000); return { type: "text", text: "late" }; } });
    ctx.dshGo.panel("undeclared-panel", { view: { type: "text", text: "never shown" } });
  });
}
