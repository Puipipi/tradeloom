const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWorkflowGraph } = require("../static/workbench/workflow-graph.js");

test("uses persisted subtask IDs for dependency edges and attaches saved step attempts", () => {
  const graph = buildWorkflowGraph({
    plan: [
      { key: "product_profile", order: 1, agent_role: "product_profile", role_label: "产品资料整理", depends_on: [] },
      { key: "delivery_quality", order: 2, agent_role: "delivery_quality", role_label: "交付质检", depends_on: ["product_profile"] },
    ],
    subtasks: [
      { id: "sub-1", agent_role: "product_profile", status: "completed", status_label: "已完成", depends_on: [] },
      { id: "sub-2", agent_role: "delivery_quality", status: "queued", status_label: "排队中", depends_on: ["sub-1"] },
    ],
    steps: [
      { id: "step-1", step_key: "subtask:sub-1", attempt: 1, input_refs: { subtask_id: "sub-1" } },
      { id: "step-2", step_key: "subtask:sub-2", attempt: 2, input_refs: { subtask_id: "sub-2" } },
    ],
  });

  assert.deepEqual(graph.edges, [
    { from: "sub-1", to: "sub-2", kind: "dependency" },
    { from: "sub-1", to: "step:step-1", kind: "execution" },
    { from: "sub-2", to: "step:step-2", kind: "execution" },
  ]);
  assert.equal(graph.nodes.find((node) => node.id === "sub-1").steps.length, 1);
  assert.equal(graph.nodes.find((node) => node.id === "sub-2").latestStep.id, "step-2");
  assert.deepEqual(graph.missingDependencies, []);
  assert.deepEqual(graph.cycleOrBlockedIds, []);
});

test("keeps saved plan-only nodes and reports unmatched dependency references", () => {
  const graph = buildWorkflowGraph({
    plan: [
      { key: "profile", order: 1, agent_role: "product_profile", role_label: "资料整理", depends_on: [] },
      { key: "quality", order: 2, agent_role: "delivery_quality", role_label: "交付质检", depends_on: ["missing-role"] },
    ],
    subtasks: [],
    steps: [],
  });

  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].status, "planned");
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.missingDependencies, [{ nodeId: "plan:quality", dependency: "missing-role" }]);
});

test("detects cycles and self-dependencies without inventing a runnable order", () => {
  const graph = buildWorkflowGraph({
    plan: [],
    subtasks: [
      { id: "a", agent_role: "a", status: "queued", depends_on: ["b"] },
      { id: "b", agent_role: "b", status: "queued", depends_on: ["a"] },
      { id: "c", agent_role: "c", status: "queued", depends_on: ["c"] },
    ],
    steps: [],
  });

  assert.equal(graph.edges.length, 3);
  assert.deepEqual(new Set(graph.cycleOrBlockedIds), new Set(["a", "b", "c"]));
  assert.ok(graph.nodes.every((node) => node.level === 0));
});

test("adds only review and artifact nodes connected by persisted references", () => {
  const graph = buildWorkflowGraph({
    plan: [
      {
        key: "product_profile", order: 1, agent_role: "product_profile",
        role_label: "产品资料整理", depends_on: [], input_refs: { product_ids: ["product-1"] },
        required_fields: ["name"], input_schema: { type: "object", required: ["product_ids"] },
        output_schema: { type: "object" },
      },
    ],
    subtasks: [
      { id: "sub-1", agent_role: "product_profile", status: "waiting_human", status_label: "等待人工确认", depends_on: [], input_refs: { product_ids: ["product-1"] }, output_refs: { result: { status: "needs_human" } } },
    ],
    steps: [
      { id: "step-1", step_key: "subtask:sub-1", attempt: 1, status: "waiting_human", input_refs: { subtask_id: "sub-1" }, output_refs: { result_snapshot: { status: "needs_human" } } },
      { id: "generation-1", step_key: "generate_deliverables", attempt: 1, status: "completed", input_refs: {}, output_refs: { artifact_version_ids: ["version-1"] } },
      { id: "generation-old", step_key: "generate_deliverables", attempt: 1, status: "completed", input_refs: {}, output_refs: { artifact_version_ids: ["version-old"] } },
    ],
    reviews: [
      { id: "review-1", item_ref: "product:product-1", status: "pending", status_label: "待处理", subtask_id: "sub-1", origin_step_id: "step-1", result_ref: "workflow_step:step-1:output_refs.result_snapshot", source_refs: { product_id: "product-1" }, ui_kind: "literal", ui_supported: true },
      { id: "review-unlinked", item_ref: "product:other", status: "pending", status_label: "待处理", subtask_id: "missing", origin_step_id: "missing-step", source_refs: {}, ui_kind: "note", ui_supported: false },
    ],
    artifacts: [
      { id: "artifact-1", artifact_type: "catalog_html", status: "approved", current_version: 1, versions: [{ id: "version-1", version: 1, status: "approved", preview_url: "/preview/1", download_url: "/download/1" }] },
      { id: "artifact-old", artifact_type: "catalog_html", status: "approved", current_version: 2, versions: [
        { id: "version-old", version: 1, status: "superseded", preview_url: "/preview/old", download_url: "/download/old" },
        { id: "version-current", version: 2, status: "approved", preview_url: "/preview/current", download_url: "/download/current" },
      ] },
      { id: "artifact-unlinked", artifact_type: "quality_report_json", status: "draft", current_version: 0, versions: [] },
    ],
    dispatchTarget: { subtask_id: "sub-1" },
  });

  const review = graph.nodes.find((node) => node.id === "review:review-1");
  const artifact = graph.nodes.find((node) => node.id === "artifact:artifact-1");
  const plan = graph.nodes.find((node) => node.id === "sub-1");
  assert.equal(review.kind, "review");
  assert.equal(artifact.kind, "artifact");
  assert.equal(artifact.currentVersion.id, "version-1");
  assert.equal(plan.canDispatch, true);
  assert.deepEqual(graph.edges, [
    { from: "sub-1", to: "step:step-1", kind: "execution" },
    { from: "step:step-1", to: "review:review-1", kind: "review-source" },
    { from: "step:generation-1", to: "artifact:artifact-1", kind: "artifact-output" },
  ]);
  assert.equal(graph.edges.some((edge) => edge.from === "step:generation-old" && edge.to === "artifact:artifact-old"), false);
  assert.equal(graph.nodes.some((node) => node.id === "review:review-unlinked"), true);
  assert.equal(graph.edges.some((edge) => edge.to.includes("unlinked")), false);
});
