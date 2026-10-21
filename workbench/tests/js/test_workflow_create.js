const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.resolve(__dirname, "../../static/workbench/app.js");
const source = fs.readFileSync(sourcePath, "utf8");
const storageKey = "tradeloom.workflow-create.pending.v1";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function makeForm(batchId = "", userGoal = "") {
  const listeners = new Map();
  const submitButton = { disabled: false };
  const form = {
    dataset: {
      workflowCreateEndpoint: "/api/workflow-tasks",
      intentPreviewEndpoint: "/api/workflow-intent/preview",
    },
    elements: { batch_id: { value: batchId }, user_goal: { value: userGoal } },
    addEventListener(name, handler) { listeners.set(name, handler); },
    querySelector(selector) { return selector === 'button[type="submit"]' ? submitButton : null; },
    reportValidity() { return true; },
    dispatch(name) { return listeners.get(name)({ preventDefault() {} }); },
  };
  return { form, submitButton };
}

function makePage({ storage, form, fetch, location, randomUUID = () => "stable-key" }) {
  const error = { hidden: true, textContent: "" };
  const notice = { hidden: true, textContent: "" };
  const preview = {
    hidden: true,
    querySelector(selector) {
      return this.fields[selector] || null;
    },
    fields: {
      "[data-intent-reason]": { textContent: "" },
      "[data-intent-task-type]": { textContent: "" },
      "[data-intent-evidence]": { textContent: "" },
      "[data-intent-sources]": { textContent: "" },
      "[data-intent-versions]": { textContent: "" },
      "[data-intent-clarification]": { hidden: true, textContent: "" },
      "[data-intent-mode]": { textContent: "" },
    },
  };
  const confirmButton = {
    disabled: true,
    hidden: true,
    textContent: "",
    addEventListener(name, handler) { this.handler = name === "click" ? handler : this.handler; },
    dispatch() { return this.handler(); },
  };
  const loadProposalButton = {
    hidden: true,
    textContent: "",
    addEventListener(name, handler) { this.handler = name === "click" ? handler : this.handler; },
    dispatch() { return this.handler(); },
  };
  preview.querySelector = (selector) => selector === "[data-intent-confirm]" ? confirmButton : preview.fields[selector];
  const document = {
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById(id) {
      return {
        "workflow-create-form": form,
        "workflow-create-error": error,
        "workflow-create-notice": notice,
        "workflow-intent-preview": preview,
        "workflow-load-agent-proposal": loadProposalButton,
      }[id] || null;
    },
  };
  vm.runInNewContext(source, {
    document,
    sessionStorage: storage,
    fetch,
    location,
    crypto: { randomUUID },
    Date,
    Math,
    console,
  });
  return { error, notice, preview, confirmButton, loadProposalButton };
}

const previewBody = {
  status: "ready",
  mode: "local_mock",
  execution: "simulated_rules",
  model_provider: "not_configured",
  classification: { task_type: "prepare_product_data", reason: "明确提出产品资料整理。" },
  evidence: ["整理产品资料"],
  action: { operation: "create_workflow", task_type: "prepare_product_data" },
  confirmation_token: "signed-preview-token",
  rules: { version: "rules-v1", sha256: "a".repeat(64) },
  prompt: { version: "prompt-v1", sha256: "b".repeat(64) },
  sources: [{ kind: "batch", id: "batch-1", title: "Batch" }],
};

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => "application/json" }, json: async () => body };
}

async function submit(form) { await form.dispatch("submit"); }
async function confirm(ui) { await ui.confirmButton.dispatch(); }

async function testPreviewMustBeFollowedByExplicitConfirmation() {
  const storage = new MemoryStorage();
  const requests = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    return url.includes("preview") ? response(previewBody) : response({ id: "workflow-1" });
  };
  const location = { href: "" };
  const page = makeForm("batch-1", "整理产品资料");
  const ui = makePage({ storage, form: page.form, fetch, location });
  await submit(page.form);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /preview/);
  assert.equal(storage.getItem(storageKey) !== null, true);
  assert.equal(ui.confirmButton.disabled, false);
  assert.equal(location.href, "");

  await confirm(ui);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /workflow-tasks/);
  assert.equal(requests[1].body.confirmation_token, "signed-preview-token");
  assert.equal(requests[1].body.idempotency_key, "stable-key");
  assert.equal(location.href, "/workflow-tasks/workflow-1");
  assert.equal(storage.getItem(storageKey), null);
}

