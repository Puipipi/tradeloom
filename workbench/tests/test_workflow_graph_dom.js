const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jsdomModule = process.env.TRADELOOM_DOM_MODULE || "jsdom";
const { JSDOM } = require(jsdomModule);

const scriptPath = path.resolve(__dirname, "../static/workbench/workflow-graph.js");
const graphSource = fs.readFileSync(scriptPath, "utf8");

function fixture() {
  const plan = [
    { key: "profile", order: 1, agent_role: "product_profile", role_label: "产品资料整理", depends_on: [], input_refs: { product_ids: ["product-1"] }, required_fields: ["name"], input_schema: { type: "object", required: ["product_ids"] }, output_schema: { type: "object" } },
    { key: "quality", order: 2, agent_role: "delivery_quality", role_label: "交付质检", depends_on: ["product_profile"], required_fields: ["all_products_confirmed"] },
  ];
  const subtasks = [
    { id: "sub-profile", agent_role: "product_profile", role_label: "产品资料整理", status: "completed", status_label: "已完成", depends_on: [] },
    { id: "sub-quality", agent_role: "delivery_quality", role_label: "交付质检", status: "queued", status_label: "排队中", depends_on: ["sub-profile"] },
  ];
  const steps = [
    { id: "step-quality", step_key: "subtask:sub-quality", step_label: "交付质检", status: "queued", status_label: "排队中", attempt: 1, input_refs: { subtask_id: "sub-quality" } },
  ];
  const reviews = [
    { id: "review-1", item_ref: "product:product-1", status: "pending", status_label: "待处理", question: "请核对中文名称", options: [], subtask_id: "sub-profile", origin_step_id: "step-profile", result_ref: "workflow_step:step-profile:output_refs.result_snapshot", source_refs: { product_id: "product-1" }, ui_kind: "literal", ui_supported: true },
  ];
  const artifacts = [
    { id: "artifact-1", artifact_type: "catalog_html", status: "approved", status_label: "已批准", current_version: 2, versions: [
      { id: "version-1", version: 1, status: "superseded", status_label: "已替代", preview_url: "/preview/1", download_url: "/download/1" },
      { id: "version-2", version: 2, status: "approved", status_label: "已批准", preview_url: "/preview/2", download_url: "/download/2" },
    ] },
  ];
  const scriptTag = (id, value) => `<script type="application/json" id="${id}">${JSON.stringify(value)}</script>`;
  const html = `<!doctype html><html><body>
    <div data-workflow-graph data-create-href="/agent-center#workflow-create-form">
      ${scriptTag("workflow-plan-graph-data", plan)}
      ${scriptTag("workflow-subtasks-graph-data", subtasks)}
      ${scriptTag("workflow-steps-graph-data", steps)}
      ${scriptTag("workflow-reviews-graph-data", reviews)}
      ${scriptTag("workflow-artifacts-graph-data", artifacts)}
      ${scriptTag("workflow-dispatch-graph-data", { subtask_id: "sub-quality" })}
      <div data-graph-stage tabindex="0"><div data-graph-world><svg data-graph-edges></svg><div data-graph-nodes></div></div></div>
      <aside data-graph-details></aside><div data-graph-list hidden></div><p data-graph-bridge-status hidden></p>
      <button data-graph-mode="graph" aria-pressed="true"></button><button data-graph-mode="list" aria-pressed="false"></button>
      <button data-graph-action="fit"></button><button data-graph-action="arrange"></button><button data-graph-action="zoom-out"></button><output data-graph-zoom></output><button data-graph-action="zoom-in"></button>
      <p data-graph-notice hidden></p><span data-graph-count></span>
      <dialog data-graph-review-dialog><div><h2 data-graph-review-title></h2><div data-graph-review-body></div><button type="button" data-graph-review-close>关闭</button></div></dialog>
    </div>
    <form id="workflow-dispatch-form" class="workflow-dispatch-form"><button type="submit">执行下一步</button></form>
    <details><article id="review-review-1"><p>请核对中文名称并填写结果。</p><form class="review-note-form"><label for="review-note-1">补充说明</label><textarea id="review-note-1" name="note" required>已有草稿</textarea><input name="reviewer" required><button type="submit">提交人审</button></form></article></details>
  </body></html>`;
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: "outside-only", url: "http://localhost/workflow-tasks/w1" });
  dom.window.eval(graphSource);
  const root = dom.window.document.querySelector("[data-workflow-graph]");
  dom.window.TradeloomWorkflowGraph.initGraph(root);
  return { dom, root };
}

