const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "../../static/workbench/customers.js"),
  "utf8",
);

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.textContent = "";
    this.hidden = true;
  }
  replaceChildren() { this.children = []; }
  appendChild(child) { this.children.push(child); }
}

const elements = {
  "backtest-result": new Element("div"),
  "backtest-summary": new Element("p"),
  "backtest-rows": new Element("tbody"),
};
const document = {
  getElementById(id) { return elements[id] || null; },
  createElement(tag) { return new Element(tag); },
  querySelectorAll() { return []; },
};
const context = { document };
vm.runInNewContext(source, context);
const api = context.TradeLoomCustomers;

assert.equal(api.formatHitRate(null), "未知");
assert.equal(api.formatHitRate("0.5"), "50%");
assert.equal(api.formatHitRate("not-a-rate"), "未知");

const backtest = {
  summary: {
    evaluation_count: 2,
    recommended_count: 1,
    resolved_recommendation_count: 1,
    hit_rate: "1",
    censored_count: 1,
  },
  rows: [{
    as_of: "2026-04-20",
    result: "recommended",
    order_count: 3,
    silence_days: "50",
    threshold_days: "45.000000",
    outcome: "order_placed",
  }],
};
api.renderBacktest(backtest);
assert.equal(elements["backtest-result"].hidden, false);
assert.match(elements["backtest-summary"].textContent, /命中率 100%/);
assert.match(elements["backtest-summary"].textContent, /观察不足 1 次/);
assert.equal(elements["backtest-rows"].children.length, 1);
assert.deepEqual(
  elements["backtest-rows"].children[0].children.map(cell => cell.textContent),
  ["2026-04-20", "建议跟进", "3", "50 / 45.000000", "观察期内下单"],
);

require("node:test")("customer evaluation keeps submit, reload and retry behavior", async () => {
  const submitButton = { disabled: false };
  let submit;
  let reloads = 0;
  let succeeds = false;
  const requests = [];
  const errors = new Element("p");
  const form = {
    dataset: { customerId: "customer-1" },
    elements: { as_of: { value: "2026-04-20" } },
    querySelector: () => submitButton,
    addEventListener: (type, listener) => { if (type === "submit") submit = listener; },
  };
  vm.runInNewContext(source, {
    document: {
      getElementById: id => ({
        "customer-evaluation-form": form,
        "customer-page-error": errors,
      })[id],
      querySelector: () => ({ content: "test-csrf" }),
      querySelectorAll: () => [],
    },
    location: { reload: () => { reloads += 1; } },
    fetch: async (url, options) => {
      assert.equal(submitButton.disabled, true);
      requests.push([url, options.method, options.credentials, options.headers["X-CSRFToken"], JSON.parse(options.body)]);
      return { ok: succeeds, status: 409, json: async () => ({ error_code: "test_conflict" }) };
    },
  });
  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } };
  await submit(event);
  assert.equal(reloads, 0);
  assert.equal(submitButton.disabled, false);
  assert.equal(errors.hidden, false);
  assert.match(errors.textContent, /test_conflict/);
  succeeds = true;
  await submit(event);
  assert.equal(prevented, 2);
  assert.equal(reloads, 1);
  assert.equal(submitButton.disabled, true);
  assert.equal(errors.hidden, true);
  const expected = ["/api/customers/customer-1/evaluate", "POST", "same-origin", "test-csrf", { as_of: "2026-04-20" }];
  assert.deepEqual(requests, [expected, expected]);
});