async function testPreviewFailureNeverCallsCreate() {
  const requests = [];
  const page = makeForm("batch-1", "整理产品资料");
  const ui = makePage({
    storage: new MemoryStorage(), form: page.form,
    fetch: async (url) => { requests.push(url); throw new Error("connection lost"); },
    location: { href: "" },
  });
  await submit(page.form);
  assert.deepEqual(requests, ["/api/workflow-intent/preview"]);
  assert.match(ui.error.textContent, /没有创建工作流/);
}

async function testUnknownCreateResultReloadKeepsSameTokenAndKey() {
  const storage = new MemoryStorage();
  const requests = [];
  let createCount = 0;
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.includes("preview")) return response(previewBody);
    createCount += 1;
    if (createCount === 1) throw new Error("connection lost");
    return response({ id: "workflow-2" });
  };
  const location = { href: "" };
  const first = makeForm("batch-1", "整理产品资料");
  const firstUi = makePage({ storage, form: first.form, fetch, location });
  await submit(first.form);
  await confirm(firstUi);
  const createRequest = requests[1];
  assert.ok(storage.getItem(storageKey));

  const reloaded = makeForm();
  const reloadUi = makePage({ storage, form: reloaded.form, fetch, location });
  assert.equal(reloaded.form.elements.batch_id.value, "batch-1");
  assert.equal(reloaded.form.elements.user_goal.value, "整理产品资料");
  assert.match(reloadUi.notice.textContent, /结果未知的原创建请求/);
  assert.equal(reloadUi.confirmButton.disabled, false);
  await confirm(reloadUi);
  assert.deepEqual(requests[2], createRequest);
  assert.equal(location.href, "/workflow-tasks/workflow-2");
  assert.equal(storage.getItem(storageKey), null);
}

async function testEditThenRestoreReusesTheOriginalConfirmation() {
  const storage = new MemoryStorage();
  const requests = [];
  const page = makeForm("batch-1", "整理产品资料");
  const ui = makePage({
    storage, form: page.form,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url.includes("preview")) return response(previewBody);
      throw new Error("unknown result");
    },
    location: { href: "" },
  });
  await submit(page.form);
  await confirm(ui);
  const originalCreate = requests[1];
  page.form.elements.user_goal.value = "临时编辑";
  page.form.dispatch("input");
  assert.equal(ui.confirmButton.disabled, true);
  page.form.elements.user_goal.value = "整理产品资料";
  page.form.dispatch("input");
  await submit(page.form);
  assert.equal(requests.length, 2);
  await confirm(ui);
  assert.deepEqual(requests[2], originalCreate);
}

async function testReparseBeforeCreateRequestsAFreshPreview() {
  const requests = [];
  const page = makeForm("batch-1", "整理产品资料");
  const ui = makePage({
    storage: new MemoryStorage(), form: page.form,
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      const count = requests.filter((item) => item.url.includes("preview")).length;
      return response({ ...previewBody, confirmation_token: `token-${count}` });
    },
    location: { href: "" },
  });
  await submit(page.form);
  await submit(page.form);
  assert.equal(requests.filter((item) => item.url.includes("preview")).length, 2);
  await confirm(ui);
  assert.equal(requests[2].body.confirmation_token, "token-2");
}

async function testPreviewResponseAfterEditCannotBeConfirmed() {
  let resolvePreview;
  const page = makeForm("batch-1", "整理产品资料");
  const ui = makePage({
    storage: new MemoryStorage(), form: page.form,
    fetch: () => new Promise((resolve) => { resolvePreview = resolve; }),
    location: { href: "" },
  });
  const pending = submit(page.form);
  page.form.elements.user_goal.value = "临时修改后的目标";
  page.form.dispatch("input");
  resolvePreview(response(previewBody));
  await pending;
  assert.equal(ui.confirmButton.disabled, true);
  assert.equal(ui.preview.hidden, true);
}