test("graph/list controls, node selection, keyboard, and fit/zoom/arrange leave business forms untouched", async () => {
  const { dom, root } = fixture();
  const { document, KeyboardEvent } = dom.window;
  const stage = root.querySelector("[data-graph-stage]");
  const list = root.querySelector("[data-graph-list]");
  const detail = root.querySelector("[data-graph-details]");
  const businessForm = document.querySelector(".workflow-dispatch-form");
  let businessSubmits = 0;
  businessForm.addEventListener("submit", (event) => { event.preventDefault(); businessSubmits += 1; });

  assert.equal(stage.hidden, false);
  assert.equal(list.hidden, true);
  root.querySelector('[data-graph-mode="list"]').click();
  assert.equal(stage.hidden, true);
  assert.equal(list.hidden, false);

  list.querySelector("button").click();
  assert.equal(stage.hidden, false);
  assert.equal(list.hidden, true);
  assert.match(detail.textContent, /产品资料整理/);

  const firstNode = root.querySelector('.workflow-graph-node[data-node-id="sub-profile"]');
  const secondNode = root.querySelector('.workflow-graph-node[data-node-id="sub-quality"]');
  firstNode.click();
  stage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(secondNode.classList.contains("is-selected"), true);
  assert.match(detail.textContent, /查看子任务记录|交付质检/);
  assert.equal(detail.querySelector('a[href="#workflow-dispatch-form"]')?.dataset.actionKind, "dispatch");
  detail.querySelector('a[href="#workflow-dispatch-form"]').click();

  const zoom = root.querySelector("[data-graph-zoom]");
  await new Promise((resolve) => setTimeout(resolve, 30));
  root.querySelector('[data-graph-action="fit"]').click();
  const fitScale = zoom.textContent;
  root.querySelector('[data-graph-action="zoom-out"]').click();
  assert.equal(zoom.textContent, fitScale, "zoom out does not jump back up from fit's minimum");
  stage.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
  assert.equal(zoom.textContent, fitScale, "wheel zoom shares the same lower bound");
  root.querySelector('[data-graph-action="zoom-in"]').click();
  assert.notEqual(zoom.textContent, fitScale);
  root.querySelector('[data-graph-action="arrange"]').click();
  assert.equal(businessSubmits, 0);
  assert.equal(document.querySelectorAll(".workflow-dispatch-form").length, 1);
  dom.window.close();
});

test("inspects schema, moves the original review form into an editor dialog, and requests current artifacts", () => {
  const { dom, root } = fixture();
  const messages = [];
  Object.defineProperty(dom.window, "parent", { configurable: true, value: { postMessage: (message, origin) => messages.push({ message, origin }) } });
  let submits = 0;
  for (const form of dom.window.document.querySelectorAll("form")) {
    form.addEventListener("submit", (event) => { event.preventDefault(); submits += 1; });
  }
  const profile = root.querySelector('.workflow-graph-node[data-node-id="sub-profile"]');
  profile.click();
  assert.match(root.querySelector("[data-graph-details]").textContent, /所需字段/);
  assert.match(root.querySelector("[data-graph-details]").textContent, /product_ids/);
  assert.match(root.querySelector("[data-graph-details]").textContent, /输入字段结构/);

  const review = root.querySelector('.workflow-graph-node[data-node-id="review:review-1"]');
  review.click();
  const reviewButton = root.querySelector("[data-graph-open-review]");
  assert.ok(reviewButton);
  const article = dom.window.document.querySelector("#review-review-1");
  const originalParent = article.parentElement;
  const originalForm = article.querySelector(".review-note-form");
  const note = originalForm.elements.note;
  note.value = "画布内正在填写";
  let preservedListenerCalls = 0;
  originalForm.addEventListener("review-editor-probe", () => { preservedListenerCalls += 1; });
  reviewButton.click();
  const dialog = root.querySelector("[data-graph-review-dialog]");
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector("#review-review-1"), article);
  assert.equal(dialog.querySelector(".review-note-form"), originalForm);
  assert.match(dialog.textContent, /请核对中文名称并填写结果/);
  assert.equal(dialog.querySelector('button[type="submit"]').textContent, "提交人审");
  assert.ok(dialog.querySelector("[data-graph-review-close]"));
  assert.equal(submits, 0, "opening the editor does not submit the existing form");
  dialog.querySelector("[data-graph-review-close]").click();
  assert.equal(dialog.open, false);
  assert.equal(article.parentElement, originalParent);
  assert.equal(article.querySelector(".review-note-form"), originalForm);
  assert.equal(note.value, "画布内正在填写", "closing the editor preserves entered text");
  assert.equal(originalParent.closest("details").open, false, "the original disclosure state is restored");
  assert.equal(dom.window.document.activeElement, reviewButton, "closing returns focus to the graph action");
  originalForm.dispatchEvent(new dom.window.Event("review-editor-probe"));
  assert.equal(preservedListenerCalls, 1, "moving the original form keeps its event listeners");
  reviewButton.click();
  dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(dialog.open, false, "Escape closes the editor");
  assert.equal(article.parentElement, originalParent);

  const artifact = root.querySelector('.workflow-graph-node[data-node-id="artifact:artifact-1"]');
  artifact.click();
  assert.match(root.querySelector("[data-graph-details]").textContent, /v2/);
  const historicalPreview = [...root.querySelectorAll("[data-graph-details] a")].find((link) => link.textContent === "直接预览此版本" && link.href.endsWith("/preview/1"));
  assert.ok(historicalPreview, "historical version remains an explicit direct link");
  assert.equal(historicalPreview.hasAttribute("data-graph-preview"), false);
  root.querySelector("[data-graph-preview]").click();
  assert.equal(JSON.stringify(messages.at(-1).message), JSON.stringify({ type: "tradeloom:file-selection", kind: "artifact", id: "artifact-1" }));
  assert.equal(messages.at(-1).origin, dom.window.location.origin);
  assert.equal(submits, 0);
  dom.window.close();
});

