(() => {
  const PRODUCT_FIELDS = ["sku", "name", "category", "material", "size", "color"];
  const LABELS = { sku: "SKU / 货号", name: "名称", category: "品类", material: "材质", size: "尺寸", color: "颜色" };
  const CANDIDATE_LABELS = {
    style_number: "款号", description: "产品描述", customer_item_code: "客户货号", width: "宽度",
    width_unit: "宽度单位", color: "颜色", roll_length: "卷长", roll_length_unit: "卷长单位",
    packing: "包装说明", barcode: "条码",
  };
  function element(document, tag, text, className = "") {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function renderApplicationReceipt(document, application) {
    const details = element(document, "details", undefined, "intake-application-receipt");
    details.dataset.applicationReceipt = "";
    const stateLabels = { needs_review: "待确认", draft: "草稿", confirmed: "已确认" };
    const summary = element(document, "summary",
      `产品 ${application.product_id || "未知"} · v${application.version ?? "?"} · ${stateLabels[application.status] || "状态未知"}`);
    details.append(summary);
    if (application.revision_id) details.append(element(document, "p", `版本ID：${application.revision_id}`, "intake-muted"));
    const missing = Array.isArray(application.missing_fields) ? application.missing_fields : [];
    details.append(element(document, "p", missing.length ? `待补字段：${missing.join("、")}` : "当前没有缺项。", "intake-muted"));
    const fields = application.source_refs?.intake_fields;
    if (fields && typeof fields === "object") {
      const list = element(document, "dl", undefined, "intake-application-receipt-fields");
      for (const [field, item] of Object.entries(fields)) {
        const kind = item?.kind === "manual_entry" ? "人工填写" : "候选参考、经人工确认";
        list.append(element(document, "dt", LABELS[field] || field));
        const parts = [`${kind}值：${item?.confirmed_value ?? ""}`];
        if (item?.note) parts.push(`说明：${item.note}`);
        const sources = Array.isArray(item?.sources) ? item.sources : [];
        for (const source of sources) {
          const sheet = source.sheet_title || (source.sheet_index ? `工作表 ${source.sheet_index}` : "工作表未知");
          const location = source.coordinate ? `${sheet}!${source.coordinate}` : sheet;
          parts.push(`${location} 原值：${source.value ?? ""}`);
          if (source.formula_status) parts.push(`公式/缓存：${source.formula_status}`);
          if (source.error_code) parts.push(`来源状态：${source.error_code}`);
        }
        list.append(element(document, "dd", parts.join("；")));
      }
      details.append(list);
    }
    return details;
  }

  function attach({ container, candidate, applications = [], applicationsNextOffset = null, root, request, keyFactory }) {
    if (candidate?.candidate_type !== "product_identity") return null;
    const document = container.ownerDocument;
    const applicationSection = element(document, "details", undefined, "intake-product-application-section");
    applicationSection.dataset.applicationSection = "";
    applicationSection.append(element(document, "summary", "人工确认入库（展开后逐项核对）"));
    const form = element(document, "form", undefined, "intake-product-application");
    form.dataset.testid = "intake-product-application";
    const heading = element(document, "h5", "人工确认产品资料");
    const caution = element(document, "p", "候选仅供核对；只有点击保存才会追加待确认产品版本。空字段不会自动补值。", "intake-muted");
    form.append(heading, caution);

    const taskLabel = element(document, "label", "目标任务");
    const taskSelect = element(document, "select");
    taskSelect.name = "task_id";
    taskSelect.required = true;
    taskSelect.append(new Option("请明确选择任务", ""));
    taskLabel.append(taskSelect);
    form.append(taskLabel);

    const targetLabel = element(document, "label", "应用方式");
    const targetSelect = element(document, "select");
    targetSelect.name = "target_mode";
    targetSelect.required = true;
    targetSelect.append(new Option("请明确选择目标", ""));
    targetSelect.append(new Option("新建待确认产品", "new"));
    targetSelect.append(new Option("追加到现有产品", "existing"));
    targetLabel.append(targetSelect);
    form.append(targetLabel);

    const productLabel = element(document, "label", "现有产品");
    productLabel.hidden = true;
    const productSelect = element(document, "select");
    productSelect.name = "product_id";
    productSelect.append(new Option("请明确选择产品", ""));
    productLabel.append(productSelect);
    form.append(productLabel);

    const fieldsHost = element(document, "div", undefined, "intake-product-application-fields");
    const controls = new Map();
    for (const field of PRODUCT_FIELDS) {
      const group = element(document, "fieldset", undefined, "intake-product-application-field");
      const legend = element(document, "legend", LABELS[field]);
      const input = element(document, "input");
      input.name = field;
      input.maxLength = ({ sku: 120, name: 200, category: 120, material: 200, size: 120, color: 120 })[field];
      input.autocomplete = "off";
      const valueLabel = element(document, "label", "人工确认值");
      valueLabel.append(input);
      const sourceLabel = element(document, "label", "参考候选来源（可多选）");
      const sourceSelect = element(document, "select");
      sourceSelect.name = `${field}_source_fields`;
      sourceSelect.multiple = true;
      sourceSelect.size = 3;
      sourceSelect.append(new Option("无：人工填写", ""));
      for (const [sourceField, values] of Object.entries(candidate.fields || {})) {
        const entries = Array.isArray(values) ? values : [];
        const present = entries.length > 0 && entries.every(item =>
          item?.state === "present" && item.value !== null && String(item.value).trim() !== ""
        );
        const preview = entries.map(item => item?.state === "present" ? String(item.value) : item?.state || "状态未知").join(" / ");
        const option = new Option(`${CANDIDATE_LABELS[sourceField] || sourceField} · ${preview || "未映射"}`, sourceField);
        option.disabled = !present;
        sourceSelect.append(option);
      }
      sourceLabel.append(sourceSelect);
      const noteLabel = element(document, "label", "人工说明（仅人工填写时必填）");
      const note = element(document, "textarea");
      note.name = `${field}_note`;
      note.maxLength = 1000;
      note.rows = 2;
      noteLabel.append(note);
      group.append(legend, valueLabel, sourceLabel, noteLabel);
      fieldsHost.append(group);
      controls.set(field, { input, sourceSelect, note });
    }
    form.append(fieldsHost);
    const status = element(document, "p", "请选择任务和目标后核对字段。", "intake-message");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.dataset.applicationStatus = "";
    const submit = element(document, "button", "保存为待确认版本", "button primary small");
    submit.type = "submit";
    submit.disabled = true;
    const receipts = element(document, "div", undefined, "intake-application-receipts");
    receipts.dataset.applicationReceipts = "";
    const receiptHistory = element(document, "div", undefined, "intake-application-history");
    receiptHistory.dataset.applicationsNextOffset = Number.isInteger(applicationsNextOffset) ? String(applicationsNextOffset) : "";
    const loadOlder = element(document, "button", "加载更早的确认记录", "button secondary small");
    loadOlder.type = "button";
    loadOlder.hidden = !Number.isInteger(applicationsNextOffset);
    receiptHistory.append(loadOlder);
    form.append(status, submit, receipts);
    for (const application of Array.isArray(applications) ? applications : []) {
      if (application?.status && application.status !== "pending") receipts.append(renderApplicationReceipt(document, application));
    }
    receipts.append(receiptHistory);
    applicationSection.append(form);
    container.append(applicationSection);

    const baselines = new Map();
    let products = [];
    let productLoadGeneration = 0;
    let lastRequest = "";
    let lastKey = "";
    let busy = false;
    const setStatus = (message, error = false) => {
      status.textContent = message;
      status.classList.toggle("is-error", error);
    };
    const updateEnabled = () => {
      submit.disabled = busy || !taskSelect.value || !targetSelect.value ||
        (targetSelect.value === "existing" && !productSelect.value);
    };

    loadOlder.addEventListener("click", async () => {
      const offset = Number(receiptHistory.dataset.applicationsNextOffset);
      if (!Number.isInteger(offset) || offset < 0 || busy) return;
      loadOlder.disabled = true;
      try {
        const candidateUrl = root.dataset.candidateUrl.replace("__CANDIDATE__", encodeURIComponent(candidate.id));
        const page = await request(`${candidateUrl}?applications_offset=${offset}&applications_limit=20`);
        for (const application of Array.isArray(page.applications) ? page.applications : []) {
          if (application?.status && application.status !== "pending") {
            receipts.insertBefore(renderApplicationReceipt(document, application), receiptHistory);
          }
        }
        const nextOffset = page.applications_next_offset;
        receiptHistory.dataset.applicationsNextOffset = Number.isInteger(nextOffset) ? String(nextOffset) : "";
        loadOlder.hidden = !Number.isInteger(nextOffset);
      } catch (error) {
        setStatus(`读取更早回执失败：${error.message}`, true);
      } finally {
        loadOlder.disabled = false;
      }
    });

    request(root.dataset.tasksUrl).then(tasks => {
      taskSelect.replaceChildren(new Option("请明确选择任务", ""));
      for (const task of Array.isArray(tasks) ? tasks : []) {
        const option = new Option(`${task.title || "未命名任务"} · ${task.status || "状态未知"}`, task.id);
        taskSelect.append(option);
      }
      setStatus(tasks?.length ? "选择任务、目标并逐项核对后再保存。" : "没有可选任务；请先创建或选择已有任务。", !tasks?.length);
      updateEnabled();
    }).catch(error => {
      setStatus(`读取任务失败：${error.message}`, true);
    });

    const loadProducts = async () => {
      const generation = ++productLoadGeneration;
      const taskId = taskSelect.value;
      productLabel.hidden = targetSelect.value !== "existing";
      productSelect.replaceChildren(new Option("请明确选择产品", ""));
      products = [];
      updateEnabled();
      if (targetSelect.value !== "existing" || !taskSelect.value) return;
      try {
        const url = `${root.dataset.productsUrl}?batch_id=${encodeURIComponent(taskId)}`;
        const loadedProducts = await request(url);
        if (generation !== productLoadGeneration || taskId !== taskSelect.value || targetSelect.value !== "existing") return;
        products = loadedProducts;
        for (const product of products) {
          productSelect.append(new Option(`${product.sku || "无SKU"} · ${product.name || "无名称"}`, product.id));
        }
        if (!products.length) setStatus("该任务没有现有产品；请选择新建或先检查任务。", true);
      } catch (error) {
        if (generation !== productLoadGeneration || taskId !== taskSelect.value || targetSelect.value !== "existing") return;
        setStatus(`读取现有产品失败：${error.message}`, true);
      }
      updateEnabled();
    };
    const loadSelectedProduct = () => {
      const product = products.find(item => item.id === productSelect.value);
      baselines.clear();
      for (const field of PRODUCT_FIELDS) {
        const control = controls.get(field);
        const value = product?.[field] || "";
        control.input.value = value;
        control.note.value = "";
        control.sourceSelect.selectedIndex = 0;
        baselines.set(field, value);
      }
      updateEnabled();
    };
    taskSelect.addEventListener("change", loadProducts);
    targetSelect.addEventListener("change", () => {
      productLabel.hidden = targetSelect.value !== "existing";
      loadProducts();
      if (targetSelect.value === "new") {
        baselines.clear();
        for (const field of PRODUCT_FIELDS) {
          const control = controls.get(field);
          control.input.value = "";
          control.note.value = "";
          control.sourceSelect.selectedIndex = 0;
          baselines.set(field, "");
        }
      }
      updateEnabled();
    });
    productSelect.addEventListener("change", loadSelectedProduct);
    form.addEventListener("input", updateEnabled);
    form.addEventListener("change", updateEnabled);
    const renderApplication = result => {
      const application = result?.application || {};
      if (result?.status === "pending" || application.status === "pending") {
        setStatus("申请仍在处理中，暂不能确认结果。稍后可用相同内容和幂等键重试。");
        return;
      }
      setStatus(`已保存待确认版本 v${application.version || "?"}；待补字段：${application.missing_fields?.join("、") || "无"}。`);
      receipts.prepend(renderApplicationReceipt(document, application));
    };
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (busy || !taskSelect.value || !targetSelect.value ||
          (targetSelect.value === "existing" && !productSelect.value)) return;
      const product = products.find(item => item.id === productSelect.value);
      const fields = {};
      for (const field of PRODUCT_FIELDS) {
        const control = controls.get(field);
        const sourceFields = [...control.sourceSelect.selectedOptions].map(option => option.value).filter(Boolean);
        const value = control.input.value;
        const note = control.note.value;
        const baseline = baselines.get(field) || "";
        if (targetSelect.value === "existing" && value === baseline && !sourceFields.length && !note) continue;
        if (targetSelect.value === "new" && !value && !sourceFields.length && !note) continue;
        fields[field] = { value, source_fields: sourceFields, note };
      }
      if (targetSelect.value === "new" && (!fields.sku?.value.trim() || !fields.name?.value.trim())) {
        setStatus("新建产品必须人工填写非空 SKU 和名称。", true);
        return;
      }
      for (const [field, item] of Object.entries(fields)) {
        if (!item.source_fields.length && !item.note.trim()) {
          setStatus(`${LABELS[field]}为人工填写，请补充说明。`, true);
          return;
        }
      }
      if (!Object.keys(fields).length) {
        setStatus("没有待保存的字段变化。", true);
        return;
      }
      const body = {
        source_sha256: candidate.source_sha256,
        mapping_id: candidate.mapping_id,
        mapping_revision: candidate.mapping_revision,
        target: {
          task_id: taskSelect.value,
          product_id: targetSelect.value === "existing" ? product.id : null,
          expected_revision_id: targetSelect.value === "existing" ? product.latest_revision?.id || null : null,
        },
        fields,
      };
      const requestText = JSON.stringify(body);
      if (requestText !== lastRequest) {
        lastRequest = requestText;
        lastKey = keyFactory();
      }
      busy = true;
      updateEnabled();
      setStatus("正在保存待确认版本…");
      try {
        const url = root.dataset.candidateApplyUrl.replace("__CANDIDATE__", encodeURIComponent(candidate.id));
        const result = await request(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": lastKey }, body: requestText });
        renderApplication(result);
      } catch (error) {
        setStatus(`保存失败：${error.message}。相同内容重试会复用幂等键。`, true);
      } finally {
        busy = false;
        updateEnabled();
      }
    });
    return { form, taskSelect, targetSelect, productSelect, controls, submit, status, receipts, loadOlder };
  }

  globalThis.TradeLoomIntakeProductApplication = { attach };
})();