async function testKnownInvalidTokenAllowsExplicitReparseWithNewKey() {
  const requests = [];
  let previewCount = 0;
  let keyCount = 0;
  const page = makeForm("batch-1", "整理产品资料");
  const ui = makePage({
    storage: new MemoryStorage(), form: page.form,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url.includes("preview")) {
        previewCount += 1;
        return response({ ...previewBody, confirmation_token: `fresh-${previewCount}` });
      }
      return response({ code: "intent_confirmation_invalid", detail: "规则已变化" }, 409);
    },
    location: { href: "" },
    randomUUID: () => `key-${++keyCount}`,
  });
  await submit(page.form);
  await confirm(ui);
  const firstKey = requests[1].body.idempotency_key;
  await submit(page.form);
  assert.equal(previewCount, 2);
  await confirm(ui);
  assert.notEqual(requests[3].body.idempotency_key, firstKey);
  assert.equal(requests[3].body.confirmation_token, "fresh-2");
}

async function testUnsubmittedDraftRestoreSaysCreationWasNotSubmitted() {
  const storage = new MemoryStorage();
  storage.setItem(storageKey, JSON.stringify({
    version: 2,
    activeKey: "draft-key",
    requests: [{
      key: "draft-key",
      payload: { batch_id: "batch-1", user_goal: "整理产品资料" },
      preview: previewBody,
      createAttempted: false,
    }],
  }));
  const page = makeForm();
  const ui = makePage({ storage, form: page.form, fetch: async () => response(previewBody), location: { href: "" } });
  assert.match(ui.notice.textContent, /尚未提交创建/);
  assert.doesNotMatch(ui.notice.textContent, /结果未知的原创建请求/);
}

async function testSuccessfulNewRequestKeepsOtherUnknownRequestForRetry() {
  const storage = new MemoryStorage();
  const requests = [];
  let keyCount = 0;
  let goalACreateCount = 0;
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.includes("preview")) {
      return response({ ...previewBody, confirmation_token: `token-${body.user_goal}` });
    }
    if (body.user_goal === "整理产品资料" && goalACreateCount++ === 0) {
      throw new Error("unknown response for request A");
    }
    return response({ id: body.user_goal === "整理产品资料" ? "workflow-A" : "workflow-B" });
  };
  const location = { href: "" };
  const page = makeForm("batch-1", "整理产品资料");
  const ui = makePage({ storage, form: page.form, fetch, location, randomUUID: () => `key-${++keyCount}` });
  await submit(page.form);
  await confirm(ui);
  const originalA = requests[1];

  page.form.elements.user_goal.value = "生成英文目录";
  page.form.dispatch("input");
  await submit(page.form);
  await confirm(ui);
  assert.equal(location.href, "/workflow-tasks/workflow-B");
  const saved = JSON.parse(storage.getItem(storageKey));
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.activeKey, originalA.body.idempotency_key);

  const restored = makeForm();
  const restoredUi = makePage({ storage, form: restored.form, fetch, location });
  assert.equal(restored.form.elements.user_goal.value, "整理产品资料");
  assert.match(restoredUi.notice.textContent, /结果未知的原创建请求/);
  await confirm(restoredUi);
  assert.deepEqual(requests[4], originalA);
  assert.equal(location.href, "/workflow-tasks/workflow-A");
}

async function testStructuredProposalHandoffReachesExistingPreviewAndExplicitCreate() {
  const storage = new MemoryStorage();
  const requests = [];
  const proposal = {
    version: 1,
    batch_id: "batch-structured",
    user_goal: "Please prepare the approved English catalog.",
    task_type: "generate_deliverables",
  };
  const location = { href: "", hash: `#proposal=${encodeURIComponent(JSON.stringify(proposal))}` };
  const page = makeForm();
  const preview = {
    ...previewBody,
    mode: "agent_proposal",
    execution: "pending_human_confirmation",
    model_provider: "not_proven",
    classification: { ...previewBody.classification, task_type: proposal.task_type, source: "structured_agent_proposal" },
    action: { operation: "create_workflow", batch_id: proposal.batch_id, user_goal: proposal.user_goal, task_type: proposal.task_type },
    confirmation_token: "signed-structured-token",
  };
  const ui = makePage({
    storage,
    form: page.form,
    location,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      return url.includes("preview") ? response(preview) : response({ id: "structured-workflow" });
    },
  });

  assert.equal(page.form.elements.batch_id.value, proposal.batch_id);
  assert.equal(page.form.elements.user_goal.value, proposal.user_goal);
  assert.match(ui.notice.textContent, /Agent提案，待确认/);
  assert.equal(requests.length, 0, "handoff must not preview or create automatically");
  await submit(page.form);
  assert.deepEqual(requests[0].body, {
    batch_id: proposal.batch_id,
    user_goal: proposal.user_goal,
    task_type: proposal.task_type,
  });
  assert.equal(ui.confirmButton.disabled, false);
  await confirm(ui);
  assert.equal(requests[1].body.user_goal, proposal.user_goal);
  assert.equal(requests[1].body.task_type, proposal.task_type);
  assert.equal(requests[1].body.confirmation_token, "signed-structured-token");
  assert.equal(requests[1].body.idempotency_key, "stable-key");
  assert.equal(location.href, "/workflow-tasks/structured-workflow");
}

