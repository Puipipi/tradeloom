const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "../../static/workbench/app.js"),
  "utf8",
);
const pendingStorageKey = "tradeloom.generation-takeover.pending.v1:workflow-1";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function makeGenerationForm({ stepId = "step-1", operator = "local operator", note = "Worker may still be running." } = {}) {
  const listeners = new Map();
  const button = { disabled: false, hidden: false };
  const error = { hidden: true, textContent: "" };
  const refresh = { hidden: true };
  const elements = {
    decision: { value: "outcome_unknown" },
    operator_label: { value: operator, readOnly: false },
    note: { value: note, readOnly: false },
  };
  const form = {
    hidden: false,
    classList: { contains: (name) => name === "generation-takeover-form" },
    dataset: {
      executionUrl: `/api/workflow-tasks/workflow-1/deliverables/${stepId}/takeover`,
      expectedStepId: stepId,
      idempotencyKey: `workflow:workflow-1:deliverables:${stepId}:takeover`,
    },
    elements,
    querySelector(selector) {
      if (selector === 'button[type="submit"]') return button;
      if (selector === "[data-execution-error]") return error;
      if (selector === "[data-execution-refresh]") return refresh;
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'input[name="operator_label"], textarea[name="note"]'
        ? [elements.operator_label, elements.note]
        : [];
    },
    reportValidity: () => true,
    addEventListener(name, handler) { listeners.set(name, handler); },
  };
  return { form, button, error, listeners };
}

function makePendingForm() {
  const listeners = new Map();
  const button = { disabled: false, hidden: true };
  const details = { hidden: true };
  const error = { hidden: true, textContent: "" };
  const nodes = {
    "[data-pending-request]": details,
    "[data-pending-target]": { textContent: "" },
    "[data-pending-key]": { textContent: "" },
    "[data-pending-operator]": { textContent: "" },
    "[data-pending-note]": { textContent: "" },
    'button[type="submit"]': button,
    "[data-pending-error]": error,
  };
  return {
    form: {
      hidden: true,
      dataset: { workflowId: "workflow-1" },
      querySelector: (selector) => nodes[selector] || null,
      addEventListener(name, handler) { listeners.set(name, handler); },
    },
    button,
    details,
    error,
    nodes,
    listeners,
  };
}

function runApp({ activeForm, pendingForm, sessionStorage, fetch, location }) {
  const document = {
    querySelector(selector) {
      return selector === ".generation-takeover-pending-form" ? pendingForm : null;
    },
    querySelectorAll(selector) {
      return activeForm && selector.includes(".generation-takeover-form") ? [activeForm] : [];
    },
    getElementById: () => null,
  };
  vm.runInNewContext(source, {
    document,
    fetch,
    sessionStorage,
    location,
    FormData: class {
      constructor(form) { this.form = form; }
      get(name) { return this.form.elements[name].value; }
    },
    console,
  });
  return document;
}

function response(body = {}) {
  return {
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

async function testReloadWithoutRunningFormCanConfirmSavedReceipt() {
  const sessionStorage = new MemoryStorage();
  const firstPageForm = makeGenerationForm();
  const firstPendingForm = makePendingForm();
  const requests = [];
  let fetchCount = 0;
  const fetch = async (url, options) => {
    requests.push({ url, body: options.body });
    if (fetchCount++ === 0) throw new Error("response lost after server commit");
    return response({ step_id: "step-1", outcome_unknown: true, replayed: true });
  };
  let reloadCount = 0;
  const location = { reload: () => reloadCount++ };
  const activeDocument = runApp({
    activeForm: firstPageForm.form,
    pendingForm: firstPendingForm.form,
    sessionStorage,
    fetch,
    location,
  });
  const firstSubmit = () => firstPageForm.listeners.get("submit")({ preventDefault() {} });
  await firstSubmit();

  const originalPayload = {
    expected_step_id: "step-1",
    decision: "outcome_unknown",
    idempotency_key: "workflow:workflow-1:deliverables:step-1:takeover",
    operator_label: "local operator",
    note: "Worker may still be running.",
  };
  const originalBody = JSON.stringify(originalPayload);
  assert.equal(requests[0].body, originalBody);
  assert.equal(firstPageForm.error.hidden, false);
  const savedEnvelope = JSON.parse(sessionStorage.getItem(pendingStorageKey));
  assert.equal(savedEnvelope.body, originalBody);
  assert.equal(savedEnvelope.url, firstPageForm.form.dataset.executionUrl);

  // The server has moved the step to failed, so reload contains no active
  // takeover form. The fixed workflow-level receipt entry still replays the
  // exact historical request and clears it only after the saved receipt returns.
  const receiptPage = makePendingForm();
  const receiptDocument = {
    querySelector: (selector) => selector === ".generation-takeover-pending-form" ? receiptPage.form : null,
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  vm.runInNewContext(source, {
    document: receiptDocument,
    fetch,
    sessionStorage,
    location,
    FormData: class {},
    console,
  });
  assert.equal(receiptPage.form.hidden, false);
  assert.match(receiptPage.nodes["[data-pending-target]"].textContent, /step-1/);
  assert.match(receiptPage.nodes["[data-pending-key]"].textContent, /workflow:workflow-1/);
  assert.match(receiptPage.nodes["[data-pending-operator]"].textContent, /local operator/);
  assert.match(receiptPage.nodes["[data-pending-note]"].textContent, /Worker may still be running/);
  await receiptPage.listeners.get("submit")({ preventDefault() {} });
  assert.equal(requests[1].url, savedEnvelope.url);
  assert.equal(requests[1].body, originalBody);
  assert.equal(sessionStorage.getItem(pendingStorageKey), null);
  assert.equal(reloadCount, 1);
  assert.ok(activeDocument);
}

async function testNewRunningFormCannotOverwriteOlderUnknownRequest() {
  const sessionStorage = new MemoryStorage();
  const oldPayload = {
    expected_step_id: "step-old",
    decision: "outcome_unknown",
    idempotency_key: "workflow:workflow-1:deliverables:step-old:takeover",
    operator_label: "first operator",
    note: "Original unknown request.",
  };
  const oldEnvelope = {
    url: "/api/workflow-tasks/workflow-1/deliverables/step-old/takeover",
    expected_step_id: oldPayload.expected_step_id,
    idempotency_key: oldPayload.idempotency_key,
    payload: oldPayload,
    body: JSON.stringify(oldPayload),
  };
  sessionStorage.setItem(pendingStorageKey, JSON.stringify(oldEnvelope));
  const newPageForm = makeGenerationForm({ stepId: "step-new", operator: "second operator", note: "New request." });
  const pendingForm = makePendingForm();
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return response();
  };
  runApp({
    activeForm: newPageForm.form,
    pendingForm: pendingForm.form,
    sessionStorage,
    fetch,
    location: { reload() {} },
  });

  await newPageForm.listeners.get("submit")({ preventDefault() {} });

  assert.equal(fetchCount, 0);
  assert.equal(newPageForm.error.hidden, false);
  assert.deepEqual(JSON.parse(sessionStorage.getItem(pendingStorageKey)), oldEnvelope);
  assert.equal(pendingForm.form.hidden, false);
}

Promise.all([
  testReloadWithoutRunningFormCanConfirmSavedReceipt(),
  testNewRunningFormCannotOverwriteOlderUnknownRequest(),
]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
