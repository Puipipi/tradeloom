const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const template = fs.readFileSync(
  path.resolve(__dirname, "../../templates/workbench/agent_center.html"),
  "utf8",
);
const script = template.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
assert.ok(script, "agent-center disclosure script is present");

function mount(hash) {
  const disclosure = { open: false };
  let focusOptions;
  const focusable = { focus(options) { focusOptions = options; } };
  const form = { querySelector() { return focusable; } };
  const listeners = new Map();
  const window = {
    location: { hash },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const document = {
    getElementById(id) {
      if (id === "workflow-create-disclosure") return disclosure;
      if (id === "workflow-create-form") return form;
      return null;
    },
  };
  vm.runInNewContext(script, { document, window });
  return { disclosure, window, listeners, getFocusOptions: () => focusOptions };
}

const anchored = mount("#workflow-create-form");
assert.equal(anchored.disclosure.open, true, "form anchor opens its collapsed disclosure");
assert.equal(anchored.getFocusOptions()?.preventScroll, true, "anchor focus does not scroll iframe ancestors");

const ordinary = mount("");
assert.equal(ordinary.disclosure.open, false, "without the form anchor the disclosure stays collapsed");
assert.ok(ordinary.listeners.has("hashchange"), "later hash navigation is observed");
ordinary.window.location.hash = "#workflow-create-form";
ordinary.listeners.get("hashchange")();
assert.equal(ordinary.disclosure.open, true, "hash navigation expands the form");
assert.equal(ordinary.getFocusOptions()?.preventScroll, true);