async function testMalformedAndUnsupportedProposalHandoffsAreNotPrefilled() {
  for (const encoded of [
    encodeURIComponent("{not json"),
    encodeURIComponent(JSON.stringify({ version: 1, batch_id: "b", user_goal: "goal", task_type: "run_arbitrary_tool" })),
  ]) {
    const page = makeForm();
    const ui = makePage({
      storage: new MemoryStorage(), form: page.form, fetch: async () => response(previewBody),
      location: { href: "", hash: `#proposal=${encoded}` },
    });
    assert.equal(page.form.elements.batch_id.value, "");
    assert.equal(page.form.elements.user_goal.value, "");
    assert.match(ui.notice.textContent, /提案无效/);
  }
}

async function testProposalConflictRequiresExplicitLoadAndPreservesExistingDraft() {
  const storage = new MemoryStorage();
  const previous = {
    version: 2,
    activeKey: "previous-key",
    requests: [{ key: "previous-key", payload: { batch_id: "batch-old", user_goal: "旧草稿目标" }, preview: null, createAttempted: false }],
  };
  storage.setItem(storageKey, JSON.stringify(previous));
  const proposal = {
    version: 1, batch_id: "batch-new", user_goal: "Please prepare the catalog.", task_type: "generate_deliverables",
  };
  const page = makeForm();
  const ui = makePage({
    storage, form: page.form, fetch: async () => response(previewBody),
    location: { href: "", hash: `#proposal=${encodeURIComponent(JSON.stringify(proposal))}` },
  });
  assert.equal(page.form.elements.batch_id.value, "batch-old");
  assert.equal(page.form.elements.user_goal.value, "旧草稿目标");
  assert.equal(ui.loadProposalButton.hidden, false);
  assert.match(ui.notice.textContent, /已有未确认草稿/);
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)), previous);

  ui.loadProposalButton.dispatch();
  assert.equal(page.form.elements.batch_id.value, proposal.batch_id);
  assert.equal(page.form.elements.user_goal.value, proposal.user_goal);
  const saved = JSON.parse(storage.getItem(storageKey));
  assert.equal(saved.requests.length, 2);
  assert.equal(saved.requests[0].key, "previous-key");
  assert.equal(saved.requests[1].payload.task_type, proposal.task_type);
}

async function testExplicitlyPreservedDraftSurvivesSuccessfulAgentProposalAndReload() {
  const storage = new MemoryStorage();
  const oldDraft = {
    key: "old-unsubmitted-key",
    payload: { batch_id: "batch-old", user_goal: "旧草稿 A" },
    preview: null,
    createAttempted: false,
  };
  storage.setItem(storageKey, JSON.stringify({ version: 2, activeKey: oldDraft.key, requests: [oldDraft] }));
  const proposal = {
    version: 1, batch_id: "batch-new", user_goal: "Please prepare a clean catalog.", task_type: "generate_deliverables",
  };
  const requests = [];
  const location = { href: "", hash: `#proposal=${encodeURIComponent(JSON.stringify(proposal))}` };
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    return url.includes("preview")
      ? response({ ...previewBody, action: { ...previewBody.action, ...proposal }, confirmation_token: "proposal-token" })
      : response({ id: "workflow-proposal" });
  };
  const page = makeForm();
  const ui = makePage({ storage, form: page.form, fetch, location });
  ui.loadProposalButton.dispatch();
  await submit(page.form);
  await confirm(ui);

  assert.equal(requests[1].body.user_goal, proposal.user_goal);
  const afterCreate = JSON.parse(storage.getItem(storageKey));
  assert.ok(afterCreate.requests.some((item) => item.key === oldDraft.key));

  const reentered = makeForm();
  makePage({ storage, form: reentered.form, fetch, location: { href: "", hash: "" } });
  assert.equal(reentered.form.elements.batch_id.value, oldDraft.payload.batch_id);
  assert.equal(reentered.form.elements.user_goal.value, oldDraft.payload.user_goal);
}

