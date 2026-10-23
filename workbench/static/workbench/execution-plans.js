(() => {
  const root = document.querySelector('[data-testid="execution-plan-workbench"]');
  if (!root) return;
  const intake = document.querySelector('[data-testid="intake-workbench"]');
  const content = root.querySelector('[data-testid="execution-plan-content"]');
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || "";
  const businessUrl = globalThis.TradeLoomBusiness?.businessUrl || (value => value);
  const opaque = /^[a-f0-9]{32}$/;
  let selected = null;
  let contextGeneration = 0;
  let historyRequestGeneration = 0;
  let pageOffset = 0;
  let nextOffset = null;
  let latestRevision = 0;
  let history = [];
  let requirementRefs = [];
  let materials = [];
  let operations = [];
  let busy = false;
  let localDirty = false;
  let pendingRequest = null;

  const node = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  const button = (text, action, className = "button secondary small") => {
    const item = node("button", className, text);
    item.type = "button";
    item.addEventListener("click", action);
    return item;
  };
  const key = () => globalThis.crypto?.randomUUID?.().replaceAll("-", "") || `${Date.now()}${Math.random().toString(16).slice(2)}`;
  const collectionUrl = requirementId => root.dataset.planCollectionUrl.replace("__REQUIREMENT__", encodeURIComponent(requirementId));

  async function request(url, options = {}) {
    const response = await fetch(businessUrl(url), { credentials: "same-origin", ...options,
      headers: { "X-CSRFToken": csrf, ...(options.headers || {}) } });
    const body = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const error = new Error(body?.error_code === "stale_execution_plan"
        ? "计划版本已被其他操作更新。输入仍保留；请先点击重新读取，再决定是否保存。"
        : `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.code = body?.error_code || "unavailable";
      throw error;
    }
    return body;
  }

  function activeConfirmed() {
    return selected?.phase === "viewed" && selected.revision?.status === "confirmed";
  }

  function announce(message, error = false) {
    content.querySelector("[data-plan-message]")?.remove();
    const target = node("p", `intake-message${error ? " is-error" : ""}`, message);
    target.dataset.planMessage = "true";
    content.prepend(target);
  }

  function currentContext(token, requirementId, revisionId) {
    return contextGeneration === token && selected?.requirementId === requirementId
      && selected?.revision?.id === revisionId;
  }

  function evidenceOptions() {
    const sourceRefs = selected?.revision?.source_refs || {};
    return Object.entries(sourceRefs).flatMap(([field, refs]) => Array.isArray(refs) ? refs
      .filter(ref => opaque.test(ref?.id || "") && ref.field_key === field)
      .map(ref => ({ ...ref, label: `${field} · ${ref.kind === "source_record" ? `工作表 ${ref.sheet_index || "?"}!${ref.coordinate || "?"}` : ref.line_start ? `文字第 ${ref.line_start}-${ref.line_end} 行` : ref.kind}${ref.summary ? ` · ${String(ref.summary).slice(0, 100)}` : ""}` })) : []);
  }

  function addEvidencePicker(parent, title, chosenIds = []) {
    const details = node("details", "execution-plan-evidence");
    details.append(node("summary", "", title));
    for (const ref of evidenceOptions()) {
      const label = node("label", "execution-plan-check");
      const input = node("input", ""); input.type = "checkbox"; input.value = ref.id;
      input.dataset.evidenceField = ref.field_key;
      input.checked = chosenIds.includes(ref.id);
      label.append(input, document.createTextNode(` ${ref.field_key} · ${ref.label}`));
      details.append(label);
    }
    parent.append(details);
    return details;
  }

  function selectedRefs(container) {
    const refs = new Map();
    for (const input of container.querySelectorAll("input[type=checkbox]:checked")) {
      const field = input.dataset.evidenceField;
      if (!refs.has(field)) refs.set(field, []);
      refs.get(field).push(input.value);
    }
    return [...refs].map(([field_key, evidence_ids]) => ({ field_key, evidence_ids }));
  }

  function renderProposals() {
    const proposalArea = node("div", "execution-plan-proposals");
    if (!activeConfirmed()) {
      proposalArea.append(node("p", "intake-muted", "只有已确认需求版本可以追加计划草稿。"));
      return proposalArea;
    }
    const refsBox = node("fieldset", "execution-plan-ref-group");
    refsBox.append(node("legend", "", "需求字段依据"));
    refsBox.append(node("p", "intake-muted", "这些引用只说明需求字段的出处；不表示物料提议由需求证据证明。"));
    const selectedRequirementRefs = addEvidencePicker(refsBox, "选择本计划关联的需求依据", requirementRefs.flatMap(ref => ref.evidence_ids));
    selectedRequirementRefs.addEventListener("change", () => { requirementRefs = selectedRefs(selectedRequirementRefs); localDirty = true; updateSave(); });
    proposalArea.append(refsBox);

    const materialList = node("div", "execution-plan-item-list");
    materialList.append(node("h4", "", "物料人工提议 · 未核实"));
    materials.forEach((item, index) => {
      const form = node("fieldset", "execution-plan-item");
      form.append(node("legend", "", `物料提议 ${index + 1}`));
      const prefix = `plan-material-${index}`;
      const description = node("textarea", "intake-requirement-input"); description.maxLength = 500; description.placeholder = "描述（可留空）"; description.value = item.description;
      const quantity = node("input", "intake-requirement-input"); quantity.type = "text"; quantity.inputMode = "decimal"; quantity.placeholder = "预计用量（可留空）"; quantity.value = item.quantity;
      const unit = node("input", "intake-requirement-input"); unit.type = "text"; unit.maxLength = 64; unit.placeholder = "单位（可留空）"; unit.value = item.unit;
      const expectedDate = node("input", "intake-requirement-input"); expectedDate.type = "date"; expectedDate.value = item.expected_date;
      [[description, "提议描述", "description"], [quantity, "预计用量", "quantity"], [unit, "单位", "unit"], [expectedDate, "预计日期", "expected-date"]].forEach(([control, title, suffix]) => {
        control.id = `${prefix}-${suffix}`; const label = node("label", "", title); label.htmlFor = control.id; form.append(label, control);
      });
      const support = addEvidencePicker(form, "关联需求依据（可选）", item.support.flatMap(ref => ref.evidence_ids));
      const values = () => ({ description: description.value || null, quantity: quantity.value || null, unit: unit.value || null, expected_date: expectedDate.value || null, support: selectedRefs(support) });
      [description, quantity, unit, expectedDate, ...support.querySelectorAll("input")].forEach(input => input.addEventListener("input", () => { materials[index] = values(); localDirty = true; updateSave(); }));
      support.addEventListener("change", () => { materials[index] = values(); localDirty = true; updateSave(); });
      form.append(button("移除", () => { materials.splice(index, 1); localDirty = true; render(); }));
      materialList.append(form);
      materials[index] = values();
    });
    materialList.append(button("添加物料提议", () => { materials.push({ description: "", quantity: "", unit: "", expected_date: "", support: [] }); localDirty = true; render(); }, "button secondary small"));
    proposalArea.append(materialList);

    const operationList = node("div", "execution-plan-item-list");
    operationList.append(node("h4", "", "工序人工提议 · 未核实"));
    operations.forEach((item, index) => {
      const form = node("fieldset", "execution-plan-item");
      form.append(node("legend", "", `工序提议 ${index + 1}`));
      const prefix = `plan-operation-${index}`;
      const description = node("textarea", "intake-requirement-input"); description.maxLength = 500; description.placeholder = "描述（可留空）"; description.value = item.description;
      const sequence = node("input", "intake-requirement-input"); sequence.type = "text"; sequence.inputMode = "numeric"; sequence.placeholder = "顺序（可留空）"; sequence.value = item.sequence;
      [[description, "工序描述", "description"], [sequence, "顺序", "sequence"]].forEach(([control, title, suffix]) => {
        control.id = `${prefix}-${suffix}`; const label = node("label", "", title); label.htmlFor = control.id; form.append(label, control);
      });
      const support = addEvidencePicker(form, "关联需求依据（可选）", item.support.flatMap(ref => ref.evidence_ids));
      const values = () => ({ description: description.value || null, sequence: sequence.value, support: selectedRefs(support) });
      [description, sequence, ...support.querySelectorAll("input")].forEach(input => input.addEventListener("input", () => { operations[index] = values(); localDirty = true; updateSave(); }));
      support.addEventListener("change", () => { operations[index] = values(); localDirty = true; updateSave(); });
      form.append(button("移除", () => { operations.splice(index, 1); localDirty = true; render(); }));
      operationList.append(form);
      operations[index] = values();
    });
    operationList.append(button("添加工序提议", () => { operations.push({ description: "", sequence: "", support: [] }); localDirty = true; render(); }, "button secondary small"));
    proposalArea.append(operationList);
    return proposalArea;
  }

  function updateSave() {
    const save = content.querySelector("[data-plan-save]");
    if (save) save.disabled = !activeConfirmed() || selected.dirty || selected.saving || busy || !localDirty;
    if (busy) content.querySelectorAll("input, textarea, button").forEach(control => { control.disabled = true; });
  }

  function render() {
    content.replaceChildren();
    if (!selected || selected.phase !== "viewed") {
      content.append(node("p", "intake-muted", selected?.phase === "loading" ? "正在读取已选需求版本…" : "选择已确认的生产需求版本。"));
      return;
    }
    const rev = selected.revision;
    content.append(node("p", "intake-muted", `${rev.status === "confirmed" ? "已确认需求版本" : "需求待确认"} · 版本 ${rev.revision}`));
    if (!activeConfirmed()) content.append(node("p", "intake-muted", "只有已确认需求版本可以追加计划草稿。"));
    const refresh = button("重新读取计划", () => loadHistory(true));
    content.append(refresh);
    const list = node("div", "execution-plan-history");
    list.append(node("h4", "", "历史计划（只读）"));
    for (const plan of history) {
      const row = node("article", "execution-plan-history-row");
      row.append(node("strong", "", `计划版本 ${plan.revision}`));
      row.append(node("small", "", `需求版本 ${rev.revision} · ${plan.is_latest ? "该需求版本的最新计划" : "历史版本"}`));
      row.append(node("p", "", `${plan.materials.length} 项物料提议 · ${plan.operations.length} 道工序提议 · 实际到料/产量未记录`));
      const allRefs = [...(plan.requirement_refs || []), ...(plan.materials || []).flatMap(item => item.supporting_requirement_inputs || []), ...(plan.operations || []).flatMap(item => item.supporting_requirement_inputs || [])];
      const sourceByField = plan.requirement_revision?.source_refs || {};
      for (const ref of allRefs) {
        for (const id of ref.evidence_ids || []) {
          const evidence = (sourceByField[ref.field_key] || []).find(item => item.id === id);
          if (evidence) row.append(node("small", "execution-plan-provenance", `关联需求依据 · ${ref.field_key} · ${evidence.kind === "source_record" ? `工作表 ${evidence.sheet_index || "?"}!${evidence.coordinate || "?"}` : evidence.line_start ? `文字第 ${evidence.line_start}-${evidence.line_end} 行` : evidence.kind} · ${String(evidence.summary || "").slice(0, 100)}`));
        }
      }
      for (const item of plan.materials || []) row.append(node("p", "execution-plan-proposal", `物料人工提议·未核实：${item.proposal?.description || "（未填写描述）"}${item.proposal?.quantity !== null ? ` · ${item.proposal?.quantity ?? ""} ${item.proposal?.unit ?? ""}` : ""}`));
      for (const item of plan.operations || []) row.append(node("p", "execution-plan-proposal", `工序人工提议·未核实：${item.proposal?.description || "（未填写描述）"}${item.proposal?.sequence !== null ? ` · 顺序 ${item.proposal?.sequence ?? ""}` : ""}`));
      list.append(row);
    }
    if (!history.length) list.append(node("p", "intake-muted", "该需求版本尚无计划草稿。"));
    if (nextOffset !== null) list.append(button("加载更早计划", () => loadHistory(false, nextOffset)));
    content.append(list);
    if (activeConfirmed()) {
      const proposalArea = renderProposals();
      content.append(proposalArea);
      const actions = node("div", "intake-requirement-actions");
      const save = button("追加保存计划草稿", savePlan, "button primary small"); save.dataset.planSave = "true";
      actions.append(save);
      const message = node("p", "intake-message", ""); message.dataset.planMessage = "true"; message.setAttribute("role", "status");
      actions.append(message);
      content.append(actions);
      updateSave();
    }
  }

  async function loadHistory(reset = true, offset = 0) {
    if (!selected?.requirementId || !selected?.revision?.id) return;
    if (reset) { pageOffset = 0; history = []; nextOffset = null; }
    const token = contextGeneration;
    const requestGeneration = ++historyRequestGeneration;
    const requirementId = selected.requirementId;
    const revisionId = selected.revision.id;
    try {
      const url = `${collectionUrl(requirementId)}?requirement_revision_id=${encodeURIComponent(revisionId)}&offset=${offset}&limit=10`;
      const result = await request(url);
      if (!currentContext(token, requirementId, revisionId) || requestGeneration !== historyRequestGeneration) return;
      latestRevision = Number.isInteger(result.latest_revision) ? result.latest_revision : 0;
      history = reset ? result.revisions : [...history, ...result.revisions];
      pageOffset = offset;
      nextOffset = result.next_offset;
      render();
    } catch (error) {
      if (currentContext(token, requirementId, revisionId) && requestGeneration === historyRequestGeneration) announce(`计划读取失败：${error.message}`, true);
    }
  }

  async function savePlan() {
    if (!selected?.requirementId || !activeConfirmed() || selected.dirty || selected.saving || busy || !localDirty) return;
    const token = contextGeneration;
    const requirementId = selected.requirementId;
    const revision = selected.revision;
    for (const control of content.querySelectorAll("input, textarea, button")) control.disabled = true;
    const sequenceInvalid = operations.some(item => item.sequence !== "" && (!/^[1-9]\d*$/.test(item.sequence) || !Number.isSafeInteger(Number(item.sequence))));
    if (sequenceInvalid) {
      announce("工序顺序必须是正整数；当前输入已保留。", true);
      for (const control of content.querySelectorAll("input, textarea, button")) control.disabled = false;
      updateSave();
      return;
    }
    const body = {
      requirement_revision_id: revision.id,
      expected_revision: latestRevision,
      requirement_refs: requirementRefs,
      materials: materials.map(item => ({ item_ref: null, resolution: "unresolved",
        proposal: { description: item.description || null, quantity: item.quantity || null, unit: item.unit || null, expected_date: item.expected_date || null },
        supporting_requirement_inputs: item.support || [] })),
      operations: operations.map(item => ({ operation_ref: null, resolution: "unresolved",
        proposal: { description: item.description || null, sequence: item.sequence === "" ? null : Number(item.sequence) }, supporting_requirement_inputs: item.support || [] })),
    };
    const serialized = JSON.stringify(body);
    if (!pendingRequest || pendingRequest.serialized !== serialized) pendingRequest = { serialized, key: key() };
    busy = true; updateSave();
    const save = content.querySelector("[data-plan-save]"); if (save) save.textContent = "正在保存…";
    try {
      const result = await request(collectionUrl(requirementId), {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": pendingRequest.key }, body: serialized,
      });
      if (!currentContext(token, requirementId, revision.id)) return;
      pendingRequest = null; localDirty = false; requirementRefs = []; materials = []; operations = [];
      const successMessage = `已追加保存计划版本 ${result.plan.revision}；物料与工序仍为人工提议·未核实。`;
      await loadHistory(true);
      if (currentContext(token, requirementId, revision.id)) announce(successMessage);
    } catch (error) {
      if (!currentContext(token, requirementId, revision.id)) return;
      announce(error.status === 409 ? `${error.message} 当前输入保留。` : `保存失败：${error.message}。重试将沿用同一请求键。`, true);
    } finally {
      if (currentContext(token, requirementId, revision.id)) {
        busy = false;
        for (const control of content.querySelectorAll("input, textarea, button")) control.disabled = false;
        const currentSave = content.querySelector("[data-plan-save]");
        if (currentSave) currentSave.textContent = "追加保存计划草稿";
        updateSave();
      }
    }
  }

  (intake || root).addEventListener("tradeloom:requirement-context", event => {
    const next = event.detail || {};
    if (next.phase === "state" && selected) {
      selected.dirty = next.dirty === true;
      selected.saving = next.saving === true;
      updateSave();
      return;
    }
    const old = selected;
    const changed = old?.candidateId !== (next.candidateId || "")
      || old?.requirementId !== (next.requirementId || "")
      || old?.revision?.id !== (next.revision?.id || "")
      || next.phase === "cleared" || next.phase === "loading";
    if (changed) {
      contextGeneration++;
      historyRequestGeneration++;
      history = []; requirementRefs = []; materials = []; operations = []; localDirty = false; pendingRequest = null;
      latestRevision = 0; nextOffset = null; pageOffset = 0; busy = false;
    }
    selected = { phase: next.phase, candidateId: next.candidateId || "", requirementId: next.requirementId || "",
      revision: next.revision || null, dirty: next.dirty === true, saving: next.saving === true };
    if (next.phase === "viewed" && next.requirementId && next.revision?.id) {
      render();
      if (changed) loadHistory(true);
    } else render();
  });
})();
