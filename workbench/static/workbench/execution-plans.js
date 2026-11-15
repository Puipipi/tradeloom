(() => {
  const root = document.querySelector('[data-testid="execution-plan-workbench"]');
  if (!root) return;
  const intake = document.querySelector('[data-testid="intake-workbench"]');
  const content = root.querySelector('[data-testid="execution-plan-content"]');
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || "";
  const businessUrl = globalThis.TradeLoomBusiness?.businessUrl || (value => value);
  const opaque = /^[a-f0-9]{32}$/;
  const sourceTypeLabels = { commercial_source: "采购/报价参考", labor_analysis: "工时/产能估算参考" };
  const sourceStateLabels = { present: "有值", empty: "空单元格", type_mismatch: "类型不匹配",
    formula_error: "公式错误缓存", formula_cache_missing: "公式缓存缺失", formula_cache_empty: "公式缓存为空", unknown: "状态未知" };
  const sourceFieldLabels = { document_reference: "单据编号", party_text: "往来方文本", item_description: "品名文本",
    quantity: "数量", unit: "单位", unit_price: "单价", amount: "金额", currency: "币种文本", notes: "备注",
    process: "工序文本", observed_seconds: "观察秒数", observed_quantity: "观察数量", observed_unit: "观察单位",
    estimated_hourly_rate: "估算小时费率", estimated_efficiency: "估算效率", estimated_capacity: "估算产能", estimated_piece_rate: "估算计件费率" };
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
  let sourceCandidates = [];
  const sourceEvidenceRequests = new Map();
  const sourceEvidenceMetadata = new Map();
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

  function addSourceReferencePicker(parent, item, collection, index) {
    const details = node("details", "execution-plan-source-picker");
    details.append(node("summary", "", "采购/报价/估算参考（未核实）"));
    details.append(node("p", "intake-muted", "仅关联已有采购/报价或工时/产能估算导入格；不会确认订单、价格性质或工时口径。"));
    const candidateSelect = node("select", "intake-requirement-input");
    candidateSelect.setAttribute("aria-label", "选择采购或劳动估算来源");
    candidateSelect.append(new Option("选择已有导入来源…", ""));
    const fieldSelect = node("select", "intake-requirement-input");
    fieldSelect.setAttribute("aria-label", "选择来源字段");
    fieldSelect.append(new Option("先选择来源", ""));
    const cellSelect = node("select", "intake-requirement-input");
    cellSelect.setAttribute("aria-label", "选择来源工作表和单元格");
    cellSelect.append(new Option("再选择来源格", ""));
    const controls = [candidateSelect, fieldSelect, cellSelect];
    controls.forEach((control, controlIndex) => {
      const label = node("label", "", ["已有导入来源", "来源字段", "来源工作表格"][controlIndex]);
      label.append(control); details.append(label);
    });
    const linked = node("div", "execution-plan-source-linked");
    const renderLinked = () => {
      linked.replaceChildren();
      for (const reference of item.sourceInputs || []) {
        for (const evidenceId of reference.evidence_ids) {
          const metadata = sourceEvidenceMetadata.get(evidenceId);
          const candidate = sourceCandidates.find(row => row.id === reference.candidate_id);
          const wrapper = node("div", "execution-plan-source-reference");
          wrapper.append(node("small", "execution-plan-provenance", `${metadata?.source_display_name || candidate?.source_display_name || "已导入来源"} · ${sourceFieldLabels[reference.field_key] || "来源字段"} · ${metadata ? `工作表 ${metadata.sheet_index}!${metadata.coordinate}` : "来源格"} · 未核实引用`));
          const remove = button("移除引用", () => {
            const currentItem = collection[index] || item;
            currentItem.sourceInputs = (currentItem.sourceInputs || []).map(row => ({ ...row,
              evidence_ids: row.evidence_ids.filter(id => id !== evidenceId) }))
              .filter(row => row.evidence_ids.length);
            collection[index] = currentItem;
            localDirty = true;
            render();
          }, "button secondary small");
          wrapper.append(remove);
          linked.append(wrapper);
        }
      }
    };
    const contextToken = contextGeneration;
    let candidateNext = { commercial_source: null, labor_analysis: null };
    let candidateRows = [];
    const candidateLoaded = { commercial_source: false, labor_analysis: false };
    const loadCandidatePage = async (type, offset) => {
      const result = await request(`/api/intake/candidates?candidate_type=${type}&offset=${offset}&limit=20`);
      if (contextToken !== contextGeneration || !details.isConnected) return;
      const rows = result.candidates || [];
      candidateRows.push(...rows.filter(row => !candidateRows.some(existing => existing.id === row.id)));
      sourceCandidates = [...sourceCandidates.filter(row => !rows.some(candidate => candidate.id === row.id)), ...rows];
      const next = result.next_offset;
      if (next !== null && (!Number.isInteger(next) || next <= offset || next > 100000)) throw new Error("来源分页游标无效");
      candidateNext[type] = next;
      candidateLoaded[type] = true;
    };
    const appendOptions = () => {
      for (const row of candidateRows) {
        if (candidateSelect.querySelector(`option[value="${row.id}"]`)) continue;
        candidateSelect.append(new Option(`${row.source_display_name || "导入文件"} · ${sourceTypeLabels[row.candidate_type] || "其他来源"} · 映射版本 ${row.mapping_revision} · ${row.id.slice(0, 8)}`, row.id));
      }
      if (Object.values(candidateNext).some(value => value !== null) && !candidateSelect.querySelector('option[value="__more__"]')) {
        candidateSelect.append(new Option("加载更多导入来源…", "__more__"));
      }
    };
    details.addEventListener("toggle", async () => {
      if (!details.open || Object.values(candidateLoaded).every(Boolean)) return;
      candidateSelect.disabled = fieldSelect.disabled = cellSelect.disabled = true;
      try {
        for (const type of Object.keys(candidateLoaded).filter(type => !candidateLoaded[type])) {
          try {
            await loadCandidatePage(type, 0);
            appendOptions();
          } catch (error) {
            details.append(node("p", "intake-message is-error", `来源读取失败：${error.message}。重新展开可重试。`));
          }
        }
        candidateSelect.disabled = busy || contextToken !== contextGeneration || !details.isConnected;
        if (!candidateRows.length) details.append(node("p", "intake-muted", "没有可选的采购/报价或工时估算候选。"));
      } finally {
        if (contextToken === contextGeneration && details.isConnected) {
          fieldSelect.disabled = cellSelect.disabled = busy;
          candidateSelect.disabled = busy || !Object.values(candidateLoaded).some(Boolean);
        }
      }
    });
    candidateSelect.addEventListener("change", () => {
      if (candidateSelect.value === "__more__") {
        candidateSelect.querySelector('option[value="__more__"]')?.remove();
        candidateSelect.disabled = true;
        Promise.all(Object.entries(candidateNext).filter(([, offset]) => offset !== null)
          .map(([type, offset]) => loadCandidatePage(type, offset))).then(() => appendOptions()).catch(error => {
            if (contextToken === contextGeneration) announce(`来源读取失败：${error.message}`, true);
          }).finally(() => { if (contextToken === contextGeneration && details.isConnected) candidateSelect.disabled = busy; });
        return;
      }
      fieldSelect.replaceChildren(new Option("选择来源字段…", ""));
      cellSelect.replaceChildren(new Option("再选择来源格", ""));
      const candidate = candidateRows.find(row => row.id === candidateSelect.value);
      for (const field of Object.keys(candidate?.fields || {})) fieldSelect.append(new Option(sourceFieldLabels[field] || "其他字段", field));
    });
    fieldSelect.addEventListener("change", () => {
      cellSelect.replaceChildren(new Option("选择工作表和单元格…", ""));
      const candidate = candidateRows.find(row => row.id === candidateSelect.value);
      for (const ref of candidate?.provenance?.[fieldSelect.value] || []) {
        const option = new Option(`工作表 ${ref.sheet_index} · ${ref.coordinate}`, `${ref.snapshot_id}|${ref.sheet_index}|${ref.coordinate}`);
        cellSelect.append(option);
      }
    });
    cellSelect.addEventListener("change", async () => {
      const candidate = candidateRows.find(row => row.id === candidateSelect.value);
      if (!candidate || !fieldSelect.value || !cellSelect.value) return;
      const candidateId = candidate.id;
      const fieldKey = fieldSelect.value;
      const [snapshot_id, sheetIndex, coordinate] = cellSelect.value.split("|");
      const token = contextGeneration;
      const requirementId = selected?.requirementId;
      const revisionId = selected?.revision?.id;
      const sourceIdentity = JSON.stringify([requirementId, revisionId, collection === materials ? "material" : "operation",
        index, candidateId, fieldKey, snapshot_id, Number(sheetIndex), coordinate]);
      const priorEvidence = sourceEvidenceRequests.get(sourceIdentity);
      busy = true; updateSave();
      try {
        let evidence = priorEvidence?.evidence;
        if (!evidence) {
          const requestKey = priorEvidence?.key || key();
          sourceEvidenceRequests.set(sourceIdentity, { key: requestKey });
          const created = await request(`/api/intake/candidates/${encodeURIComponent(candidateId)}/evidence`, {
            method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey },
            body: JSON.stringify({ schema_version: 1, kind: "source_record", field_key: fieldKey,
              snapshot_id, sheet_index: Number(sheetIndex), coordinate }),
          });
          evidence = created.evidence;
          sourceEvidenceRequests.set(sourceIdentity, { key: requestKey, evidence });
          sourceEvidenceMetadata.set(evidence.id, { candidate_id: candidateId, source_display_name: candidate.source_display_name,
            field_key: fieldKey, snapshot_id, sheet_index: Number(sheetIndex), coordinate });
        }
        if (!currentContext(token, requirementId, revisionId) || !details.isConnected) return;
        const currentItem = collection[index] || item;
        currentItem.sourceInputs ||= [];
        let reference = currentItem.sourceInputs.find(value => value.candidate_id === candidateId && value.field_key === fieldKey);
        if (!reference) { reference = { candidate_id: candidateId, field_key: fieldKey, evidence_ids: [] }; currentItem.sourceInputs.push(reference); }
        if (!reference.evidence_ids.includes(evidence.id)) reference.evidence_ids.push(evidence.id);
        collection[index] = currentItem;
        localDirty = true; renderLinked(); announce("已创建未核实来源引用；计划保存后将冻结到新版本。");
        render();
      } catch (error) {
        if (currentContext(token, requirementId, revisionId)) announce(`来源证据创建失败：${error.message}`, true);
      } finally {
        if (contextToken === contextGeneration) {
          busy = false;
          for (const control of content.querySelectorAll("input, textarea, select, button")) control.disabled = false;
          updateSave();
        }
      }
    });
    details.append(linked); parent.append(details); renderLinked();
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
      addSourceReferencePicker(form, item, materials, index);
      const values = () => ({ description: description.value || null, quantity: quantity.value || null, unit: unit.value || null, expected_date: expectedDate.value || null, support: selectedRefs(support), sourceInputs: item.sourceInputs || [] });
      [description, quantity, unit, expectedDate, ...support.querySelectorAll("input")].forEach(input => input.addEventListener("input", () => { materials[index] = values(); localDirty = true; updateSave(); }));
      support.addEventListener("change", () => { materials[index] = values(); localDirty = true; updateSave(); });
      form.append(button("移除", () => { materials.splice(index, 1); localDirty = true; render(); }));
      materialList.append(form);
      materials[index] = values();
    });
    materialList.append(button("添加物料提议", () => { materials.push({ description: "", quantity: "", unit: "", expected_date: "", support: [], sourceInputs: [] }); localDirty = true; render(); }, "button secondary small"));
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
      addSourceReferencePicker(form, item, operations, index);
      const values = () => ({ description: description.value || null, sequence: sequence.value, support: selectedRefs(support), sourceInputs: item.sourceInputs || [] });
      [description, sequence, ...support.querySelectorAll("input")].forEach(input => input.addEventListener("input", () => { operations[index] = values(); localDirty = true; updateSave(); }));
      support.addEventListener("change", () => { operations[index] = values(); localDirty = true; updateSave(); });
      form.append(button("移除", () => { operations.splice(index, 1); localDirty = true; render(); }));
      operationList.append(form);
      operations[index] = values();
    });
    operationList.append(button("添加工序提议", () => { operations.push({ description: "", sequence: "", support: [], sourceInputs: [] }); localDirty = true; render(); }, "button secondary small"));
    proposalArea.append(operationList);
    return proposalArea;
  }

  function updateSave() {
    const save = content.querySelector("[data-plan-save]");
    if (save) save.disabled = !activeConfirmed() || selected.dirty || selected.saving || busy || !localDirty;
    if (busy) content.querySelectorAll("input, textarea, select, button").forEach(control => { control.disabled = true; });
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
      const referencedItems = [...(plan.materials || []).map((item, index) => ({ item, label: `物料提议 ${index + 1}` })),
        ...(plan.operations || []).map((item, index) => ({ item, label: `工序提议 ${index + 1}` }))];
      for (const { item, label } of referencedItems) {
        for (const source of item.supporting_sources || []) {
          const typed = source.typed_value || {};
          const typedText = typed.state === "present" ? ` · ${String(typed.value ?? "（空值）").slice(0, 100)}` : ` · ${sourceStateLabels[typed.state] || "状态未知"}`;
          const provenance = node("small", "execution-plan-provenance", `${label} · 来源参考·未核实：${source.source_display_name || source.candidate_id} · ${sourceTypeLabels[source.candidate_type] || "来源参考"} · 映射版本 ${source.mapping_revision} · ${sourceFieldLabels[source.field_key] || "来源字段"} · 工作表 ${source.sheet_index}!${source.coordinate}${typedText}`);
          const trace = node("details", "execution-plan-trace");
          trace.append(node("summary", "", "查看来源标识"));
          trace.append(node("small", "", `候选 ${source.candidate_id} · 文件 SHA-256 ${source.source_sha256} · 快照 ${source.snapshot_id}`));
          if (opaque.test(source.source_id || "")) {
            const link = node("a", "", "打开原文件");
            link.href = businessUrl(`/api/intake/sources/${encodeURIComponent(source.source_id)}/download`);
            link.target = "_blank"; link.rel = "noopener";
            provenance.append(link);
          }
          row.append(provenance, trace);
        }
      }
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
    for (const control of content.querySelectorAll("input, textarea, select, button")) control.disabled = true;
    const sequenceInvalid = operations.some(item => item.sequence !== "" && (!/^[1-9]\d*$/.test(item.sequence) || !Number.isSafeInteger(Number(item.sequence))));
    if (sequenceInvalid) {
      announce("工序顺序必须是正整数；当前输入已保留。", true);
      for (const control of content.querySelectorAll("input, textarea, select, button")) control.disabled = false;
      updateSave();
      return;
    }
    const body = {
      requirement_revision_id: revision.id,
      expected_revision: latestRevision,
      requirement_refs: requirementRefs,
      materials: materials.map(item => ({ item_ref: null, resolution: "unresolved",
        proposal: { description: item.description || null, quantity: item.quantity || null, unit: item.unit || null, expected_date: item.expected_date || null },
        supporting_requirement_inputs: item.support || [], supporting_source_inputs: item.sourceInputs || [] })),
      operations: operations.map(item => ({ operation_ref: null, resolution: "unresolved",
        proposal: { description: item.description || null, sequence: item.sequence === "" ? null : Number(item.sequence) }, supporting_requirement_inputs: item.support || [], supporting_source_inputs: item.sourceInputs || [] })),
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
        for (const control of content.querySelectorAll("input, textarea, select, button")) control.disabled = false;
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
      sourceCandidates = [];
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
