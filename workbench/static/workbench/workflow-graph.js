(function (root) {
  "use strict";

  const STATUS_LABELS = {
    queued: "排队中",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    interrupted: "已中断",
    waiting_human: "等待人工确认",
    pending: "待处理",
    submitted: "已提交",
    approved: "已批准",
    rejected: "已驳回",
  };

  function array(value) {
    return Array.isArray(value) ? value : [];
  }

  function text(value, fallback) {
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  function buildWorkflowGraph(input) {
    const plan = array(input && input.plan);
    const subtasks = array(input && input.subtasks);
    const steps = array(input && input.steps);
    const reviews = array(input && input.reviews);
    const artifacts = array(input && input.artifacts);
    const dispatchTarget = input && input.dispatchTarget && typeof input.dispatchTarget === "object"
      ? input.dispatchTarget : {};
    const subtaskByRole = new Map();
    const planByReference = new Map();
    const nodes = [];
    const nodesById = new Map();
    const edges = [];
    const edgeKeys = new Set();

    for (const subtask of subtasks) {
      if (!subtask || typeof subtask !== "object") continue;
      const role = text(subtask.agent_role, "");
      if (role && !subtaskByRole.has(role)) subtaskByRole.set(role, subtask);
    }
    for (const item of plan) {
      if (!item || typeof item !== "object") continue;
      for (const key of [item.key, item.agent_role]) {
        if (typeof key === "string" && key && !planByReference.has(key)) planByReference.set(key, item);
      }
    }

    const addNode = (node) => {
      if (!node.id || nodesById.has(node.id)) return nodesById.get(node.id);
      node.steps = node.steps || [];
      nodes.push(node);
      nodesById.set(node.id, node);
      return node;
    };

    const addEdge = (from, to, kind) => {
      if (!from || !to || (from === to && kind !== "dependency") || !nodesById.has(from) || !nodesById.has(to)) return;
      const key = `${from}\u0000${to}\u0000${kind}`;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({ from, to, kind });
    };

    for (let index = 0; index < plan.length; index += 1) {
      const item = plan[index];
      if (!item || typeof item !== "object") continue;
      const role = text(item.agent_role, text(item.key, ""));
      const saved = subtaskByRole.get(role) || subtasks.find((row) => row && row.agent_role === role);
      const id = saved && saved.id ? String(saved.id) : `plan:${text(item.key, role || index + 1)}`;
      const node = addNode({
        id,
        kind: saved ? "subtask" : "plan",
        key: text(item.key, role || id),
        role,
        label: text(item.role_label, role || "计划项"),
        status: saved ? text(saved.status, "unknown") : "planned",
        statusLabel: saved ? text(saved.status_label, STATUS_LABELS[saved.status] || saved.status || "状态未知") : "计划已保存",
        subtaskId: saved && saved.id ? String(saved.id) : "",
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : index + 1,
        dependencies: saved ? array(saved.depends_on).map(String) : array(item.depends_on).map(String),
        dependencyKind: saved ? "id" : "key",
        error: saved ? text(saved.error_summary, "") : "",
        inputRefs: saved && saved.input_refs && typeof saved.input_refs === "object" ? saved.input_refs : (item.input_refs || {}),
        outputRefs: saved && saved.output_refs && typeof saved.output_refs === "object" ? saved.output_refs : {},
        requiredFields: array(item.required_fields),
        inputSchema: item.input_schema && typeof item.input_schema === "object" ? item.input_schema : {},
        outputSchema: item.output_schema && typeof item.output_schema === "object" ? item.output_schema : {},
        planItem: item,
        subtask: saved || null,
        canDispatch: Boolean(saved && saved.id && dispatchTarget.subtask_id === saved.id),
      });
      if (node) {
        for (const reference of [node.id, node.key, node.role]) {
          if (reference && !planByReference.has(reference)) planByReference.set(reference, node);
        }
      }
    }

    for (let index = 0; index < subtasks.length; index += 1) {
      const subtask = subtasks[index];
      if (!subtask || typeof subtask !== "object" || !subtask.id) continue;
      const existing = nodesById.get(String(subtask.id));
      if (existing) continue;
      const planItem = planByReference.get(subtask.agent_role);
      addNode({
        id: String(subtask.id),
        kind: "subtask",
        key: text(subtask.agent_role, String(subtask.id)),
        role: text(subtask.agent_role, ""),
        label: text(subtask.role_label, text(subtask.agent_role, "子任务")),
        status: text(subtask.status, "unknown"),
        statusLabel: text(subtask.status_label, STATUS_LABELS[subtask.status] || subtask.status || "状态未知"),
        subtaskId: String(subtask.id),
        order: planItem && Number.isFinite(Number(planItem.order)) ? Number(planItem.order) : plan.length + index + 1,
        dependencies: array(subtask.depends_on).map(String),
        dependencyKind: "id",
        error: text(subtask.error_summary, ""),
        inputRefs: subtask.input_refs && typeof subtask.input_refs === "object" ? subtask.input_refs : {},
        outputRefs: subtask.output_refs && typeof subtask.output_refs === "object" ? subtask.output_refs : {},
        requiredFields: array(planItem && planItem.required_fields),
        inputSchema: planItem && planItem.input_schema || {},
        outputSchema: planItem && planItem.output_schema || {},
        planItem: planItem || null,
        subtask,
        canDispatch: dispatchTarget.subtask_id === subtask.id,
      });
    }

    const nodeByReference = new Map();
    for (const node of nodes) {
      nodeByReference.set(node.id, node);
      if (node.key) nodeByReference.set(node.key, node);
      if (node.role && !nodeByReference.has(node.role)) nodeByReference.set(node.role, node);
    }

    // Plan dependency edges are rendered only from the saved plan/subtask refs.
    for (const node of nodes) {
      if (!(["plan", "subtask"].includes(node.kind))) continue;
      for (const dependency of node.dependencies) {
        const parent = nodeByReference.get(dependency);
        if (!parent) continue;
        addEdge(parent.id, node.id, "dependency");
      }
    }

    const stepById = new Map();
    const stepNodeById = new Map();
    for (const step of steps) {
      if (!step || typeof step !== "object" || !step.id) continue;
      const refs = step.input_refs && typeof step.input_refs === "object" ? step.input_refs : {};
      const isSubtaskStep = typeof refs.subtask_id === "string" && nodesById.has(refs.subtask_id);
      const include = isSubtaskStep || ["generate_deliverables", "apply_review_cycle"].includes(step.step_key);
      stepById.set(String(step.id), step);
      if (!include) continue;
      const node = addNode({
        id: `step:${step.id}`,
        recordId: String(step.id),
        kind: "execution",
        stepKey: text(step.step_key, "workflow_step"),
        label: isSubtaskStep
          ? `${nodesById.get(refs.subtask_id).label} · 第 ${Number(step.attempt) || 1} 次执行`
          : ({ generate_deliverables: "生成交付文件", apply_review_cycle: "应用并确认本批资料" }[step.step_key] || "工作流步骤"),
        status: text(step.status, "unknown"),
        statusLabel: text(step.status_label, STATUS_LABELS[step.status] || step.status || "状态未知"),
        order: (nodesById.get(refs.subtask_id)?.order || 0) * 100 + (Number(step.attempt) || 1),
        attempt: Number(step.attempt) || 1,
        inputRefs: refs,
        outputRefs: step.output_refs && typeof step.output_refs === "object" ? step.output_refs : {},
        error: text(step.error_summary, ""),
        step,
        retryAvailable: step.retry_available === true,
        interruptAvailable: step.interrupt_available === true,
        retryHref: step.retry_available === true ? `#workflow-step-${encodeURIComponent(step.id)}` : "",
        interruptHref: step.interrupt_available === true ? `#workflow-step-${encodeURIComponent(step.id)}` : "",
      });
      if (node) {
        stepNodeById.set(String(step.id), node);
        if (isSubtaskStep) addEdge(refs.subtask_id, node.id, "execution");
      }
      if (isSubtaskStep) {
        const parent = nodesById.get(refs.subtask_id);
        if (parent) parent.steps.push(step);
      }
    }

    for (const node of nodes) {
      node.steps.sort((left, right) => (Number(left.attempt) || 0) - (Number(right.attempt) || 0));
      node.latestStep = node.steps.length ? node.steps[node.steps.length - 1] : null;
    }

    for (const review of reviews) {
      if (!review || typeof review !== "object" || !review.id) continue;
      const node = addNode({
        id: `review:${review.id}`,
        recordId: String(review.id),
        kind: "review",
        label: text(review.item_ref, "业务核验事项"),
        status: text(review.status, "unknown"),
        statusLabel: text(review.status_label, STATUS_LABELS[review.status] || review.status || "状态未知"),
        order: nodes.length + 1,
        question: text(review.question, ""),
        options: array(review.options),
        sourceRefs: review.source_refs && typeof review.source_refs === "object" ? review.source_refs : {},
        subtaskId: text(review.subtask_id, ""),
        originStepId: text(review.origin_step_id, ""),
        resultRef: text(review.result_ref, ""),
        uiKind: text(review.ui_kind, "note"),
        uiSupported: review.ui_supported === true,
        uiApplied: review.ui_applied === true,
        review,
        openHref: `#review-${encodeURIComponent(review.id)}`,
      });
      if (!node) continue;
      const origin = node.originStepId ? stepNodeById.get(node.originStepId) : null;
      const sourceStep = origin && stepById.get(node.originStepId);
      const sourceStepSubtaskId = sourceStep && sourceStep.input_refs && sourceStep.input_refs.subtask_id;
      if (origin && node.subtaskId && sourceStepSubtaskId === node.subtaskId) {
        addEdge(origin.id, node.id, "review-source");
      } else if (!node.originStepId && node.subtaskId && nodesById.has(node.subtaskId)) {
        addEdge(node.subtaskId, node.id, "review-source");
      }
    }

    // Join review nodes to application-cycle steps only through their saved review IDs.
    for (const node of nodes) {
      if (node.kind !== "execution" || node.stepKey !== "apply_review_cycle") continue;
      const refs = node.inputRefs || {};
      const reviewIds = [...array(refs.review_ids), ...array(node.outputRefs && node.outputRefs.review_ids)].map(String);
      for (const reviewId of new Set(reviewIds)) {
        const reviewNode = nodesById.get(`review:${reviewId}`);
        if (reviewNode) addEdge(reviewNode.id, node.id, "review-applied");
      }
    }

    const artifactByVersion = new Map();
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== "object" || !artifact.id) continue;
      const versions = array(artifact.versions).filter((version) => version && typeof version === "object");
      const currentVersion = versions.find((version) => Number(version.version) === Number(artifact.current_version)) || null;
      const node = addNode({
        id: `artifact:${artifact.id}`,
        recordId: String(artifact.id),
        kind: "artifact",
        label: text(artifact.artifact_type_label, text(artifact.artifact_type, "交付文件")),
        artifactType: text(artifact.artifact_type, ""),
        status: text(artifact.status, "unknown"),
        statusLabel: text(artifact.status_label, STATUS_LABELS[artifact.status] || artifact.status || "状态未知"),
        order: nodes.length + 1,
        currentVersion,
        versions,
        previewSupported: Boolean(currentVersion && currentVersion.preview_url),
        artifact,
      });
      // The shell bridge opens an Artifact's current version by Artifact.id.
      // Keep only that version addressable from graph edges; historical versions
      // remain explicit direct links in the inspector and never masquerade as current.
      if (currentVersion && currentVersion.id) artifactByVersion.set(String(currentVersion.id), node);
    }
    for (const node of nodes) {
      if (node.kind !== "execution" || node.stepKey !== "generate_deliverables") continue;
      for (const versionId of array(node.outputRefs && node.outputRefs.artifact_version_ids).map(String)) {
        const artifact = artifactByVersion.get(versionId);
        if (artifact) addEdge(node.id, artifact.id, "artifact-output");
      }
    }

    const missingDependencies = [];
    for (const node of nodes) {
      if (!["plan", "subtask"].includes(node.kind)) continue;
      for (const dependency of node.dependencies) {
        if (!nodeByReference.has(dependency)) missingDependencies.push({ nodeId: node.id, dependency });
      }
    }

    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of edges) {
      indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
      outgoing.get(edge.from).push(edge.to);
    }
    const ready = nodes.filter((node) => indegree.get(node.id) === 0).sort((a, b) => a.order - b.order);
    const levels = new Map();
    while (ready.length) {
      const current = ready.shift();
      const level = levels.get(current.id) || 0;
      for (const targetId of outgoing.get(current.id) || []) {
        levels.set(targetId, Math.max(levels.get(targetId) || 0, level + 1));
        indegree.set(targetId, indegree.get(targetId) - 1);
        if (indegree.get(targetId) === 0) {
          ready.push(nodesById.get(targetId));
          ready.sort((a, b) => a.order - b.order);
        }
      }
    }
    const cycleOrBlockedIds = nodes.filter((node) => indegree.get(node.id) > 0).map((node) => node.id);
    if (cycleOrBlockedIds.length) {
      nodes.sort((a, b) => a.order - b.order);
      nodes.forEach((node, index) => { node.level = 0; node.row = index; });
    } else {
      const groups = new Map();
      for (const node of nodes) {
        node.level = levels.get(node.id) || 0;
        if (!groups.has(node.level)) groups.set(node.level, []);
        groups.get(node.level).push(node);
      }
      for (const group of groups.values()) {
        group.sort((a, b) => a.order - b.order);
        group.forEach((node, index) => { node.row = index; });
      }
    }

    return {
      nodes, edges, missingDependencies, cycleOrBlockedIds,
      stepCount: steps.length,
      counts: {
        plan: nodes.filter((node) => ["plan", "subtask"].includes(node.kind)).length,
        running: nodes.filter((node) => node.status === "running").length,
        failed: nodes.filter((node) => node.status === "failed").length,
        reviews: nodes.filter((node) => node.kind === "review").length,
        artifacts: nodes.filter((node) => node.kind === "artifact").length,
      },
    };
  }

  function readJson(id) {
    const element = document.getElementById(id);
    if (!element) return [];
    try { return JSON.parse(element.textContent || "[]"); } catch (_) { return []; }
  }

  function initGraph(rootElement) {
    if (rootElement.dataset.graphInitialized === "true") return;
    rootElement.dataset.graphInitialized = "true";
    const data = buildWorkflowGraph({
      plan: readJson("workflow-plan-graph-data"),
      subtasks: readJson("workflow-subtasks-graph-data"),
      steps: readJson("workflow-steps-graph-data"),
      reviews: readJson("workflow-reviews-graph-data"),
      artifacts: readJson("workflow-artifacts-graph-data"),
      dispatchTarget: readJson("workflow-dispatch-graph-data"),
    });
    const stage = rootElement.querySelector("[data-graph-stage]");
    const world = rootElement.querySelector("[data-graph-world]");
    const nodesHost = rootElement.querySelector("[data-graph-nodes]");
    const edgesSvg = rootElement.querySelector("[data-graph-edges]");
    const details = rootElement.querySelector("[data-graph-details]");
    const list = rootElement.querySelector("[data-graph-list]");
    const notice = rootElement.querySelector("[data-graph-notice]");
    const zoomOutput = rootElement.querySelector("[data-graph-zoom]");
    const count = rootElement.querySelector("[data-graph-count]");
    const bridgeStatus = rootElement.querySelector("[data-graph-bridge-status]");
    const reviewDialog = rootElement.querySelector("[data-graph-review-dialog]");
    const reviewDialogTitle = rootElement.querySelector("[data-graph-review-title]");
    const reviewDialogBody = rootElement.querySelector("[data-graph-review-body]");
    const NS = "http://www.w3.org/2000/svg";
    const graphToken = `workflow-graph-${Math.random().toString(36).slice(2, 10)}`;
    const BASE_NODE_WIDTH = 224;
    const BASE_NODE_HEIGHT = 148;
    const MIN_SCALE = 0.16;
    const MAX_SCALE = 1.8;
    let density = readDensity();
    let stageWidth = BASE_NODE_WIDTH * density;
    let stageHeight = BASE_NODE_HEIGHT * density;
    let scale = 1;
    let panX = 24;
    let panY = 18;
    let selectedId = "";
    let cardById = new Map();
    let draggingStage = null;
    let draggingNode = null;
    let suppressClickId = "";
    const manualPositions = new Map();
    let activeReviewEditor = null;

    if (!stage || !world || !nodesHost || !edgesSvg || !details || !list) return;

    function readDensity() {
      const raw = window.getComputedStyle(document.documentElement).getPropertyValue("--wb-ui-scale");
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    }

    function densityChanged() {
      const nextDensity = readDensity();
      if (Math.abs(nextDensity - density) < 0.001) return;
      density = nextDensity;
      stageWidth = BASE_NODE_WIDTH * density;
      stageHeight = BASE_NODE_HEIGHT * density;
      for (const node of data.nodes) {
        const card = cardById.get(node.id);
        if (!card) continue;
        card.style.width = `${stageWidth}px`;
        card.style.height = `${stageHeight}px`;
        const point = nodePosition(node);
        card.style.left = `${point.x}px`;
        card.style.top = `${point.y}px`;
      }
      renderEdges();
    }

    const densityObserver = new MutationObserver(densityChanged);
    densityObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

    count.textContent = `${data.counts.plan} 计划节点 · ${data.nodes.filter((node) => node.kind === "execution").length} 步骤记录 · ${data.counts.reviews} 人审 · ${data.counts.artifacts} 交付`;
    const notices = [];
    if (data.missingDependencies.length) notices.push(`${data.missingDependencies.length} 项任务关系无法对应到本工作流中的节点，因此未显示连线。`);
    if (data.cycleOrBlockedIds.length) notices.push(`任务关系中存在循环：${data.cycleOrBlockedIds.length} 个节点按当前顺序显示。`);
    if (!data.edges.some((edge) => edge.kind === "dependency") && data.counts.plan > 1 && !data.cycleOrBlockedIds.length) notices.push("当前计划未设置任务依赖；图中连线展示执行、核验与交付关系。");
    if (notices.length) {
      notice.hidden = false;
      notice.textContent = notices.join(" ");
    }

    function basePosition(node) {
      const columnWidth = 292 * density;
      const rowHeight = 170 * density;
      const x = 22 * density + Math.max(0, node.level || 0) * columnWidth;
      const y = 20 * density + Math.max(0, node.row || 0) * rowHeight;
      return { x, y };
    }

    function nodePosition(node) {
      const manual = manualPositions.get(node.id);
      return manual ? { x: manual.x * density, y: manual.y * density } : basePosition(node);
    }

    function applyTransform() {
      world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
      zoomOutput.textContent = `${Math.round(scale * 100)}%`;
    }

    function safeJson(value) {
      try { return JSON.stringify(value == null ? {} : value, null, 2); }
      catch (_) { return "{}"; }
    }

    function makeElement(tagName, className, value) {
      const element = document.createElement(tagName);
      if (className) element.className = className;
      if (value != null) element.textContent = String(value);
      return element;
    }

    function appendField(host, label, value, asJson) {
      const field = document.createElement("section");
      field.className = "workflow-graph-inspector-field";
      field.append(makeElement("span", "workflow-graph-inspector-label", label));
      if (asJson) {
        const pre = makeElement("pre", "workflow-graph-inspector-value mono", safeJson(value));
        field.append(pre);
      } else {
        field.append(makeElement("div", "workflow-graph-inspector-value", value));
      }
      host.append(field);
    }

    function appendTechnicalFields(host, rows) {
      const available = rows.filter(([, value]) => value != null && value !== "" && !(typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length));
      if (!available.length) return;
      const disclosure = document.createElement("details");
      disclosure.className = "workflow-graph-technical-details";
      disclosure.append(makeElement("summary", "", "技术信息"));
      for (const [label, value, asJson = true] of available) appendField(disclosure, label, value, asJson);
      host.append(disclosure);
    }

    function actionLink(label, href, options = {}) {
      if (!href) return null;
      const link = makeElement("a", "workflow-graph-link", label);
      link.href = href;
      link.dataset.graphJump = "true";
      if (options.kind) link.dataset.actionKind = options.kind;
      return link;
    }

    function setBridgeStatus(message) {
      if (!bridgeStatus) return;
      bridgeStatus.hidden = !message;
      bridgeStatus.textContent = message || "";
    }

    function requestArtifactPreview(node) {
      if (!node || node.kind !== "artifact" || !node.previewSupported || !node.currentVersion) {
        setBridgeStatus("此文件没有在线预览，可前往交付区下载。");
        return;
      }
      const artifactId = node.recordId;
      if (!artifactId) return;
      if (window.parent !== window) {
        window.parent.postMessage({ type: "tradeloom:file-selection", kind: "artifact", id: artifactId }, window.location.origin);
        setBridgeStatus("已请求在工作台预览当前版本。");
        return;
      }
      const path = node.currentVersion.preview_url;
      const url = globalThis.TradeLoomBusiness?.businessUrl?.(path) || path;
      if (typeof url === "string" && url.startsWith("/")) window.open(url, "_blank", "noopener");
    }

    function jumpToRecord(href) {
      if (!href || !href.startsWith("#")) return false;
      let target;
      try { target = document.getElementById(decodeURIComponent(href.slice(1))); }
      catch (_) { target = document.getElementById(href.slice(1)); }
      if (!target) return false;
      for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === "DETAILS") parent.open = true;
      }
      target.scrollIntoView?.({ behavior: "smooth", block: "center" });
      if (target.matches("form, article, section")) target.setAttribute("tabindex", "-1");
      target.focus?.({ preventScroll: true });
      return true;
    }

    function reviewArticle(node) {
      if (!node || node.kind !== "review" || !node.openHref || !node.openHref.startsWith("#")) return null;
      let id = node.openHref.slice(1);
      try { id = decodeURIComponent(id); } catch (_) { /* retain the literal id */ }
      const article = document.getElementById(id);
      return article && article.tagName === "ARTICLE" ? article : null;
    }

    function editableReviewForm(article) {
      return article?.querySelector("form.review-note-form, form.review-typed-form, form.review-image-upload-form") || null;
    }

    function restoreReviewEditor() {
      const editor = activeReviewEditor;
      if (!editor) return;
      activeReviewEditor = null;
      if (editor.submitMarker?.parentNode) editor.submitMarker.replaceWith(editor.submitButton);
      editor.actionBar?.remove();
      editor.placeholder?.replaceWith(editor.article);
      for (const [details, wasOpen] of editor.detailsState) details.open = wasOpen;
      if (reviewDialogBody) reviewDialogBody.replaceChildren();
      if (reviewDialogTitle) reviewDialogTitle.textContent = "";
      editor.trigger?.focus?.({ preventScroll: true });
    }

    function closeReviewEditor() {
      if (reviewDialog?.open && typeof reviewDialog.close === "function") reviewDialog.close();
      else reviewDialog?.removeAttribute("open");
      restoreReviewEditor();
    }

    function openReviewEditor(node, trigger) {
      const article = reviewArticle(node);
      const form = editableReviewForm(article);
      if (!article || !form || !reviewDialog || !reviewDialogBody || !reviewDialogTitle || activeReviewEditor) return false;
      const parent = article.parentElement;
      if (!parent) return false;
      const detailsState = [];
      for (let element = parent; element; element = element.parentElement) {
        if (element.tagName === "DETAILS") {
          detailsState.push([element, element.open]);
          element.open = true;
        }
      }
      const placeholder = document.createElement("div");
      placeholder.className = "workflow-graph-review-placeholder";
      placeholder.setAttribute("aria-live", "polite");
      placeholder.textContent = "此核验正在画布窗口中填写。";
      article.replaceWith(placeholder);
      const submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
      let submitMarker = null;
      let actionBar = null;
      if (submitButton) {
        submitMarker = document.createComment("workflow-review-submit-position");
        submitButton.before(submitMarker);
        actionBar = document.createElement("div");
        actionBar.className = "workflow-graph-review-form-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "button secondary";
        cancel.dataset.graphReviewClose = "true";
        cancel.textContent = "取消";
        actionBar.append(submitButton, cancel);
        form.append(actionBar);
      }
      activeReviewEditor = { article, form, placeholder, trigger, detailsState, submitButton, submitMarker, actionBar };
      reviewDialogTitle.textContent = node.label;
      reviewDialogBody.replaceChildren(article);
      if (typeof reviewDialog.showModal === "function") reviewDialog.showModal();
      else reviewDialog.setAttribute("open", "");
      (form.querySelector("input:not([type=hidden]), textarea, select") || reviewDialog.querySelector("[data-graph-review-close]") || reviewDialog).focus?.({ preventScroll: true });
      return true;
    }

    if (reviewDialog) {
      reviewDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeReviewEditor(); });
      reviewDialog.addEventListener("close", restoreReviewEditor);
      reviewDialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); closeReviewEditor(); }
      });
    }

    function renderInspector(node) {
      selectedId = node.id;
      for (const [id, card] of cardById) card.classList.toggle("is-selected", id === selectedId);
      details.replaceChildren();
      const kindLabels = { plan: "业务计划", subtask: "子任务", execution: "执行记录", review: "人工核验", artifact: "交付文件" };
      const header = makeElement("header", "workflow-graph-inspector-header");
      const headerCopy = makeElement("div", "workflow-graph-inspector-title-group");
      const eyebrow = makeElement("p", "workflow-graph-details-eyebrow", kindLabels[node.kind] || "工作流记录");
      const title = makeElement("h3", "", node.label);
      headerCopy.append(eyebrow, title);
      const status = makeElement("span", `workflow-graph-status ${safeStatusClass(node.status)}`, node.statusLabel);
      header.append(headerCopy, status);
      details.append(header);

      if (["plan", "subtask"].includes(node.kind)) {
        appendField(details, "角色", node.role || node.key || "—");
        appendField(details, "所需字段", node.requiredFields.length ? node.requiredFields.join("、") : "计划未列出必填内容");
        if (node.dependencies.length) appendField(details, "依赖", node.dependencies.map((reference) => {
          const parent = data.nodes.find((candidate) => candidate.id === reference || candidate.key === reference || candidate.role === reference);
          return parent ? parent.label : `未匹配引用 ${reference}`;
        }).join("、"));
        if (node.error) appendField(details, "错误记录", node.error);
        appendTechnicalFields(details, [
          ["输入数据", node.inputRefs],
          ["输入字段结构", node.inputSchema],
          ["输出字段结构", node.outputSchema],
          ["已保存结果", node.outputRefs],
        ]);
      } else if (node.kind === "execution") {
        appendField(details, "步骤", node.step && (node.step.step_label || node.step.label) || node.stepKey);
        appendField(details, "执行次数", String(node.attempt || 1));
        if (node.error) appendField(details, "错误记录", node.error);
        appendTechnicalFields(details, [
          ["步骤类型", node.stepKey, false],
          ["输入数据", node.inputRefs],
          ["输出数据", node.outputRefs],
        ]);
      } else if (node.kind === "review") {
        appendField(details, "核验内容", node.question || node.label || "—");
        if (node.options.length) appendField(details, "可选答案", node.options.join("、"));
        if (node.uiSupported) appendField(details, "处理状态", node.uiApplied ? "已应用" : node.status === "pending" ? "待填写" : "已提交，待应用");
        else if (node.status === "pending") appendField(details, "处理状态", "请使用下方核验表单");
        appendTechnicalFields(details, [["关联记录", node.recordId, false], ["来源数据", node.sourceRefs], ["结果位置", node.resultRef, false]]);
      } else if (node.kind === "artifact") {
        appendField(details, "当前版本", node.currentVersion ? `v${node.currentVersion.version} · ${node.currentVersion.status_label || node.currentVersion.status}` : "尚无已保存版本");
        appendTechnicalFields(details, [
          ["文件类型", node.artifactType, false],
          ["来源产品版本", node.currentVersion && node.currentVersion.source_product_versions],
          ["文件校验值", node.currentVersion && node.currentVersion.sha256, false],
        ]);
        const versionList = document.createElement("div");
        versionList.className = "workflow-graph-version-list";
        for (const version of node.versions.slice().sort((a, b) => Number(b.version) - Number(a.version))) {
          const row = makeElement("div", "workflow-graph-version-row", `v${version.version} · ${version.status_label || version.status}`);
          if (version.preview_url) {
            const preview = actionLink("直接预览此版本", globalThis.TradeLoomBusiness?.businessUrl?.(version.preview_url) || version.preview_url);
            if (preview) { preview.target = "_blank"; preview.rel = "noopener"; row.append(preview); }
          }
          if (version.download_url) {
            const download = actionLink("下载", globalThis.TradeLoomBusiness?.businessUrl?.(version.download_url) || version.download_url);
            if (download) { download.target = "_blank"; download.rel = "noopener"; row.append(download); }
          }
          versionList.append(row);
        }
        if (versionList.childElementCount) {
          const field = makeElement("section", "workflow-graph-inspector-field");
          field.append(makeElement("span", "workflow-graph-inspector-label", "版本记录"), versionList);
          details.append(field);
        }
      }

      const footer = makeElement("footer", "workflow-graph-inspector-actions");
      if (["plan", "subtask"].includes(node.kind)) {
        if (node.subtaskId) footer.append(actionLink("查看子任务", `#workflow-subtask-${encodeURIComponent(node.subtaskId)}`));
        if (node.canDispatch) footer.append(actionLink("派发下一步", "#workflow-dispatch-form", { kind: "dispatch" }));
        footer.append(actionLink("创建业务计划", rootElement.dataset.createHref || ""));
      } else if (node.kind === "execution") {
        if (node.recordId) footer.append(actionLink("查看执行记录", `#workflow-step-${encodeURIComponent(node.recordId)}`));
        if (node.stepKey === "generate_deliverables") footer.append(actionLink("交付操作", "#workflow-delivery-actions"));
      } else if (node.kind === "review") {
        const article = reviewArticle(node);
        if (node.status === "pending" && editableReviewForm(article)) {
          const edit = makeElement("button", "workflow-graph-link", "填写核验");
          edit.type = "button";
          edit.dataset.graphOpenReview = node.id;
          footer.append(edit);
        } else {
          footer.append(actionLink("查看核验记录", node.openHref));
        }
      } else if (node.kind === "artifact") {
        if (node.previewSupported) {
          const preview = makeElement("button", "workflow-graph-link workflow-graph-preview-action", "预览当前版本");
          preview.type = "button";
          preview.dataset.graphPreview = node.id;
          footer.append(preview);
        }
        if (!node.previewSupported && node.currentVersion && node.currentVersion.download_url) {
          footer.append(actionLink("下载当前版本", globalThis.TradeLoomBusiness?.businessUrl?.(node.currentVersion.download_url) || node.currentVersion.download_url));
        }
      }
      if (!footer.childElementCount) footer.append(makeElement("span", "workflow-graph-no-record", "暂无可用操作。"));
      details.append(footer);
    }

    function safeStatusClass(status) {
      return new Set(["queued", "running", "completed", "failed", "interrupted", "waiting_human", "pending", "submitted", "approved", "rejected", "planned"]).has(status)
        ? status : "unknown";
    }

    function renderNodes() {
      nodesHost.replaceChildren();
      cardById = new Map();
      for (const node of data.nodes) {
        const point = nodePosition(node);
        const card = makeElement("button", `workflow-graph-node kind-${node.kind}`);
        card.type = "button";
        card.dataset.nodeId = node.id;
        card.dataset.kind = node.kind;
        card.dataset.status = safeStatusClass(node.status);
        card.style.width = `${stageWidth}px`;
        card.style.height = `${stageHeight}px`;
        card.style.left = `${point.x}px`;
        card.style.top = `${point.y}px`;
        const marker = node.kind === "plan" || node.kind === "subtask" ? `计划 ${node.order}`
          : node.kind === "execution" ? `尝试 ${node.attempt || 1}`
          : node.kind === "artifact" ? (node.currentVersion ? `版本 ${node.currentVersion.version}` : "尚无版本")
          : "核验事项";
        card.setAttribute("aria-label", `${node.label}，${node.statusLabel}，${kindWord(node.kind)}`);
        const header = makeElement("span", "workflow-graph-node-header");
        header.append(makeElement("span", "workflow-graph-node-index", marker));
        header.append(makeElement("span", `workflow-graph-status ${safeStatusClass(node.status)}`, node.statusLabel));
        const title = makeElement("strong", "workflow-graph-node-title", node.label);
        const type = makeElement("span", "workflow-graph-node-type", kindWord(node.kind));
        let footerText = "";
        if (node.kind === "subtask" && node.latestStep) footerText = `最近步骤：${node.latestStep.step_label || node.latestStep.step_key} · ${node.latestStep.status_label || node.latestStep.status}`;
        else if (node.kind === "subtask") footerText = node.canDispatch ? "可以继续派发" : "等待依赖或人工处理";
        else if (node.kind === "plan") footerText = `计划序位 ${node.order} · 尚未建立子任务记录`;
        else if (node.kind === "execution") footerText = node.error || (node.stepKey === "subtask" ? "执行状态已保存" : `记录状态：${node.statusLabel}`);
        else if (node.kind === "review") footerText = node.uiSupported ? "待填写核验" : "查看处理结果";
        else if (node.kind === "artifact") footerText = node.previewSupported ? "可预览当前版本" : "可查看版本或下载";
        const footer = makeElement("span", "workflow-graph-node-footer", footerText);
        card.append(header, title, type, footer);
        card.addEventListener("click", () => {
          if (suppressClickId === node.id) { suppressClickId = ""; return; }
          renderInspector(node);
        });
        card.addEventListener("dblclick", () => {
          if (node.kind === "artifact") requestArtifactPreview(node);
          else if (node.kind === "review") jumpToRecord(node.openHref);
          else if (node.kind === "execution" && node.recordId) jumpToRecord(`#workflow-step-${encodeURIComponent(node.recordId)}`);
          else if (node.subtaskId) jumpToRecord(`#workflow-subtask-${encodeURIComponent(node.subtaskId)}`);
        });
        card.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          draggingNode = { id: node.id, x: event.clientX, y: event.clientY, point: nodePosition(node), moved: false };
          card.setPointerCapture?.(event.pointerId);
          card.classList.add("is-moving");
          event.stopPropagation();
        });
        card.addEventListener("pointermove", (event) => {
          if (!draggingNode || draggingNode.id !== node.id) return;
          const dx = event.clientX - draggingNode.x;
          const dy = event.clientY - draggingNode.y;
          if (!draggingNode.moved && Math.hypot(dx, dy) < 4) return;
          draggingNode.moved = true;
          manualPositions.set(node.id, {
            x: Math.max(0, (draggingNode.point.x + dx / scale) / density),
            y: Math.max(0, (draggingNode.point.y + dy / scale) / density),
          });
          const position = nodePosition(node);
          card.style.left = `${position.x}px`;
          card.style.top = `${position.y}px`;
          renderEdges();
          event.preventDefault();
        });
        const endNodeDrag = () => {
          if (!draggingNode || draggingNode.id !== node.id) return;
          if (draggingNode.moved) suppressClickId = node.id;
          draggingNode = null;
          card.classList.remove("is-moving");
        };
        card.addEventListener("pointerup", endNodeDrag);
        card.addEventListener("pointercancel", endNodeDrag);
        cardById.set(node.id, card);
        nodesHost.append(card);
      }
      if (selectedId && data.nodes.some((node) => node.id === selectedId)) renderInspector(data.nodes.find((node) => node.id === selectedId));
      else if (data.nodes.length) renderInspector(data.nodes[0]);
    }

    function kindWord(kind) {
      return ({ plan: "计划项", subtask: "业务子任务", execution: "执行步骤", review: "业务人审", artifact: "交付文件" })[kind] || "工作流记录";
    }

    function renderEdges() {
      edgesSvg.replaceChildren();
      let maxX = stage.clientWidth;
      let maxY = stage.clientHeight;
      for (const node of data.nodes) {
        const point = nodePosition(node);
        maxX = Math.max(maxX, point.x + stageWidth + 26);
        maxY = Math.max(maxY, point.y + stageHeight + 28);
      }
      edgesSvg.setAttribute("width", String(maxX));
      edgesSvg.setAttribute("height", String(maxY));
      edgesSvg.setAttribute("viewBox", `0 0 ${maxX} ${maxY}`);
      const defs = document.createElementNS(NS, "defs");
      const marker = document.createElementNS(NS, "marker");
      marker.setAttribute("id", `${graphToken}-arrow`);
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "8");
      marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", String(6 * density));
      marker.setAttribute("markerHeight", String(6 * density));
      marker.setAttribute("orient", "auto-start-reverse");
      const arrow = document.createElementNS(NS, "path");
      arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
      arrow.setAttribute("class", "workflow-graph-arrow");
      marker.append(arrow);
      defs.append(marker);
      edgesSvg.append(defs);
      for (const edge of data.edges) {
        const from = data.nodes.find((node) => node.id === edge.from);
        const to = data.nodes.find((node) => node.id === edge.to);
        if (!from || !to) continue;
        const a = nodePosition(from);
        const b = nodePosition(to);
        const fromRight = b.x >= a.x;
        const x1 = a.x + (fromRight ? stageWidth : 0);
        const y1 = a.y + stageHeight / 2;
        const x2 = b.x + (fromRight ? 0 : stageWidth);
        const y2 = b.y + stageHeight / 2;
        const bend = Math.max(36, Math.abs(x2 - x1) * 0.42);
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", fromRight
          ? `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
          : `M ${x1} ${y1} C ${x1 - bend} ${y1}, ${x2 + bend} ${y2}, ${x2} ${y2}`);
        path.setAttribute("class", `workflow-graph-edge edge-${edge.kind}`);
        path.setAttribute("data-edge-kind", edge.kind);
        path.setAttribute("marker-end", `url(#${graphToken}-arrow)`);
        edgesSvg.append(path);
      }
    }

    function renderList() {
      const listElement = document.createElement("ol");
      listElement.className = "workflow-graph-list-items";
      for (const node of data.nodes.slice().sort((a, b) => a.order - b.order)) {
        const item = document.createElement("li");
        item.className = `workflow-graph-list-item kind-${node.kind}`;
        const select = makeElement("button", "workflow-graph-list-select", node.label);
        select.type = "button";
        select.addEventListener("click", () => {
          setMode("graph");
          renderInspector(node);
          const card = cardById.get(node.id);
          if (card) card.focus();
        });
        item.append(select, makeElement("span", `workflow-graph-status ${safeStatusClass(node.status)}`, node.statusLabel));
        item.append(makeElement("span", "workflow-graph-list-kind", kindWord(node.kind)));
        listElement.append(item);
      }
      list.replaceChildren(listElement);
    }

    function setMode(mode) {
      const graphVisible = mode !== "list";
      stage.hidden = !graphVisible;
      details.hidden = !graphVisible;
      list.hidden = graphVisible;
      for (const button of rootElement.querySelectorAll("[data-graph-mode]")) {
        const active = button.dataset.graphMode === mode;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      }
    }

    function fit() {
      const rect = stage.getBoundingClientRect();
      const maxX = Math.max(1, ...data.nodes.map((node) => nodePosition(node).x + stageWidth));
      const maxY = Math.max(1, ...data.nodes.map((node) => nodePosition(node).y + stageHeight));
      scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, 1, (rect.width - 36) / maxX, (rect.height - 52) / maxY));
      panX = Math.max(12, (rect.width - maxX * scale) / 2);
      panY = Math.max(12, (rect.height - maxY * scale) / 2);
      applyTransform();
    }

    function arrange() {
      manualPositions.clear();
      renderNodes();
      renderEdges();
      fit();
      setBridgeStatus("");
    }

    rootElement.addEventListener("click", (event) => {
      const closeReview = event.target.closest("[data-graph-review-close]");
      if (closeReview) { closeReviewEditor(); return; }
      const openReview = event.target.closest("[data-graph-open-review]");
      if (openReview) {
        const node = nodesByIdForGraph(openReview.dataset.graphOpenReview);
        if (node) openReviewEditor(node, openReview);
        return;
      }
      const modeButton = event.target.closest("[data-graph-mode]");
      if (modeButton) { setMode(modeButton.dataset.graphMode); return; }
      const action = event.target.closest("[data-graph-action]");
      if (action) {
        if (action.dataset.graphAction === "fit") fit();
        if (action.dataset.graphAction === "arrange") arrange();
        if (action.dataset.graphAction === "zoom-in" || action.dataset.graphAction === "zoom-out") {
          const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale + (action.dataset.graphAction === "zoom-in" ? 0.1 : -0.1)));
          const rect = stage.getBoundingClientRect();
          const factor = next / scale;
          panX = rect.width / 2 - (rect.width / 2 - panX) * factor;
          panY = rect.height / 2 - (rect.height / 2 - panY) * factor;
          scale = next;
          applyTransform();
        }
        return;
      }
      const jump = event.target.closest("[data-graph-jump]");
      if (jump && jumpToRecord(jump.getAttribute("href"))) event.preventDefault();
      const preview = event.target.closest("[data-graph-preview]");
      if (preview) {
        const node = nodesByIdForGraph(preview.dataset.graphPreview);
        if (node) requestArtifactPreview(node);
      }
    });

    function nodesByIdForGraph(id) { return data.nodes.find((node) => node.id === id) || null; }

    stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * (event.deltaY < 0 ? 1.08 : 0.92)));
      const rect = stage.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const factor = next / scale;
      panX = x - (x - panX) * factor;
      panY = y - (y - panY) * factor;
      scale = next;
      applyTransform();
    }, { passive: false });
    stage.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".workflow-graph-node,button,a,input,textarea,select")) return;
      draggingStage = { x: event.clientX, y: event.clientY, panX, panY };
      stage.setPointerCapture?.(event.pointerId);
      stage.classList.add("is-panning");
    });
    stage.addEventListener("pointermove", (event) => {
      if (!draggingStage) return;
      panX = draggingStage.panX + event.clientX - draggingStage.x;
      panY = draggingStage.panY + event.clientY - draggingStage.y;
      applyTransform();
    });
    const endStageDrag = () => { draggingStage = null; stage.classList.remove("is-panning"); };
    stage.addEventListener("pointerup", endStageDrag);
    stage.addEventListener("pointercancel", endStageDrag);
    stage.addEventListener("keydown", (event) => {
      const current = data.nodes.findIndex((node) => node.id === selectedId);
      let targetIndex = -1;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") targetIndex = Math.min(data.nodes.length - 1, current + 1);
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") targetIndex = Math.max(0, current - 1);
      if (event.key === "Home") targetIndex = 0;
      if (event.key === "End") targetIndex = data.nodes.length - 1;
      if (targetIndex >= 0 && data.nodes[targetIndex]) {
        event.preventDefault();
        renderInspector(data.nodes[targetIndex]);
        cardById.get(data.nodes[targetIndex].id)?.focus();
      }
    });

    renderNodes();
    renderEdges();
    renderList();
    setMode("graph");
    applyTransform();
    requestAnimationFrame(fit);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(renderEdges).observe(stage);
  }
  const api = { buildWorkflowGraph, initGraph };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TradeloomWorkflowGraph = api;

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll("[data-workflow-graph]").forEach(initGraph);
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
