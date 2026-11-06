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
console.log("customer JS tests passed");