function testUnknownStructuredCreateReloadKeepsRetryNoticeWithMatchingHandoff() {
  const storage = new MemoryStorage();
  const proposal = {
    version: 1, batch_id: "batch-unknown", user_goal: "Please prepare the catalog.", task_type: "generate_deliverables",
  };
  const payload = {
    batch_id: proposal.batch_id, user_goal: proposal.user_goal, task_type: proposal.task_type,
  };
  storage.setItem(storageKey, JSON.stringify({
    version: 2,
    activeKey: "unknown-structured-key",
    requests: [{
      key: "unknown-structured-key", payload,
      preview: { ...previewBody, action: { ...previewBody.action, ...payload }, confirmation_token: "frozen-token" },
      createAttempted: true,
    }],
  }));
  let fetchCount = 0;
  const page = makeForm();
  const ui = makePage({
    storage, form: page.form, fetch: async () => { fetchCount += 1; return response(previewBody); },
    location: { href: "", hash: `#proposal=${encodeURIComponent(JSON.stringify(proposal))}` },
  });
  assert.equal(fetchCount, 0);
  assert.equal(ui.confirmButton.disabled, false);
  assert.match(ui.notice.textContent, /结果未知的原创建请求/);
  assert.doesNotMatch(ui.notice.textContent, /刷新后预览已失效/);
}

async function testStructuredPreviewIsDiscardedAfterRefreshAndRecreatedBeforeConfirmation() {
  const storage = new MemoryStorage();
  const payload = {
    batch_id: "batch-structured",
    user_goal: "Please prepare the catalog.",
    task_type: "generate_deliverables",
  };
  storage.setItem(storageKey, JSON.stringify({
    version: 2,
    activeKey: "proposal-key",
    requests: [{ key: "proposal-key", payload, preview: { ...previewBody, confirmation_token: "stale-token" }, createAttempted: false }],
  }));
  const requests = [];
  const page = makeForm();
  const ui = makePage({
    storage,
    form: page.form,
    location: { href: "", hash: "" },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      return url.includes("preview")
        ? response({ ...previewBody, action: { ...previewBody.action, ...payload }, confirmation_token: "fresh-token" })
        : response({ id: "workflow-after-refresh" });
    },
  });

  assert.equal(ui.confirmButton.disabled, true);
  assert.equal(ui.confirmButton.hidden, true);
  assert.match(ui.notice.textContent, /刷新后预览已失效/);
  assert.equal(page.form.elements.batch_id.value, payload.batch_id);
  assert.equal(page.form.elements.user_goal.value, payload.user_goal);
  await submit(page.form);
  assert.deepEqual(requests[0].body, payload);
  await confirm(ui);
  assert.equal(requests[1].body.task_type, payload.task_type);
  assert.equal(requests[1].body.confirmation_token, "fresh-token");
}

(async () => {
  await testPreviewMustBeFollowedByExplicitConfirmation();
  await testPreviewFailureNeverCallsCreate();
  await testUnknownCreateResultReloadKeepsSameTokenAndKey();
  await testEditThenRestoreReusesTheOriginalConfirmation();
  await testReparseBeforeCreateRequestsAFreshPreview();
  await testPreviewResponseAfterEditCannotBeConfirmed();
  await testKnownInvalidTokenAllowsExplicitReparseWithNewKey();
  await testUnsubmittedDraftRestoreSaysCreationWasNotSubmitted();
  await testSuccessfulNewRequestKeepsOtherUnknownRequestForRetry();
  await testStructuredProposalHandoffReachesExistingPreviewAndExplicitCreate();
  await testMalformedAndUnsupportedProposalHandoffsAreNotPrefilled();
  await testProposalConflictRequiresExplicitLoadAndPreservesExistingDraft();
  testUnknownStructuredCreateReloadKeepsRetryNoticeWithMatchingHandoff();
  await testExplicitlyPreservedDraftSurvivesSuccessfulAgentProposalAndReload();
  await testStructuredPreviewIsDiscardedAfterRefreshAndRecreatedBeforeConfirmation();
  process.stdout.write("workflow-create browser logic: 15 cases passed\n");
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
