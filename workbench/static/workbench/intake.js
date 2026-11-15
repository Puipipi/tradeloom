(() => {
  const root = document.querySelector('[data-testid="intake-workbench"]');
  if (!root) return;

  const schemas = JSON.parse(document.getElementById("intake-field-schemas")?.textContent || "{}");
  const csrfMeta = document.querySelector('meta[name="csrf-token"]')?.content || "";
  function currentCsrfToken() {
    let cookieText = "";
    try { cookieText = document.cookie; } catch { /* unavailable in this document context */ }
    const cookie = cookieText.split(";").map(part => part.trim()).find(part => part.startsWith("csrftoken="));
    if (!cookie) return csrfMeta;
    const value = cookie.slice("csrftoken=".length);
    try { return decodeURIComponent(value); } catch { return value; }
  }
  const businessUrl = globalThis.TradeLoomBusiness?.businessUrl || (value => value);
  const by = selector => document.querySelector(selector);
  const taskTabs = [...root.querySelectorAll("[data-intake-task-tab]")];
  const taskPanels = [...root.querySelectorAll("[data-intake-task-panel]")];
  const fileBrowser = document.querySelector("[data-file-browser]");
  const fileListPane = document.querySelector("[data-file-list-pane]");
  const filePreviewPane = document.querySelector("[data-file-preview-pane]");
  const filePreviewHost = document.querySelector("[data-file-source-preview]");
  const sourcePreview = root.querySelector(".intake-main-preview");
  const sourcePreviewParent = sourcePreview?.parentNode;
  const sourcePreviewNext = sourcePreview?.nextSibling;
  let activeTask = "sources";
  function selectIntakeTask(task, focus = false) {
    if (!taskTabs.some(tab => tab.dataset.intakeTaskTab === task)) return false;
    activeTask = task;
    for (const tab of taskTabs) {
      const selected = tab.dataset.intakeTaskTab === task;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of taskPanels) panel.hidden = panel.dataset.intakeTaskPanel !== task;
    if (focus) taskTabs.find(tab => tab.dataset.intakeTaskTab === task)?.focus();
    return true;
  }
  for (const [index, tab] of taskTabs.entries()) {
    tab.addEventListener("click", () => selectIntakeTask(tab.dataset.intakeTaskTab));
    tab.addEventListener("keydown", event => {
      let nextIndex = null;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % taskTabs.length;
      else if (event.key === "ArrowLeft") nextIndex = (index + taskTabs.length - 1) % taskTabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = taskTabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      selectIntakeTask(taskTabs[nextIndex].dataset.intakeTaskTab, true);
    });
  }
  function syncPanelFromHash() {
    const requestedPanel = window.location.hash.slice(1);
    const browserMode = ["files", "preview", "deliverables"].includes(requestedPanel) ? requestedPanel : "";
    if (browserMode) document.documentElement.dataset.businessBrowserMode = browserMode;
    else delete document.documentElement.dataset.businessBrowserMode;
    if (fileBrowser) {
      fileBrowser.hidden = !browserMode;
      root.hidden = Boolean(browserMode);
      const deliverables = document.querySelector("[data-deliverables-section]");
      if (deliverables) deliverables.hidden = Boolean(browserMode) || requestedPanel === "sources" || taskTabs.some(tab => tab.dataset.intakeTaskTab === requestedPanel);
      if (fileBrowser) fileBrowser.dataset.browserMode = browserMode;
      if (fileListPane) fileListPane.hidden = browserMode === "preview";
      if (filePreviewPane) filePreviewPane.hidden = browserMode === "files";
      if (sourcePreview && filePreviewHost && sourcePreviewParent) {
        if (browserMode && sourcePreview.parentNode !== filePreviewHost) filePreviewHost.append(sourcePreview);
        else if (!browserMode && sourcePreview.parentNode !== sourcePreviewParent) {
          sourcePreviewParent.insertBefore(sourcePreview, sourcePreviewNext?.parentNode === sourcePreviewParent ? sourcePreviewNext : null);
        }
        if (!browserMode) sourcePreview.hidden = false;
      }
    }
    if (taskTabs.some(tab => tab.dataset.intakeTaskTab === requestedPanel)) {
      selectIntakeTask(requestedPanel);
    } else if (requestedPanel === "sources") {
      selectIntakeTask("sources");
    }
    const target = !browserMode && requestedPanel === "sources"
      ? document.getElementById("source-intake")
      : null;
    if (target) {
      const scrollToTarget = () => {
        const scroller = document.scrollingElement || document.documentElement;
        const top = scroller.scrollTop + target.getBoundingClientRect().top;
        if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top });
        else scroller.scrollTop = top;
      };
      if (window.requestAnimationFrame) window.requestAnimationFrame(scrollToTarget);
      else scrollToTarget();
    }
  }
  syncPanelFromHash();
  window.addEventListener("hashchange", syncPanelFromHash);
  function announceSourcePreview(sourceId, phase, message = "") {
    window.dispatchEvent(new CustomEvent("tradeloom:source-preview-state", {
      detail: { sourceId, phase, message },
    }));
  }
  function notifyExecutionPlan(phase, overrides = {}) {
    const revision = viewedRevision || currentRequirement?.revision || null;
    root.dispatchEvent(new CustomEvent("tradeloom:requirement-context", { detail: {
      phase,
      candidateId: overrides.candidateId ?? selectedCandidate?.id ?? "",
      requirementId: overrides.requirementId ?? currentRequirement?.draft?.id ?? "",
      revision: overrides.revision === undefined ? revision : overrides.revision,
      status: revision?.status || "",
      dirty: overrides.dirty === true,
      saving: overrides.saving ?? requirementMutation,
    }}));
  }
  const messages = {
    invalid_source: "文件无法安全接收或解析，请检查文件后重试。",
    private_store_unavailable: "私有来源目录尚未就绪，暂时不能上传。",
    preview_not_found: "预览已不可用，请刷新来源列表后重试。",
    invalid_arguments: "请求参数无效，请重新选择区域或字段。",
    stale_mapping: "来源版本已变化，请重新载入预览。",
    unsupported_candidate_type: "候选类别不可用。",
    unknown_field: "字段不在当前类别的允许范围内。",
    unavailable: "资料服务暂时不可用，请稍后重试。",
    invalid_requirement: "草稿请求无效，请检查字段或重新读取此版本。",
    invalid_requirement_fields: "部分字段的格式或长度不正确，请检查后保存。",
    invalid_requirement_evidence: "出处或行范围无效，请重新选择对应资料。",
    invalid_application: "确认请求不符合允许字段或目标格式，请检查后重试。",
    invalid_application_source: "来源字段不在当前候选中，请重新选择出处。",
    unresolved_application_source: "所选候选字段尚未解析为可确认值，请检查字段状态。",
    incomplete_source_unit: "尺寸或卷长来源需要同时选择数值和单位。",
    stale_product: "目标产品已产生新版本，请重新打开候选并核对后再提交。",
    stale_mapping: "来源或映射版本已变化，请重新打开候选并确认当前版本。",
    stale_source: "来源文件版本已变化，请重新读取候选。",
    unsupported_schema: "此候选使用当前不支持的字段版本，无法应用。",
    unsupported_candidate_type: "此候选类别不能应用为产品资料。",
    invalid_idempotency_key: "保存请求标识无效，请刷新候选后重试。",
    application_unavailable: "已保存结果暂时无法读取，请稍后重开候选查看记录。",
    required_identity_fields: "SKU 和名称必须保留为非空值。",
    target_mismatch: "所选产品不属于目标任务，请重新选择。",
    requirement_source_value_mismatch: "修改值与原单元格不一致，请提供修改依据或保留待确认。",
    stale_requirement: "其他操作已更新此草稿。请重新读取当前版本，再核对你的修改。",
    unresolved_requirement: "仍有待确认字段，请先补充内容和出处。",
    requirement_exists: "这份候选已有草稿，正在读取已有记录。",
    narrative_not_found: "文字资料不存在，请刷新资料列表后重试。",
    invalid_narrative: "请选择有效的 UTF-8 文本文件，大小不超过 2 MiB。",
    already_confirmed: "此版本已确认，请重新读取当前记录。",
  };
  const typeLabels = {
    product_identity: "产品身份候选",
    commercial_source: "商业单据候选（角色和价格性质待确认）",
    production_instruction: "生产指令候选（历史或参考性质待确认）",
    labor_analysis: "工时分析候选（不代表员工实报工时）",
  };
  const narrativeSourceKindLabels = {
    transcript_excerpt: "录音转写摘录", secondary_summary_analysis: "二手整理与分析",
    user_supplement: "用户补充", unknown: "未知",
  };
  const narrativeAudioStatusLabels = {
    unknown: "未知", not_checked: "未核听", operator_claimed_checked: "录入者表示已核听",
  };
  const fieldLabels = {
    product_identity: {
      style_number: "款号", description: "产品描述", customer_item_code: "客户货号", width: "宽度",
      width_unit: "宽度单位", color: "颜色", roll_length: "卷长", roll_length_unit: "卷长单位",
      packing: "包装说明", barcode: "条码",
    },
    commercial_source: {
      document_reference: "单据编号", party_text: "往来方文字", item_description: "货品描述", quantity: "数量",
      unit: "单位", unit_price: "单价", amount: "金额", currency: "币种", notes: "备注",
    },
    production_instruction: {
      source_order_reference: "来源订单编号", description: "品名描述", specification: "规格", color: "颜色",
      quantity: "数量", unit: "单位", packing: "包装说明", carton_count: "箱数",
      barcode_requirement: "条码要求", due_date: "交期", requirement_text: "要求文字",
      pack_quantity: "每包装数量", pack_unit: "包装单位",
    },
    labor_analysis: {
      process: "工序", observed_seconds: "测时秒数", observed_quantity: "测量数量", observed_unit: "测量单位",
      estimated_hourly_rate: "测算时薪", estimated_efficiency: "测算效率", estimated_capacity: "测算产能",
      estimated_piece_rate: "测算计件单价", notes: "备注",
    },
  };
  const valueTypeLabels = { text: "文字", decimal: "数字", date: "日期" };
  const valueStateLabels = {
    present: "已读取", empty: "空白", type_mismatch: "类型不匹配", formula_error: "公式错误",
    formula_cache_missing: "缺少公式缓存", formula_cache_empty: "公式缓存为空",
  };
  const candidateStatusLabels = { unconfirmed: "待确认", pending: "待确认", confirmed: "已确认", rejected: "已拒绝" };
  const requirementFieldLabels = {
    source_order_reference: "来源订单编号", description: "品名描述", specification: "规格", color: "颜色",
    quantity: "数量", unit: "单位", packing: "包装说明", carton_count: "箱数",
    barcode_requirement: "条码要求", due_date: "交期", requirement_text: "要求文字",
    pack_quantity: "每包装数量", pack_unit: "包装单位", customer_ref: "客户引用", item_ref: "商品引用",
  };
  const requirementFieldTypes = {
    source_order_reference: "text", description: "text", specification: "text", color: "text",
    quantity: "decimal", unit: "text", packing: "text", carton_count: "decimal",
    barcode_requirement: "text", due_date: "date", requirement_text: "text",
    pack_quantity: "decimal", pack_unit: "text", customer_ref: "customer_ref", item_ref: "item_ref",
  };
  const evidenceKindLabels = {
    source_record: "原始单元格", operator_statement: "说明摘录（待核实）", team_hypothesis: "团队设想（待确认）",
    system_derivation: "程序测算（待确认）",
  };
  const requirementStatusLabels = { needs_confirmation: "待确认", confirmed: "已确认（本地）" };
  const requirementReasonLabels = {
    ...valueStateLabels, missing: "尚未提供", invalid: "来源格式无效", missing_value: "尚未填写有效内容",
    source_value_unresolved: "来源值暂不能用于此字段", source_reference_unresolved: "出处待核对",
    value_without_source: "修改依据待补充", unverified_proposal: "设想或测算尚待核实",
  };
  let sources = [];
  let selectedSourceId = "";
  let pendingExternalSourceId = "";
  let previewId = "";
  let previewData = null;
  let currentMappingId = "";
  let pendingUpload = null;
  let pendingUploadKey = "";
  let fieldsByType = {};
  let activeField = "";
  let selectedType = "";
  let sourceGeneration = 0;
  let windowGeneration = 0;
  let mappingGeneration = 0;
  let candidateGeneration = 0;
  let pendingMappingSave = null;
  let candidateReceipt = null;
  let selectedCandidate = null;
  let currentRequirement = null;
  let viewedRevision = null;
  let revisionOffset = 0;
  let selectedNarrativeId = "";
  let narrativeSources = [];
  let pendingNarrativeUpload = null;
  let pendingNarrativeKey = "";
  let requirementGeneration = 0;
  let historyGeneration = 0;
  let narrativeGeneration = 0;
  let narrativeListGeneration = 0;
  let annotationGeneration = 0;
  let annotationCurrent = null;
  let annotationOffset = 0;
  let annotationDrafts = new Map();
  let annotationKeys = new Map();
  let annotationBusy = false;
  let requirementMutation = false;
  let narrativeUploadBusy = false;

  function key() {
    return globalThis.crypto?.randomUUID?.().replaceAll("-", "") || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function request(url, options = {}) {
    const csrfToken = currentCsrfToken();
    const response = await fetch(businessUrl(url), {
      credentials: "same-origin",
      ...options,
      headers: { "X-CSRFToken": csrfToken, ...(options.headers || {}) },
    });
    const type = response.headers.get("content-type") || "";
    const body = type.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const error = new Error(messages[body?.error_code] || `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.code = body?.error_code || "unavailable";
      throw error;
    }
    return body;
  }

  function setMessage(element, text, isError = false) {
    element.textContent = text;
    element.classList.toggle("is-error", isError);
  }

  function previewUrl(snapshotId) {
    return root.dataset.previewUrl.replace("__SNAPSHOT__", encodeURIComponent(snapshotId));
  }

  function renderSources() {
    const list = by("[data-testid='intake-sources']");
    list.replaceChildren();
    if (!sources.length) {
      const empty = document.createElement("p");
      empty.className = "intake-muted";
      empty.textContent = "尚未接收来源工作簿。";
      list.append(empty);
      return;
    }
    for (const source of sources) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "intake-source-item";
      button.dataset.sourceId = source.id;
      button.setAttribute("aria-current", String(source.id === selectedSourceId));
      const title = document.createElement("strong");
      title.textContent = source.display_name || `工作簿-${source.id.slice(0, 8)}.xlsx`;
      const detail = document.createElement("small");
      const latest = source.snapshots?.[0];
      detail.textContent = `${source.byte_size} bytes · ${latest ? `解析 ${latest.status === "ready" ? "已就绪" : "未完成"}` : "尚未解析"}`;
      button.append(title, detail);
      button.addEventListener("click", () => openSource(source.id));
      list.append(button);
    }
  }

  async function refreshSources() {
    const list = by("[data-testid='intake-sources']");
    list.setAttribute("aria-busy", "true");
    try {
      const body = await request(root.dataset.sourcesUrl);
      sources = body.sources || [];
      renderSources();
      if (pendingExternalSourceId && sources.some(source => source.id === pendingExternalSourceId)) {
        const sourceId = pendingExternalSourceId;
        pendingExternalSourceId = "";
        openSource(sourceId);
      }
    } catch (error) {
      list.textContent = error.message;
    } finally {
      list.removeAttribute("aria-busy");
    }
  }

  function enablePreviewControls(sheets) {
    const select = by("[data-intake-sheet]");
    select.replaceChildren();
    for (const sheet of sheets) {
      const option = document.createElement("option");
      option.value = String(sheet.sheet_index);
      option.textContent = `${sheet.sheet_index}. ${sheet.title}`;
      select.append(option);
    }
    for (const selector of ["[data-intake-sheet]", "[data-intake-row-start]", "[data-intake-col-start]", "[data-intake-load-window]"]) {
      by(selector).disabled = sheets.length === 0;
    }
    by("[data-intake-sheet-details]").hidden = sheets.length === 0;
    renderSheetMetadata(sheets);
  }

  function renderSheetMetadata(sheets) {
    const container = by("[data-intake-sheet-metadata]");
    container.replaceChildren();
    for (const sheet of sheets) {
      const block = document.createElement("div");
      block.className = "intake-sheet-info";
      const title = document.createElement("strong");
      title.textContent = `${sheet.title} · ${sheet.dimensions || "尺寸未知"}`;
      const merged = document.createElement("small");
      merged.textContent = sheet.merged_ranges?.length ? `合并区域：${sheet.merged_ranges.join("、")}` : "没有合并区域";
      const warnings = document.createElement("small");
      warnings.textContent = sheet.warnings?.length ? `解析提示：${sheet.warnings.join("、")}` : "没有解析提示";
      block.append(title, merged, warnings);
      container.append(block);
    }
  }

  function cellDisplay(cell) {
    const parts = [];
    if (cell.blank) return ["", "空单元格"];
    const cache = cell.cached_value?.state;
    if (cell.formula) {
      parts.push(cell.formula.startsWith("=") ? cell.formula : `=${cell.formula}`);
      if (cache === "present") parts.push(`缓存：${JSON.stringify(cell.cached_value.value)}`);
      else if (cache === "empty") parts.push("缓存为空");
      else if (cache === "missing") parts.push("没有保存公式缓存");
    } else {
      const value = cell.normalized_value;
      if (value !== null && value !== undefined) parts.push(typeof value === "object" ? JSON.stringify(value) : String(value));
      else if (cell.raw_value?.v_lexeme !== null && cell.raw_value?.v_lexeme !== undefined) parts.push(String(cell.raw_value.v_lexeme));
    }
    if (cell.error_code === "cached_formula_error") parts.push("公式缓存为错误值");
    return [parts[0] || "", parts.slice(1).join(" · ") || (cell.formula_status ? `类型：${cell.formula_status}` : "")];
  }

  function renderImages(images) {
    const container = by("[data-intake-images]");
    container.replaceChildren();
    for (const image of images || []) {
      const figure = document.createElement("figure");
      const caption = document.createElement("figcaption");
      caption.textContent = `${image.kind === "rich_data" ? "单元格图片" : "浮动图片"} · ${image.coordinate || "锚点未知"}${image.warning_code ? ` · ${image.warning_code}` : ""}`;
      if (image.preview_url) {
        const img = document.createElement("img");
        img.src = businessUrl(image.preview_url);
        img.alt = `工作表图片 ${image.coordinate || "锚点"}`;
        img.loading = "lazy";
        figure.append(img);
      }
      figure.append(caption);
      container.append(figure);
    }
  }

  function renderGrid(body) {
    const host = by("[data-testid='intake-preview-grid']");
    const renderedSheetIndex = Number(body.window?.sheet_index ?? by("[data-intake-sheet]").value);
    host.replaceChildren();
    const table = document.createElement("table");
    table.className = "intake-grid";
    table.setAttribute("aria-label", "单元格来源预览");
    const head = document.createElement("thead");
    const header = document.createElement("tr");
    const corner = document.createElement("th");
    corner.textContent = "行 / 列";
    header.append(corner);
    const firstRow = body.rows?.[0] || [];
    for (const cell of firstRow) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = cell.coordinate.replace(/[0-9]/g, "");
      header.append(th);
    }
    head.append(header);
    table.append(head);
    const tbody = document.createElement("tbody");
    for (const row of body.rows || []) {
      const tr = document.createElement("tr");
      const rowHead = document.createElement("th");
      rowHead.scope = "row";
      rowHead.className = "intake-coordinate";
      rowHead.textContent = row[0]?.coordinate.match(/[0-9]+$/)?.[0] || "";
      tr.append(rowHead);
      for (const cell of row) {
        const td = document.createElement("td");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "intake-cell-pick";
        button.dataset.coordinate = cell.coordinate;
        button.setAttribute("aria-pressed", "false");
        const [value, meta] = cellDisplay(cell);
        button.textContent = value;
        if (meta) {
          const detail = document.createElement("small");
          detail.className = "intake-cell-meta";
          detail.textContent = meta;
          button.append(detail);
        }
        button.addEventListener("click", () => {
          if (button.isConnected) mapCell(cell, renderedSheetIndex);
        });
        td.append(button);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    host.append(table);
    renderImages(body.images);
    updateGridSelection();
  }

  function updateGridSelection() {
    const selected = currentMappings()[activeField] || [];
    for (const button of by("[data-testid='intake-preview-grid']").querySelectorAll("[data-coordinate]")) {
      const pressed = selected.some(item => item.sheet_index === Number(by("[data-intake-sheet]").value)
        && item.coordinate === button.dataset.coordinate);
      button.setAttribute("aria-pressed", String(pressed));
    }
  }

  function invalidateMapping() {
    mappingGeneration += 1;
    currentMappingId = "";
    pendingMappingSave = null;
    candidateReceipt = null;
    by("[data-intake-create-candidate]").disabled = true;
    updateGridSelection();
  }

  function resetSourceView() {
    requirementGeneration += 1;
    historyGeneration += 1;
    requirementMutation = false;
    mappingGeneration += 1;
    previewId = "";
    previewData = null;
    currentMappingId = "";
    selectedType = "";
    activeField = "";
    selectedCandidate = null;
    currentRequirement = null;
    viewedRevision = null;
    notifyExecutionPlan("cleared", { saving: false });
    by("[data-testid='intake-requirement-workspace']").replaceChildren();
    by("[data-intake-requirement-context]").textContent = "先选择一个生产指令候选。";
    fieldsByType = {};
    pendingMappingSave = null;
    candidateReceipt = null;
    candidateGeneration += 1;
    by("[data-testid='intake-preview-grid']").replaceChildren();
    by("[data-testid='intake-preview-grid']").removeAttribute("aria-busy");
    by("[data-intake-images]").replaceChildren();
    by("[data-intake-sheet-metadata]").replaceChildren();
    by("[data-intake-sheet]").replaceChildren();
    by("[data-intake-sheet-details]").hidden = true;
    by("[data-testid='intake-mapping']").replaceChildren();
    by("[data-intake-candidate-detail]").replaceChildren();
    by("[data-intake-candidate-detail]").hidden = true;
    for (const selector of ["[data-intake-sheet]", "[data-intake-row-start]", "[data-intake-col-start]", "[data-intake-load-window]", "[data-intake-candidate-type]", "[data-intake-active-field]", "[data-intake-save-mapping]", "[data-intake-create-candidate]"]) {
      by(selector).disabled = true;
    }
  }

  function currentMappings() {
    if (!fieldsByType[selectedType]) fieldsByType[selectedType] = {};
    return fieldsByType[selectedType];
  }

  function hasSelectedCells() {
    return Object.values(currentMappings()).some(cells => Array.isArray(cells) && cells.length > 0);
  }

  function renderFieldMappings() {
    const target = by("[data-testid='intake-mapping']");
    target.replaceChildren();
    const fields = schemas[selectedType] || {};
    const mappings = currentMappings();
    for (const [name, type] of Object.entries(fields)) {
      const row = document.createElement("div");
      row.className = "intake-field-map-item";
      row.dataset.field = name;
      const label = document.createElement("strong");
      label.textContent = fieldLabels[selectedType]?.[name] || name;
      const helper = document.createElement("small");
      helper.textContent = `数据类型：${valueTypeLabels[type] || type} · ${mappings[name]?.length ? mappings[name].map(cell => `${cell.sheet_index}!${cell.coordinate}`).join("、") : "尚未选择来源单元格"}`;
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "button secondary small";
      clear.textContent = "清除此字段";
      clear.disabled = !mappings[name]?.length;
      clear.addEventListener("click", () => {
        delete mappings[name];
        invalidateMapping();
        renderFieldMappings();
        setMessage(by("[data-intake-mapping-message]"), `已清除“${fieldLabels[selectedType]?.[name] || name}”的来源。`);
        by("[data-intake-save-mapping]").disabled = !previewId || !hasSelectedCells();
      });
      row.append(label, helper, clear);
      target.append(row);
    }
  }

  function mapCell(cell, sheetIndex) {
    if (!selectedType || !activeField || !schemas[selectedType]?.[activeField]) return;
    const selected = currentMappings()[activeField] || [];
    const requested = { sheet_index: sheetIndex, coordinate: cell.coordinate };
    const existingIndex = selected.findIndex(item => item.sheet_index === requested.sheet_index && item.coordinate === requested.coordinate);
    if (existingIndex >= 0) {
      selected.splice(existingIndex, 1);
    } else {
      selected.push(requested);
      currentMappings()[activeField] = selected;
    }
    invalidateMapping();
    renderFieldMappings();
    setMessage(by("[data-intake-mapping-message]"), existingIndex >= 0
      ? `已取消 ${cell.coordinate} 的来源选择。`
      : `已将 ${cell.coordinate} 指定为 ${fieldLabels[selectedType]?.[activeField] || activeField} 的来源。`);
    by("[data-intake-save-mapping]").disabled = !previewId || !hasSelectedCells();
  }

  async function loadWindow() {
    if (!previewId) return;
    const generation = sourceGeneration;
    const requestGeneration = ++windowGeneration;
    const requestedSourceId = selectedSourceId;
    const requestedPreviewId = previewId;
    const rowStart = Number(by("[data-intake-row-start]").value);
    const colStart = Number(by("[data-intake-col-start]").value);
    const sheetIndex = Number(by("[data-intake-sheet]").value);
    const params = new URLSearchParams({
      sheet_index: String(sheetIndex), row_start: String(rowStart), row_count: "20",
      col_start: String(colStart), col_count: "10",
    });
    const status = by("[data-intake-preview-status]");
    const host = by("[data-testid='intake-preview-grid']");
    host.replaceChildren();
    host.setAttribute("aria-busy", "true");
    renderImages([]);
    status.textContent = "正在读取单元格…";
    try {
      const body = await request(`${previewUrl(requestedPreviewId)}?${params}`);
      if (generation !== sourceGeneration || requestGeneration !== windowGeneration || requestedSourceId !== selectedSourceId || requestedPreviewId !== previewId) return;
      previewData = body;
      renderGrid(body);
      host.removeAttribute("aria-busy");
      status.textContent = `${body.preview.status === "ready" ? "解析就绪" : "解析未完成"} · ${body.preview.cell_count} 个非空单元格`;
      by("[data-intake-save-mapping]").disabled = !selectedType;
    } catch (error) {
      if (generation !== sourceGeneration || requestGeneration !== windowGeneration || requestedSourceId !== selectedSourceId || requestedPreviewId !== previewId) return;
      host.removeAttribute("aria-busy");
      status.textContent = error.message;
    }
  }

  async function openSource(sourceId) {
    const generation = ++sourceGeneration;
    windowGeneration += 1;
    selectedSourceId = sourceId;
    resetSourceView();
    renderSources();
    setMessage(by("[data-intake-mapping-message]"), "");
    const status = by("[data-intake-preview-status]");
    status.textContent = "正在解析来源…";
    announceSourcePreview(sourceId, "loading", status.textContent);
    const button = by("[data-intake-load-window]");
    button.disabled = true;
    try {
      const url = root.dataset.sourcePreviewUrl.replace("__SOURCE__", encodeURIComponent(sourceId));
      const body = await request(url, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() }, body: "{}",
      });
      if (generation !== sourceGeneration || selectedSourceId !== sourceId) return;
      previewId = body.preview.id;
      const detail = await request(previewUrl(previewId));
      if (generation !== sourceGeneration || selectedSourceId !== sourceId || previewId !== body.preview.id) return;
      previewData = detail;
      window.dispatchEvent(new CustomEvent("tradeloom:source-images", { detail: { sourceId, images: detail.images || [] } }));
      enablePreviewControls(detail.sheets || []);
      if (detail.sheets?.length) await loadWindow();
      else status.textContent = "此来源没有可预览的工作表。";
      announceSourcePreview(sourceId, detail.sheets?.length ? "ready" : "empty", status.textContent);
      if (generation === sourceGeneration && selectedSourceId === sourceId) populateTypeOptions();
    } catch (error) {
      if (generation !== sourceGeneration || selectedSourceId !== sourceId) return;
      status.textContent = error.message;
      by("[data-testid='intake-preview-grid']").textContent = "请先刷新来源列表；若解析失败，原件仍会保留。";
      announceSourcePreview(sourceId, "error", status.textContent);
    }
  }

  window.addEventListener("tradeloom:file-selection", event => {
    const detail = event.detail;
    if (!detail || detail.kind !== "source" || typeof detail.id !== "string" || !detail.id || detail.id.length > 128) return;
    if (sources.some(source => source.id === detail.id)) openSource(detail.id);
    else pendingExternalSourceId = detail.id;
  });

  function populateTypeOptions() {
    const select = by("[data-intake-candidate-type]");
    select.replaceChildren();
    const first = document.createElement("option");
    first.value = "";
    first.textContent = "请选择候选类别";
    select.append(first);
    for (const type of Object.keys(schemas)) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = typeLabels[type] || type;
      select.append(option);
    }
    select.value = "";
    select.disabled = !previewId;
    by("[data-intake-active-field]").replaceChildren();
    by("[data-intake-active-field]").disabled = true;
    by("[data-intake-save-mapping]").disabled = true;
    by("[data-intake-create-candidate]").disabled = true;
    by("[data-testid='intake-mapping']").replaceChildren();
  }

  function populateFields() {
    const select = by("[data-intake-active-field]");
    select.replaceChildren();
    for (const name of Object.keys(schemas[selectedType] || {})) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = `${fieldLabels[selectedType]?.[name] || name}（${valueTypeLabels[schemas[selectedType][name]] || schemas[selectedType][name]}）`;
      select.append(option);
    }
    activeField = select.value;
    select.disabled = !activeField;
    renderFieldMappings();
    by("[data-intake-save-mapping]").disabled = true;
  }

  async function saveMapping() {
    const status = by("[data-intake-mapping-message]");
    const fields = {};
    for (const [name, cells] of Object.entries(currentMappings())) if (cells.length) fields[name] = { cells };
    if (!Object.keys(fields).length) {
      setMessage(status, "请先在网格中选择至少一个来源单元格。", true);
      return;
    }
    const existing = previewData.mapping_revisions?.find(item => item.candidate_type === selectedType);
    const body = {
      schema_version: 1, candidate_type: selectedType,
      source_sha256: previewData.preview.source_sha256,
      expected_revision: existing?.revision || 0, fields,
    };
    const payload = JSON.stringify(body);
    if (!pendingMappingSave || pendingMappingSave.payload !== payload || pendingMappingSave.previewId !== previewId) {
      pendingMappingSave = { payload, previewId, key: key() };
    }
    const requestGeneration = sourceGeneration;
    const requestMappingGeneration = mappingGeneration;
    const requestSourceId = selectedSourceId;
    const requestPreviewId = previewId;
    const requestType = selectedType;
    by("[data-intake-save-mapping]").disabled = true;
    try {
      const url = root.dataset.mappingUrl.replace("__SNAPSHOT__", encodeURIComponent(requestPreviewId));
      const result = await request(url, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": pendingMappingSave.key },
        body: payload,
      });
      if (requestGeneration !== sourceGeneration || requestSourceId !== selectedSourceId || requestPreviewId !== previewId) return;
      previewData.mapping_revisions = [...(previewData.mapping_revisions || []).filter(item => item.candidate_type !== requestType),
        { candidate_type: requestType, revision: result.mapping.revision, id: result.mapping.id }];
      if (requestMappingGeneration !== mappingGeneration || requestType !== selectedType) return;
      currentMappingId = result.mapping.id;
      candidateReceipt = null;
      pendingMappingSave = null;
      by("[data-intake-create-candidate]").disabled = false;
      setMessage(status, `映射版本 ${result.mapping.revision} 已保存。`);
    } catch (error) {
      if (requestGeneration !== sourceGeneration || requestMappingGeneration !== mappingGeneration || requestSourceId !== selectedSourceId || requestPreviewId !== previewId || requestType !== selectedType) return;
      setMessage(status, error.message, true);
      by("[data-intake-save-mapping]").disabled = false;
    }
  }

  async function createCandidate() {
    if (!currentMappingId) return;
    const requestGeneration = sourceGeneration;
    const requestSourceId = selectedSourceId;
    const mappingId = currentMappingId;
    if (!candidateReceipt || candidateReceipt.mappingId !== mappingId) candidateReceipt = { mappingId, key: key(), candidateId: "" };
    if (candidateReceipt.candidateId) {
      await showCandidate(candidateReceipt.candidateId);
      return;
    }
    try {
      const url = root.dataset.candidateCreateUrl.replace("__MAPPING__", encodeURIComponent(mappingId));
      const body = await request(url, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": candidateReceipt.key }, body: "{}",
      });
      if (requestGeneration !== sourceGeneration || requestSourceId !== selectedSourceId || mappingId !== currentMappingId) return;
      candidateReceipt.candidateId = body.candidate.id;
      setMessage(by("[data-intake-mapping-message]"), `候选已保存，状态：${body.candidate.status}。`);
      await refreshCandidates();
      showCandidate(body.candidate.id);
    } catch (error) {
      if (requestGeneration !== sourceGeneration || requestSourceId !== selectedSourceId || mappingId !== currentMappingId) return;
      setMessage(by("[data-intake-mapping-message]"), error.message, true);
    }
  }

  async function refreshCandidates() {
    const list = by("[data-testid='intake-candidates']");
    try {
      const body = await request(root.dataset.candidatesUrl);
      list.replaceChildren();
      if (!body.candidates?.length) {
        list.textContent = "尚无待确认候选。";
        return;
      }
      for (const candidate of body.candidates) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "intake-candidate-item";
        button.dataset.candidateId = candidate.id;
        const title = document.createElement("strong");
        title.textContent = typeLabels[candidate.candidate_type] || candidate.candidate_type;
        const detail = document.createElement("small");
        detail.textContent = `${candidateStatusLabels[candidate.status] || "状态待核对"} · 原件出处已保留`;
        button.append(title, detail);
        button.addEventListener("click", () => showCandidate(candidate.id));
        list.append(button);
      }
    } catch (error) {
      list.textContent = error.message;
    }
  }

  async function showCandidate(candidateId) {
    const detail = by("[data-intake-candidate-detail]");
    const generation = ++candidateGeneration;
    selectedCandidate = null;
    currentRequirement = null;
    viewedRevision = null;
    requirementGeneration += 1;
    historyGeneration += 1;
    requirementMutation = false;
    notifyExecutionPlan("loading", { candidateId, requirementId: "", revision: null, saving: false });
    const sourceId = selectedSourceId;
    try {
      const url = root.dataset.candidateUrl.replace("__CANDIDATE__", encodeURIComponent(candidateId));
      const body = await request(url);
      if (generation !== candidateGeneration || sourceId !== selectedSourceId) return;
      renderCandidateDetail(detail, body);
      detail.hidden = false;
      if (body.candidate?.candidate_type === "production_instruction") await openRequirement(body.candidate);
      else {
        requirementGeneration += 1;
        historyGeneration += 1;
        requirementMutation = false;
        selectedCandidate = null;
        currentRequirement = null;
        notifyExecutionPlan("cleared", { saving: false });
        by("[data-testid='intake-requirement-workspace']").replaceChildren(node("p", "intake-muted", "只有生产指令候选可以进入需求草稿。"));
      }
    } catch (error) {
      if (generation !== candidateGeneration || sourceId !== selectedSourceId) return;
      notifyExecutionPlan("cleared", { candidateId: "", requirementId: "", revision: null, saving: false });
      detail.textContent = error.message;
      detail.hidden = false;
    }
  }

  function renderCandidateDetail(container, body) {
    container.replaceChildren();
    const candidate = body.candidate || {};
    const heading = document.createElement("h4");
    heading.textContent = `${typeLabels[candidate.candidate_type] || candidate.candidate_type || "待确认候选"} · ${candidateStatusLabels[candidate.status] || candidate.status || "状态未知"}`;
    container.append(heading);

    const fieldsHeading = document.createElement("h5");
    fieldsHeading.textContent = "候选字段";
    container.append(fieldsHeading);
    const list = document.createElement("dl");
    const definedFields = schemas[candidate.candidate_type] || {};
    for (const name of Object.keys(definedFields)) {
      const values = candidate.fields?.[name];
      const label = document.createElement("dt");
      label.textContent = fieldLabels[candidate.candidate_type]?.[name] || name;
      list.append(label);
      const value = document.createElement("dd");
      const entries = Array.isArray(values) ? values : [];
      value.textContent = !values ? "未提供映射" : entries.length ? entries.map(entry => {
        const state = valueStateLabels[entry.state] || entry.state || "状态未知";
        return ["present", "type_mismatch"].includes(entry.state)
          ? `${state}：${typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)}` : state;
      }).join("；") : "没有映射值";
      list.append(value);
      const refs = candidate.provenance?.[name] || [];
      if (refs.length) {
        const provenance = document.createElement("dd");
        provenance.className = "intake-muted";
        provenance.textContent = `来源：${refs.map(ref => `${ref.sheet_title || `工作表 ${ref.sheet_index}`}!${ref.coordinate}`).join("、")}`;
        list.append(provenance);
      }
    }
    container.append(list);

    if (candidate.candidate_type === "product_identity" && globalThis.TradeLoomIntakeProductApplication) {
      globalThis.TradeLoomIntakeProductApplication.attach({
        container, candidate, applications: body.applications || [],
        applicationsNextOffset: body.applications_next_offset,
        root, request, keyFactory: key,
      });
    }

    if (Array.isArray(body.links) && body.links.length) {
      const links = document.createElement("p");
      links.className = "intake-muted";
      const hasOlderLinks = Number.isInteger(body.links_next_offset) && body.links_next_offset > 0;
      links.textContent = `关联判断历史预览：最近 ${body.links.length} 条${hasOlderLinks
        ? "；还有更早记录，完整历史请在资料候选关联工作区查看。" : "。"}`;
      container.append(links);
    }
    const advanced = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "高级详情（原始 JSON）";
    const raw = document.createElement("pre");
    raw.textContent = JSON.stringify({ candidate, links: body.links || [] }, null, 2);
    advanced.append(summary, raw);
    container.append(advanced);
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function narrativeLinesUrl(id) {
    return root.dataset.narrativeLinesUrl.replace("__NARRATIVE__", encodeURIComponent(id));
  }

  function narrativeAnnotationsUrl(id) {
    return root.dataset.narrativeAnnotationsUrl.replace("__NARRATIVE__", encodeURIComponent(id));
  }

  function renderAnnotation(data, history = []) {
    const panel = by("[data-testid='intake-narrative-annotation']");
    panel.hidden = false;
    const summary = by("[data-intake-annotation-summary]");
    const edit = by("[data-intake-annotation-edit]");
    const form = by("[data-intake-annotation-form]");
    annotationCurrent = data?.current || null;
    summary.textContent = annotationCurrent
      ? `第 ${annotationCurrent.revision} 版 · ${narrativeSourceKindLabels[annotationCurrent.source_kind] || "未知"} · ${annotationCurrent.recording_date || "录音日期未知"} · ${narrativeAudioStatusLabels[annotationCurrent.audio_review_status] || "未知"} · 内容待确认`
      : "尚未记录来源说明。摘录和整理内容仍未确认。";
    edit.textContent = annotationCurrent ? "编辑来源说明" : "添加来源说明";
    if (!form.dataset.dirty) {
      const draft = annotationDrafts.get(selectedNarrativeId) || annotationCurrent || {
        source_kind: "unknown", recording_date: null, audio_review_status: "unknown",
      };
      form.elements.source_kind.value = draft.source_kind || "unknown";
      form.elements.recording_date.value = draft.recording_date || "";
      form.elements.audio_review_status.value = draft.audio_review_status || "unknown";
      form.elements.content_status.value = "unconfirmed";
    }
    const historyHost = by("[data-intake-annotation-history-list]");
    if (!historyHost.hidden) {
      historyHost.replaceChildren();
      for (const item of history) historyHost.append(node("p", "intake-muted", `第 ${item.revision} 版 · ${narrativeSourceKindLabels[item.source_kind] || "未知"} · ${item.recording_date || "录音日期未知"} · ${narrativeAudioStatusLabels[item.audio_review_status] || "未知"} · 内容待确认`));
      if (data?.next_offset !== null && data?.next_offset !== undefined) {
        const more = node("button", "button secondary small", "载入后续版本"); more.type = "button";
        more.addEventListener("click", () => loadNarrativeAnnotations(selectedNarrativeId, data.next_offset));
        historyHost.append(more);
      }
    }
  }

  async function loadNarrativeAnnotations(narrativeId, offset = 0) {
    const generation = ++annotationGeneration;
    annotationOffset = offset;
    const panel = by("[data-testid='intake-narrative-annotation']");
    panel.hidden = false;
    const listedSource = narrativeSources.find(source => source.id === narrativeId);
    annotationCurrent = listedSource?.current_annotation || null;
    by("[data-intake-annotation-summary]").textContent = annotationCurrent
      ? `第 ${annotationCurrent.revision} 版 · ${narrativeSourceKindLabels[annotationCurrent.source_kind] || "未知"} · ${annotationCurrent.recording_date || "录音日期未知"} · ${narrativeAudioStatusLabels[annotationCurrent.audio_review_status] || "未知"} · 内容待确认`
      : "正在读取来源说明…";
    try {
      const body = await request(`${narrativeAnnotationsUrl(narrativeId)}?offset=${offset}&limit=10`);
      if (generation !== annotationGeneration || selectedNarrativeId !== narrativeId) return;
      by("[data-intake-annotation-retry]").hidden = true;
      renderAnnotation(body, body.history || []);
    } catch (error) {
      if (generation !== annotationGeneration || selectedNarrativeId !== narrativeId) return;
      setMessage(by("[data-intake-annotation-message]"), `${error.message} 原文仍可查看。`, true);
      panel.hidden = false;
      by("[data-intake-annotation-summary]").textContent = annotationCurrent
        ? `第 ${annotationCurrent.revision} 版 · ${narrativeSourceKindLabels[annotationCurrent.source_kind] || "未知"} · ${annotationCurrent.recording_date || "录音日期未知"} · ${narrativeAudioStatusLabels[annotationCurrent.audio_review_status] || "未知"} · 内容待确认`
        : "来源说明读取失败；请重试读取。";
      by("[data-intake-annotation-retry]").hidden = false;
    }
  }

  function renderNarratives() {
    const list = by("[data-testid='intake-narratives']");
    list.replaceChildren();
    if (!narrativeSources.length) {
      list.append(node("p", "intake-muted", "尚无文字资料。可添加 UTF-8 .txt，之后按行引用。"));
      return;
    }
    for (const source of narrativeSources) {
      const button = node("button", "intake-source-item");
      button.type = "button";
      button.setAttribute("aria-current", String(source.id === selectedNarrativeId));
      button.append(node("strong", "", source.display_name || "文字资料"));
      const annotation = source.current_annotation;
      button.append(node("small", "", `${source.line_count} 行 · ${source.byte_size} bytes · ${source.sha256.slice(0, 12)}${annotation ? ` · ${narrativeSourceKindLabels[annotation.source_kind] || "未知"} 第${annotation.revision}版` : ""}`));
      button.addEventListener("click", () => loadNarrativeLines(source.id));
      list.append(button);
    }
  }

  async function refreshNarratives() {
    const generation = ++narrativeListGeneration;
    const list = by("[data-testid='intake-narratives']");
    list.setAttribute("aria-busy", "true");
    try {
      const body = await request(`${root.dataset.narrativesUrl}?offset=0&limit=50`);
      if (generation !== narrativeListGeneration) return;
      narrativeSources = body.narratives || [];
      renderNarratives();
      for (const select of root.querySelectorAll('[data-source-for]')) populateNarrativeChoice(select);
    } catch (error) {
      if (generation !== narrativeListGeneration) return;
      list.textContent = error.message;
    } finally {
      if (generation === narrativeListGeneration) list.removeAttribute("aria-busy");
    }
  }

  function populateNarrativeChoice(select) {
    const value = select.value;
    select.replaceChildren(new Option("修改依据：选择文字资料", ""));
    for (const source of narrativeSources) select.append(new Option(source.display_name, source.id));
    if (narrativeSources.some(source => source.id === value)) select.value = value;
  }

  async function loadNarrativeLines(narrativeId, offset = 0, highlight = null) {
    const generation = ++narrativeGeneration;
    selectedNarrativeId = narrativeId;
    annotationGeneration += 1;
    const form = by("[data-intake-annotation-form]");
    form.dataset.dirty = "";
    form.hidden = true;
    by("[data-intake-annotation-history-list]").hidden = true;
    renderNarratives();
    loadNarrativeAnnotations(narrativeId);
    const target = by("[data-testid='intake-narrative-lines']");
    target.textContent = "正在读取资料行…";
    try {
      const body = await request(`${narrativeLinesUrl(narrativeId)}?offset=${offset}&limit=30`);
      if (generation !== narrativeGeneration || selectedNarrativeId !== narrativeId) return;
      target.replaceChildren();
      const rangeLabel = body.lines.length ? `第 ${offset + 1}–${offset + body.lines.length} 行` : "没有更多行";
      target.append(node("p", "intake-muted", `${body.source.display_name} · ${rangeLabel} · 原始行号保持不变。资料可能是摘录或二次整理，完整性与内容尚未核实。`));
      target.append(node("small", "intake-source-hash", `SHA-256 ${body.source.sha256}`));
      const list = node("ol", "intake-line-list");
      for (const line of body.lines) {
        const item = node("li", "", `${line.line_number}. ${line.text}${line.truncated ? "（预览已截短）" : ""}`);
        item.value = line.line_number;
        if (highlight && line.line_number >= highlight.start && line.line_number <= highlight.end) item.className = "is-cited";
        list.append(item);
      }
      target.append(list);
      const pager = node("div", "intake-requirement-actions");
      for (const [label, pageOffset] of [["前 30 行", offset > 0 ? Math.max(0, offset - 30) : null], ["后 30 行", body.next_offset]]) {
        const button = node("button", "button secondary small", label);
        button.type = "button";
        button.disabled = pageOffset === null;
        button.addEventListener("click", () => loadNarrativeLines(narrativeId, pageOffset, highlight));
        pager.append(button);
      }
      target.append(pager);
    } catch (error) {
      if (generation === narrativeGeneration && selectedNarrativeId === narrativeId) target.textContent = error.message;
    }
  }

  by("[data-intake-annotation-edit]").addEventListener("click", () => {
    const form = by("[data-intake-annotation-form]");
    form.hidden = !form.hidden;
  });
  by("[data-intake-annotation-history]").addEventListener("click", async () => {
    const host = by("[data-intake-annotation-history-list]");
    host.hidden = !host.hidden;
    if (!host.hidden) await loadNarrativeAnnotations(selectedNarrativeId, annotationOffset);
  });
  by("[data-intake-annotation-retry]")?.addEventListener("click", () => {
    if (selectedNarrativeId) void loadNarrativeAnnotations(selectedNarrativeId, annotationOffset);
  });
  const rememberAnnotationDraft = event => {
    const form = event.currentTarget;
    form.dataset.dirty = "true";
    annotationDrafts.set(selectedNarrativeId, {
      source_kind: form.elements.source_kind.value,
      recording_date: form.elements.recording_date.value || null,
      audio_review_status: form.elements.audio_review_status.value,
    });
  };
  by("[data-intake-annotation-form]").addEventListener("input", rememberAnnotationDraft);
  by("[data-intake-annotation-form]").addEventListener("change", rememberAnnotationDraft);
  by("[data-intake-annotation-form]").addEventListener("submit", async event => {
    event.preventDefault();
    if (!selectedNarrativeId || annotationBusy) return;
    const form = event.currentTarget;
    const sourceId = selectedNarrativeId;
    const payload = { expected_revision: annotationCurrent?.revision || 0, source_kind: form.elements.source_kind.value,
      recording_date: form.elements.recording_date.value || null, audio_review_status: form.elements.audio_review_status.value };
    const submittedDetails = JSON.stringify({ source_kind: payload.source_kind, recording_date: payload.recording_date, audio_review_status: payload.audio_review_status });
    const signature = JSON.stringify(payload);
    const keyMapKey = `${sourceId}:${signature}`;
    if (!annotationKeys.has(keyMapKey)) annotationKeys.set(keyMapKey, key());
    const status = by("[data-intake-annotation-message]");
    annotationBusy = true;
    form.querySelector("[data-intake-annotation-save]").disabled = true;
    setMessage(status, "正在保存来源说明…");
    try {
      const body = await request(narrativeAnnotationsUrl(sourceId), { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": annotationKeys.get(keyMapKey) }, body: JSON.stringify(payload) });
      if (selectedNarrativeId !== sourceId) return;
      annotationCurrent = body.current;
      const editedWhileSaving = JSON.stringify({ source_kind: form.elements.source_kind.value,
        recording_date: form.elements.recording_date.value || null, audio_review_status: form.elements.audio_review_status.value }) !== submittedDetails;
      if (editedWhileSaving) {
        form.dataset.dirty = "true";
        annotationDrafts.set(sourceId, { source_kind: form.elements.source_kind.value,
          recording_date: form.elements.recording_date.value || null, audio_review_status: form.elements.audio_review_status.value });
      } else {
        form.dataset.dirty = "";
        annotationDrafts.delete(sourceId);
      }
      renderAnnotation({ current: body.current, history: [], next_offset: null });
      setMessage(status, editedWhileSaving ? "已保存送出时的版本；你在保存期间的新修改仍保留，请再次保存。内容仍未确认。" : "来源说明已保存。内容仍未确认。操作员的核听声明不代表系统验证。");
      refreshNarratives();
    } catch (error) {
      if (selectedNarrativeId === sourceId) setMessage(status, /409|stale_annotation/.test(error.message) ? "说明版本已变化。请刷新说明后再处理；当前输入已保留。" : error.message, true);
    } finally {
      annotationBusy = false;
      form.querySelector("[data-intake-annotation-save]").disabled = false;
    }
  });

  async function openRequirement(candidate) {
    selectIntakeTask("requirements");
    const generation = ++requirementGeneration;
    historyGeneration += 1;
    requirementMutation = false;
    selectedCandidate = candidate;
    currentRequirement = null;
    viewedRevision = null;
    notifyExecutionPlan("loading", { saving: false });
    revisionOffset = 0;
    const target = by("[data-testid='intake-requirement-workspace']");
    setMessage(by("[data-intake-requirement-message]"), "");
    target.setAttribute("aria-busy", "true");
    target.textContent = "正在读取草稿…";
    by("[data-intake-requirement-context]").textContent = typeLabels[candidate.candidate_type] || "生产指令候选";
    try {
      const url = root.dataset.requirementDraftUrl.replace("__CANDIDATE__", encodeURIComponent(candidate.id));
      const body = await request(url);
      if (generation !== requirementGeneration || selectedCandidate?.id !== candidate.id) return;
      currentRequirement = body.requirement;
      target.removeAttribute("aria-busy");
      if (currentRequirement) {
        await loadRequirementHistory();
      } else {
        renderRequirementStart();
        notifyExecutionPlan("viewed", { saving: false });
      }
    } catch (error) {
      if (generation !== requirementGeneration || selectedCandidate?.id !== candidate.id) return;
      target.removeAttribute("aria-busy");
      target.replaceChildren(node("p", "intake-message is-error", error.message));
      const retry = node("button", "button secondary small", "重试");
      retry.type = "button";
      retry.addEventListener("click", () => openRequirement(candidate));
      target.append(retry);
    }
  }

  by("[data-intake-open-plan]")?.addEventListener("click", () => selectIntakeTask("plans"));

  function renderRequirementStart() {
    const candidate = selectedCandidate;
    const generation = requirementGeneration;
    const target = by("[data-testid='intake-requirement-workspace']");
    target.replaceChildren();
    target.append(node("p", "intake-muted", "先选择这份资料的用途。历史参考不会自动成为当前生产任务。"));
    const row = node("div", "intake-requirement-actions");
    const select = node("select", "intake-kind-select");
    select.setAttribute("aria-label", "记录用途");
    const placeholder = node("option", "", "请选择记录用途");
    placeholder.value = ""; placeholder.disabled = true; placeholder.selected = true;
    select.append(placeholder);
    for (const [value, label] of [["historical_reference", "历史参考"], ["new_demand", "新需求"]]) {
      const option = node("option", "", label);
      option.value = value;
      select.append(option);
    }
    const create = node("button", "button primary small", "创建草稿");
    create.type = "button";
    create.disabled = true;
    select.addEventListener("change", () => { create.disabled = !select.value; });
    create.addEventListener("click", async () => {
      if (!select.value || generation !== requirementGeneration || selectedCandidate?.id !== candidate.id) return;
      create.disabled = true;
      const url = root.dataset.requirementDraftUrl.replace("__CANDIDATE__", encodeURIComponent(candidate.id));
      try {
        const body = await request(url, {
          method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
          body: JSON.stringify({ record_kind: select.value }),
        });
        if (generation !== requirementGeneration || selectedCandidate?.id !== candidate.id) return;
        currentRequirement = body;
        setMessage(by("[data-intake-requirement-message]"), "草稿已打开。历史参考与新需求均保留来源和版本。 ");
        revisionOffset = 0;
        await loadRequirementHistory();
      } catch (error) {
        if (generation !== requirementGeneration || selectedCandidate?.id !== candidate.id) return;
        setMessage(by("[data-intake-requirement-message]"), error.message, true);
        // A 409 can mean a draft was created by another tab; use the safe lookup endpoint.
        if (error.status === 409) await openRequirement(selectedCandidate);
        else create.disabled = false;
      }
    });
    row.append(select, create);
    target.append(row);
  }

  async function loadRequirementHistory() {
    if (!currentRequirement?.draft?.id) return;
    const target = by("[data-testid='intake-requirement-workspace']");
    const requirementId = currentRequirement.draft.id;
    const generation = requirementGeneration;
    const requestGeneration = ++historyGeneration;
    target.setAttribute("aria-busy", "true");
    try {
      const url = root.dataset.requirementHistoryUrl.replace("__REQUIREMENT__", encodeURIComponent(requirementId));
      const body = await request(`${url}?offset=${revisionOffset}&limit=10`);
      if (generation !== requirementGeneration || requestGeneration !== historyGeneration || currentRequirement?.draft?.id !== requirementId) return;
      target.removeAttribute("aria-busy");
      renderRequirementWorkspace(body);
    } catch (error) {
      if (generation !== requirementGeneration || requestGeneration !== historyGeneration || currentRequirement?.draft?.id !== requirementId) return;
      target.removeAttribute("aria-busy");
      target.replaceChildren(node("p", "intake-message is-error", error.message));
      const retry = node("button", "button secondary small", "重试读取版本");
      retry.type = "button";
      retry.addEventListener("click", loadRequirementHistory);
      target.append(retry);
    }
  }

  function revisionLabel(revision) {
    return `版本 ${revision.revision} · ${requirementStatusLabels[revision.status] || "待确认"}`;
  }

  function renderRequirementWorkspace(history) {
    const target = by("[data-testid='intake-requirement-workspace']");
    target.replaceChildren();
    const current = currentRequirement;
    const draft = current.draft;
    const activeRevision = viewedRevision || current.revision;
    const isCurrent = activeRevision.revision === history.current_revision;
    const identity = node("div", "intake-requirement-identity");
    identity.append(node("strong", "", `${draft.record_kind === "historical_reference" ? "历史参考" : "新需求"} · ${revisionLabel(activeRevision)}`));
    identity.append(node("small", "", isCurrent ? "当前版本" : `查看旧版本；当前为版本 ${history.current_revision}`));
    const refresh = node("button", "button secondary small", "重新读取当前版本");
    refresh.type = "button";
    refresh.addEventListener("click", () => openRequirement(selectedCandidate));
    identity.append(refresh);
    target.append(identity);

    if (history.revisions.length > 1 || history.next_offset !== null || viewedRevision) {
      const historyBox = node("div", "intake-version-list");
      historyBox.append(node("strong", "", "版本记录"));
      for (const revision of history.revisions) {
        const button = node("button", "button secondary small", revisionLabel(revision));
        button.type = "button";
        button.disabled = viewedRevision?.id === revision.id || (!viewedRevision && revision.id === current.revision.id);
        button.addEventListener("click", () => { viewedRevision = revision; renderRequirementWorkspace(history); });
        historyBox.append(button);
      }
      if (revisionOffset > 0) {
        const newer = node("button", "button secondary small", "较新版本");
        newer.type = "button";
        newer.addEventListener("click", async () => { revisionOffset = Math.max(0, revisionOffset - 10); await loadRequirementHistory(); });
        historyBox.append(newer);
      }
      if (history.next_offset !== null) {
        const older = node("button", "button secondary small", "更早版本");
        older.type = "button";
        older.addEventListener("click", async () => { revisionOffset += 10; await loadRequirementHistory(); });
        historyBox.append(older);
      }
      if (viewedRevision) {
        const back = node("button", "button secondary small", `返回当前版本 ${history.current_revision}`);
        back.type = "button";
        back.addEventListener("click", () => openRequirement(selectedCandidate));
        historyBox.append(back);
      }
      target.append(historyBox);
    }

    renderRequirementFields(target, activeRevision, { editable: isCurrent });
    const check = activeRevision.source_arithmetic_check || (activeRevision.id === current.revision.id ? current.source_arithmetic_check : {}) || {};
    const packaging = activeRevision.packaging_check || (activeRevision.id === current.revision.id ? current.packaging_check : "needs_confirmation");
    target.append(node("p", "intake-check-note", `来源数量核算：${check.state === "calculated" ? `整包装 ${check.whole_packages}，余数 ${check.remainder}，来源箱数 ${check.source_carton_count}` : "资料不足，待确认"}。包装关系：${packaging === "passed" ? "已按人工确认的单位对核验" : "尚待人工确认"}。`));
    const material = activeRevision.material_check || (activeRevision.id === current.revision.id ? current.material_check : null);
    if (material && typeof material === "object" && typeof material.state === "string") {
      const note = node("p", "intake-check-note", materialCheckText(material));
      note.dataset.materialCheck = material.state;
      target.append(note);
    }
    target.append(node("p", "intake-muted", "本地确认只表示此版本已人工确认，不代表可生产、已排产或已提交 ERP。"));
    if (isCurrent) {
      const unsaved = node("p", "intake-message", "有未保存的修改。请先保存新版本，再确认你看到的内容。");
      unsaved.dataset.unsavedRequirement = "true"; unsaved.hidden = true;
      target.append(unsaved);
      const actions = node("div", "intake-requirement-actions");
      const unresolved = activeRevision.unresolved_fields || {};
      if (activeRevision.status !== "confirmed" && activeRevision.fields?.unit && activeRevision.fields?.pack_unit) {
        const label = node("label", "intake-unit-confirmation");
        const checkbox = node("input", ""); checkbox.type = "checkbox"; checkbox.dataset.confirmUnitPair = "true";
        label.append(checkbox, document.createTextNode("我已核对数量与包装单位的关系（未勾选时，包装关系保持待确认）"));
        actions.append(label);
      }
      const confirm = node("button", "button primary small", activeRevision.status === "confirmed" ? "此版本已确认" : "确认此版本");
      confirm.type = "button";
      confirm.dataset.confirmRequirement = "true";
      confirm.disabled = activeRevision.status === "confirmed" || Object.keys(unresolved).length > 0;
      confirm.title = confirm.disabled && activeRevision.status !== "confirmed" ? "请先处理所有待确认字段。" : "";
      confirm.addEventListener("click", () => confirmRequirement(activeRevision));
      actions.append(confirm);
      if (Object.keys(unresolved).length) {
        const problems = node("ul", "intake-unresolved-list");
        for (const [field, detail] of Object.entries(unresolved)) {
          const reasons = (detail.states || []).map(state => requirementReasonLabels[state] || "待核对");
          problems.append(node("li", "", `${requirementFieldLabels[field] || "字段"}：${detail.states?.length > 1 ? "多个来源值尚未归并" : reasons.join("、") || "待确认"}`));
        }
        actions.append(problems);
      }
      target.append(actions);
    }
    notifyExecutionPlan("viewed", {
      dirty: false,
      saving: requirementMutation,
    });
  }

  function displayRequirementValue(name, value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return value.name || "";
    return String(value);
  }

  function readRequirementInput(input) {
    const type = requirementFieldTypes[input.name];
    const text = type === "text" ? input.value : input.value.trim();
    if (type === "customer_ref" || type === "item_ref") return text ? { doctype: type === "customer_ref" ? "Customer" : "Item", name: text } : null;
    return text.trim() ? text : null;
  }

  function requirementInputUnchanged(input, original) {
    const value = readRequirementInput(input);
    if (input.tagName === "TEXTAREA" && typeof original === "string") original = original.replace(/\r\n?/g, "\n");
    if (value === original) return true;
    return value !== null && original !== null && typeof value === "object" && typeof original === "object"
      && value.doctype === original.doctype && value.name === original.name;
  }

  function requirementFormChanged(form, revision) {
    return [...form.querySelectorAll("[name]")].some(input => !requirementInputUnchanged(input, revision.fields?.[input.name] ?? null))
      || [...form.querySelectorAll("[data-source-for]")].some(select => select.value);
  }

  async function inspectRequirementCell(ref, target, button) {
    const coordinate = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(ref.coordinate || "");
    if (!coordinate) return;
    const column = [...coordinate[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
    const params = new URLSearchParams({ sheet_index: String(ref.sheet_index), row_start: coordinate[2], row_count: "1", col_start: String(column), col_count: "1" });
    button.disabled = true;
    target.hidden = false;
    target.textContent = "正在读取原始单元格…";
    try {
      const body = await request(`${previewUrl(ref.snapshot_id)}?${params}`);
      const cell = body.rows?.[0]?.[0];
      if (!cell || cell.coordinate !== ref.coordinate) throw new Error("未找到对应的原始单元格。");
      let [value, note] = cellDisplay(cell);
      const normalized = cell.normalized_value;
      if (normalized && typeof normalized === "object") {
        if (["string", "number"].includes(typeof normalized.value)) value = String(normalized.value);
        else if (typeof normalized.iso === "string") value = normalized.iso;
      }
      target.replaceChildren(node("strong", "", `工作表 ${ref.sheet_index}!${ref.coordinate}`), node("p", "", value || "空白单元格"));
      if (note) target.append(node("small", "intake-muted", note));
    } catch (error) {
      target.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  // item_ref 下拉提示：只读查询演示物料主数据，选中后把物料名称写回字段。
  function attachMaterialSuggestions(input, row) {
    const list = node("ul", "intake-material-options");
    list.id = `intake-material-options-${input.name}`;
    list.setAttribute("role", "listbox");
    list.hidden = true;
    const status = node("div", "intake-material-status");
    status.hidden = true;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", list.id);
    input.setAttribute("aria-expanded", "false");
    row.append(list, status);

    let token = 0;
    let timer = null;
    let active = -1;
    const options = () => [...list.querySelectorAll(".intake-material-option")];

    function close() {
      list.hidden = true;
      active = -1;
      input.setAttribute("aria-expanded", "false");
    }

    function select(option) {
      input.value = option.dataset.itemName || "";
      close();
      status.hidden = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }

    function highlight(index) {
      const rows = options();
      if (!rows.length) return;
      active = (index + rows.length) % rows.length;
      rows.forEach((option, position) => {
        option.classList.toggle("intake-material-active", position === active);
        option.setAttribute("aria-selected", position === active ? "true" : "false");
      });
    }

    async function load(query) {
      const current = ++token;
      status.hidden = false;
      status.textContent = "正在查询演示物料主数据…";
      try {
        const body = await request(`/api/materials/items?q=${encodeURIComponent(query)}&limit=8`);
        if (current !== token) return;
        const items = Array.isArray(body?.items) ? body.items : [];
        list.replaceChildren();
        if (!items.length) {
          close();
          status.textContent = "演示主数据里没有匹配项；可继续手工填写，保存后会标为待确认。";
          return;
        }
        for (const item of items) {
          const option = node("li", "intake-material-option");
          option.dataset.itemName = item.item_name;
          option.setAttribute("role", "option");
          option.setAttribute("aria-selected", "false");
          option.append(
            node("span", "intake-material-option-name", item.item_name),
            node("span", "intake-material-option-meta", `${item.item_code} · ${item.item_group} · ${item.stock_uom}`),
          );
          if (item.disabled) option.append(node("span", "intake-material-option-flag", "已停用"));
          option.addEventListener("mousedown", event => event.preventDefault());
          option.addEventListener("click", () => select(option));
          list.append(option);
        }
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
        status.textContent = "来自演示物料主数据，不代表客户真实主数据。";
      } catch (error) {
        if (current !== token) return;
        close();
        status.textContent = `物料查询不可用：${error.message}`;
      }
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      const query = input.value.trim();
      if (!query) { close(); status.hidden = true; return; }
      timer = setTimeout(() => load(query), 200);
    });
    input.addEventListener("keydown", event => {
      if (list.hidden) return;
      if (event.key === "ArrowDown") { event.preventDefault(); highlight(active + 1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); highlight(active - 1); }
      else if (event.key === "Enter" && active >= 0) { event.preventDefault(); select(options()[active]); }
      else if (event.key === "Escape") close();
    });
    input.addEventListener("blur", () => setTimeout(close, 120));
  }

  function materialCheckText(material) {
    const issues = Array.isArray(material.issues) ? material.issues : [];
    if (material.state === "passed") {
      const item = material.resolution?.item || {};
      return `物料核对：已匹配 ${item.item_code || "物料"}（${item.item_name || ""}），来源为演示主数据。`;
    }
    const questions = issues.slice(0, 3).map(issue => issue.question).filter(Boolean).join("；");
    const prefix = material.state === "blocked" ? "物料核对：存在阻断项" : "物料核对：待确认";
    if (!questions) return `${prefix}。`;
    return `${prefix} — ${questions}${issues.length > 3 ? `（另有 ${issues.length - 3} 项）` : ""}`;
  }

  function renderRequirementFields(target, revision, { editable }) {
    const fields = revision.fields || {};
    const groups = [
      ["基本信息", ["source_order_reference", "description", "specification", "color", "customer_ref", "item_ref"]],
      ["数量与包装", ["quantity", "unit", "pack_quantity", "pack_unit", "carton_count", "packing", "barcode_requirement"]],
      ["交付要求", ["due_date", "requirement_text"]],
    ];
    const form = node("form", "intake-requirement-fields");
    form.addEventListener("submit", event => { event.preventDefault(); saveRequirementRevision(revision, form); });
    const updateDirtyState = () => {
      const dirty = requirementFormChanged(form, revision);
      const confirm = target.querySelector("[data-confirm-requirement]");
      if (confirm) confirm.disabled = dirty || requirementMutation || revision.status === "confirmed" || Object.keys(revision.unresolved_fields || {}).length > 0;
      const note = target.querySelector("[data-unsaved-requirement]");
      if (note) note.hidden = !dirty;
      notifyExecutionPlan("state", { dirty, saving: requirementMutation });
    };
    form.addEventListener("input", updateDirtyState);
    form.addEventListener("change", updateDirtyState);
    for (const [groupName, names] of groups) {
      const group = node("fieldset", "intake-requirement-group");
      group.append(node("legend", "", groupName));
      for (const name of names) {
        const row = node("div", "intake-requirement-field");
        const label = node("label", "intake-requirement-label", requirementFieldLabels[name]);
        const type = requirementFieldTypes[name];
        let value = fields[name];
        const multiline = ["description", "specification", "packing", "barcode_requirement", "requirement_text"].includes(name);
        const input = node(multiline ? "textarea" : "input", "intake-requirement-input");
        if (type === "decimal" || type === "customer_ref" || type === "item_ref") input.type = "text";
        else if (type === "date") input.type = "date";
        if (type === "decimal") input.inputMode = "decimal";
        input.name = name;
        input.value = displayRequirementValue(name, value);
        input.disabled = !editable;
        input.setAttribute("aria-label", requirementFieldLabels[name]);
        label.append(input);
        row.append(label);
        if (name === "item_ref" && editable) attachMaterialSuggestions(input, row);

        const refs = revision.source_refs?.[name] || [];
        const sourceSummary = refs.map(ref => {
          const kindLabel = evidenceKindLabels[ref.kind] || "出处";
          if (ref.kind === "source_record") return `${kindLabel} · 工作表 ${ref.sheet_index}!${ref.coordinate}`;
          if (ref.kind === "operator_statement") {
            const source = narrativeSources.find(item => item.id === ref.narrative_source_id);
            return `${kindLabel} · ${source?.display_name || "文字资料"} 第 ${ref.line_start}–${ref.line_end} 行`;
          }
          return `${kindLabel}${ref.rule_version ? ` v${ref.rule_version}` : ""}`;
        }).join("；");
        row.append(node("small", "intake-requirement-source", sourceSummary || "尚无可验证出处；保存修改后将保持待确认。"));
        for (const ref of refs) {
          if (ref.kind === "source_record") {
            const button = node("button", "button secondary small", `查看原始单元格 ${ref.coordinate}`);
            const peek = node("div", "intake-provenance-peek"); peek.hidden = true;
            button.type = "button";
            button.addEventListener("click", () => inspectRequirementCell(ref, peek, button));
            row.append(button, peek);
          } else if (ref.kind === "operator_statement") {
            const button = node("button", "button secondary small", `查看说明第 ${ref.line_start}–${ref.line_end} 行`);
            button.type = "button";
            button.addEventListener("click", async () => {
              await loadNarrativeLines(ref.narrative_source_id, Math.floor((ref.line_start - 1) / 30) * 30, { start: ref.line_start, end: ref.line_end });
              by("[data-testid='intake-narrative-lines']").scrollIntoView?.({ block: "nearest" });
            });
            row.append(button);
          }
        }
        if (editable) {
          const evidenceEditor = node("details", "intake-evidence-editor");
          evidenceEditor.append(node("summary", "", "修改依据（可留待确认）"));
          const sourceControls = node("div", "intake-requirement-source-controls");
          const sourceSelect = node("select", "");
          sourceSelect.dataset.sourceFor = name;
          sourceSelect.setAttribute("aria-label", `${requirementFieldLabels[name]}修改依据`);
          populateNarrativeChoice(sourceSelect);
          sourceSelect.addEventListener("change", () => {
            const selected = narrativeSources.find(item => item.id === sourceSelect.value);
            const max = selected ? String(selected.line_count) : "";
            const startInput = sourceControls.querySelector(`[data-line-start-for="${name}"]`);
            const endInput = sourceControls.querySelector(`[data-line-end-for="${name}"]`);
            startInput.max = max;
            endInput.max = max;
            if (selected) loadNarrativeLines(selected.id);
          });
          sourceControls.append(sourceSelect);
          const start = node("input", ""); start.type = "number"; start.min = "1"; start.value = "1"; start.dataset.lineStartFor = name; start.setAttribute("aria-label", `${requirementFieldLabels[name]}出处起始行`);
          const end = node("input", ""); end.type = "number"; end.min = "1"; end.value = "1"; end.dataset.lineEndFor = name; end.setAttribute("aria-label", `${requirementFieldLabels[name]}出处结束行`);
          sourceControls.append(node("span", "intake-muted", "行范围"), start, end);
          evidenceEditor.append(sourceControls);
          row.append(evidenceEditor);
        }
        group.append(row);
      }
      form.append(group);
    }
    if (editable) {
      const actions = node("div", "intake-requirement-actions");
      const save = node("button", "button secondary", "保存为新版本");
      save.type = "submit";
      actions.append(save);
      form.append(actions);
      form.append(node("p", "intake-muted", "修改值不会沿用旧单元格出处。若没有可定位说明，保存后该字段会标为待确认。"));
    } else {
      form.querySelectorAll("input,textarea").forEach(input => { input.readOnly = true; });
    }
    target.append(form);
  }

  async function saveRequirementRevision(revision, form) {
    if (requirementMutation || !currentRequirement || revision.revision !== currentRequirement.revision.revision) return;
    const generation = requirementGeneration;
    const fields = {};
    const fieldSources = {};
    for (const input of form.querySelectorAll("[name]")) {
      const name = input.name;
      const value = readRequirementInput(input);
      const narrativeId = form.querySelector(`[data-source-for="${name}"]`)?.value;
      if (requirementInputUnchanged(input, revision.fields?.[name] ?? null) && !narrativeId) continue;
      fields[name] = value;
      const start = Number(form.querySelector(`[data-line-start-for="${name}"]`)?.value);
      const end = Number(form.querySelector(`[data-line-end-for="${name}"]`)?.value);
      if (narrativeId) {
        const source = narrativeSources.find(item => item.id === narrativeId);
        if (!source || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > source.line_count || end - start + 1 > 200) {
          setMessage(by("[data-intake-requirement-message]"), `${requirementFieldLabels[name]}：请填写有效的出处行范围，一次最多引用 200 行。`, true);
          return;
        }
        fieldSources[name] = [{ kind: "operator_statement", field_key: name,
          narrative_source_id: narrativeId, line_start: start, line_end: end }];
      }
    }
    if (!Object.keys(fields).length) {
      setMessage(by("[data-intake-requirement-message]"), "没有检测到字段变化。", true);
      return;
    }
    const requirementId = currentRequirement.draft.id;
    const button = form.querySelector("button[type='submit']");
    requirementMutation = true;
    notifyExecutionPlan("state", { dirty: false, saving: true });
    button.disabled = true;
    try {
      const url = root.dataset.requirementHistoryUrl.replace("__REQUIREMENT__", encodeURIComponent(requirementId));
      const body = await request(url, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
        body: JSON.stringify({ expected_revision: revision.revision, fields, field_sources: fieldSources }),
      });
      if (generation !== requirementGeneration || currentRequirement?.draft?.id !== requirementId) return;
      currentRequirement = body;
      requirementMutation = false;
      notifyExecutionPlan("state", { dirty: false, saving: false });
      viewedRevision = null;
      revisionOffset = 0;
      await loadRequirementHistory();
    } catch (error) {
      if (generation !== requirementGeneration || currentRequirement?.draft?.id !== requirementId) return;
      requirementMutation = false;
      const currentForm = by("[data-testid='intake-requirement-workspace']")?.querySelector(".intake-requirement-fields");
      notifyExecutionPlan("state", { dirty: Boolean(currentForm && requirementFormChanged(currentForm, revision)), saving: false });
      setMessage(by("[data-intake-requirement-message]"), error.message, true);
      button.disabled = false;
    }
  }

  async function confirmRequirement(revision) {
    if (requirementMutation || !currentRequirement || revision.revision !== currentRequirement.revision.revision) return;
    const generation = requirementGeneration;
    const requirementId = currentRequirement.draft.id;
    const workspace = by("[data-testid='intake-requirement-workspace']");
    const form = workspace.querySelector(".intake-requirement-fields");
    if (form && requirementFormChanged(form, revision)) {
      setMessage(by("[data-intake-requirement-message]"), "请先保存修改，再确认此版本。", true);
      return;
    }
    const button = workspace.querySelector("button[data-confirm-requirement]");
    const body = { expected_revision: revision.revision };
    if (workspace.querySelector("[data-confirm-unit-pair]")?.checked) body.confirmed_unit_pair = { unit: revision.fields.unit, pack_unit: revision.fields.pack_unit };
    requirementMutation = true;
    notifyExecutionPlan("state", { dirty: false, saving: true });
    if (button) button.disabled = true;
    try {
      const url = root.dataset.requirementConfirmUrl.replace("__REQUIREMENT__", encodeURIComponent(requirementId));
      const updated = await request(url, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
        body: JSON.stringify(body),
      });
      if (generation !== requirementGeneration || currentRequirement?.draft?.id !== requirementId) return;
      currentRequirement = updated;
      requirementMutation = false;
      notifyExecutionPlan("state", { dirty: false, saving: false });
      viewedRevision = null;
      revisionOffset = 0;
      await loadRequirementHistory();
    } catch (error) {
      if (generation !== requirementGeneration || currentRequirement?.draft?.id !== requirementId) return;
      requirementMutation = false;
      notifyExecutionPlan("state", { dirty: false, saving: false });
      if (error.status === 409) await openRequirement(selectedCandidate);
      else setMessage(by("[data-intake-requirement-message]"), error.message, true);
      if (button) button.disabled = false;
    }
  }

  by("[data-testid='intake-upload']").addEventListener("submit", async event => {
    event.preventDefault();
    const input = by("[data-intake-file]");
    const status = by("[data-intake-upload-message]");
    if (input.files?.[0] && input.files[0] !== pendingUpload) {
      pendingUpload = input.files[0];
      pendingUploadKey = key();
    }
    if (!pendingUpload) {
      setMessage(status, "请选择一个 .xlsx 文件。", true);
      return;
    }
    const form = new FormData();
    form.append("file", pendingUpload, pendingUpload.name);
    setMessage(status, "正在安全保存原件…");
    try {
      const body = await request(root.dataset.sourcesUrl, {
        method: "POST", headers: { "Idempotency-Key": pendingUploadKey }, body: form,
      });
      setMessage(status, `来源已保存：${body.source.display_name} · ${body.source.byte_size} bytes。`);
      pendingUpload = null;
      pendingUploadKey = "";
      input.value = "";
      await refreshSources();
      await openSource(body.source.id);
    } catch (error) {
      setMessage(status, `${error.message} 可再次提交以复用同一请求键。`, true);
    }
  });

  by("[data-intake-narrative-upload]").addEventListener("submit", async event => {
    event.preventDefault();
    if (narrativeUploadBusy) return;
    const input = by("[data-intake-narrative-file]");
    const status = by("[data-intake-narrative-message]");
    const file = input.files?.[0];
    if (!file) return setMessage(status, "请选择一个 UTF-8 .txt 文件。", true);
    narrativeUploadBusy = true;
    const button = event.currentTarget.querySelector("button[type='submit']");
    button.disabled = true;
    input.disabled = true;
    if (pendingNarrativeUpload !== file) {
      pendingNarrativeUpload = file;
      pendingNarrativeKey = key();
    }
    const form = new FormData();
    form.append("file", pendingNarrativeUpload, pendingNarrativeUpload.name);
    setMessage(status, "正在安全保存文字资料…");
    try {
      const body = await request(root.dataset.narrativesUrl, {
        method: "POST", headers: { "Idempotency-Key": pendingNarrativeKey }, body: form,
      });
      pendingNarrativeUpload = null;
      pendingNarrativeKey = "";
      input.value = "";
      setMessage(status, `资料已保存：${body.narrative.display_name} · ${body.narrative.line_count} 行。`);
      await refreshNarratives();
      await loadNarrativeLines(body.narrative.id);
    } catch (error) {
      setMessage(status, `${error.message} 可再次提交以复用同一请求键。`, true);
    } finally {
      narrativeUploadBusy = false;
      button.disabled = false;
      input.disabled = false;
    }
  });

  by("[data-intake-refresh-sources]").addEventListener("click", refreshSources);
  by("[data-intake-refresh-candidates]").addEventListener("click", refreshCandidates);
  by("[data-intake-load-window]").addEventListener("click", loadWindow);
  by("[data-intake-sheet]").addEventListener("change", loadWindow);
  by("[data-intake-candidate-type]").addEventListener("change", event => {
    if (selectedType !== event.target.value) invalidateMapping();
    selectedType = event.target.value;
    populateFields();
    by("[data-intake-create-candidate]").disabled = true;
    by("[data-intake-save-mapping]").disabled = !selectedType || !previewId;
  });
  by("[data-intake-active-field]").addEventListener("change", event => { activeField = event.target.value; updateGridSelection(); });
  by("[data-intake-save-mapping]").addEventListener("click", saveMapping);
  by("[data-intake-create-candidate]").addEventListener("click", createCandidate);
  refreshNarratives();
  refreshSources();
  refreshCandidates();
})();