test("density changes resize graph geometry without rebuilding selection, details, or canvas transform", async () => {
  const { dom, root } = fixture();
  const { document, MouseEvent } = dom.window;
  const stage = root.querySelector("[data-graph-stage]");
  const world = root.querySelector("[data-graph-world]");
  const selected = root.querySelector('.workflow-graph-node[data-node-id="sub-profile"]');
  selected.click();
  const detail = root.querySelector("[data-graph-details]");
  const originalDetailChild = detail.firstElementChild;
  root.querySelector('[data-graph-action="zoom-in"]').click();
  const viewScale = Number.parseFloat(root.querySelector("[data-graph-zoom]").textContent) / 100;
  const originalTransform = world.style.transform;
  const originalEdge = root.querySelector("[data-graph-edges] path.workflow-graph-edge")?.getAttribute("d");

  assert.equal(selected.style.width, "224px");
  assert.equal(selected.style.height, "148px");
  const originalLeft = Number.parseFloat(selected.style.left);
  const originalTop = Number.parseFloat(selected.style.top);

  selected.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 30, clientY: 30 }));
  selected.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 45 }));
  selected.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 50, clientY: 45 }));
  const draggedLeft = Number.parseFloat(selected.style.left);
  const draggedTop = Number.parseFloat(selected.style.top);
  assert.notEqual(draggedLeft, originalLeft);
  assert.notEqual(draggedTop, originalTop);

  document.documentElement.style.setProperty("--wb-ui-scale", String(16 / 14));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(selected.isConnected, true);
  assert.equal(selected.classList.contains("is-selected"), true);
  assert.equal(detail.firstElementChild, originalDetailChild);
  assert.equal(world.style.transform, originalTransform);
  assert.ok(Math.abs(Number.parseFloat(selected.style.width) - 224 * (16 / 14)) < 0.02);
  assert.ok(Math.abs(Number.parseFloat(selected.style.height) - 148 * (16 / 14)) < 0.02);
  assert.ok(Math.abs(Number.parseFloat(selected.style.left) - draggedLeft * (16 / 14)) < 0.02);
  assert.ok(Math.abs(Number.parseFloat(selected.style.top) - draggedTop * (16 / 14)) < 0.02);
  assert.notEqual(root.querySelector("[data-graph-edges] path.workflow-graph-edge")?.getAttribute("d"), originalEdge);

  const beforeScaledDrag = { left: Number.parseFloat(selected.style.left), top: Number.parseFloat(selected.style.top) };
  selected.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 70, clientY: 70 }));
  selected.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 90, clientY: 85 }));
  selected.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 90, clientY: 85 }));
  const afterScaledDrag = { left: Number.parseFloat(selected.style.left), top: Number.parseFloat(selected.style.top) };
  const edgeAfterScaledDrag = root.querySelector("[data-graph-edges] path.workflow-graph-edge")?.getAttribute("d");
  assert.ok(Math.abs(afterScaledDrag.left - beforeScaledDrag.left - 20 / viewScale) < 0.02);
  assert.ok(Math.abs(afterScaledDrag.top - beforeScaledDrag.top - 15 / viewScale) < 0.02);

  document.documentElement.style.setProperty("--wb-ui-scale", "1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(selected.style.width, "224px");
  assert.equal(selected.style.height, "148px");
  assert.ok(Math.abs(Number.parseFloat(selected.style.left) - afterScaledDrag.left / (16 / 14)) < 0.02);
  assert.ok(Math.abs(Number.parseFloat(selected.style.top) - afterScaledDrag.top / (16 / 14)) < 0.02);
  assert.notEqual(root.querySelector("[data-graph-edges] path.workflow-graph-edge")?.getAttribute("d"), edgeAfterScaledDrag);
  assert.equal(world.style.transform, originalTransform);
  assert.equal(detail.firstElementChild, originalDetailChild);
  dom.window.close();
});
