/* 业务单据（采购 / 入库 / 出货回款）：列表展示与人工确认。
   单据由打表候选经 /api/intake/candidates/<id>/documents 生成；这里只读取与确认。 */
(() => {
  const root = document.querySelector('[data-testid="intake-workbench"]');
  const workspace = root?.querySelector('[data-testid="documents-workbench"]');
  if (!workspace) return;

  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || "";
  const businessUrl = globalThis.TradeLoomBusiness?.businessUrl || (value => value);
  const DOC_TYPES = ["purchase_plan", "stock_receipt", "shipment_payment"];
  const DOC_LABELS = { purchase_plan: "采购计划", stock_receipt: "入库记录", shipment_payment: "出货回款" };
  const ERROR_TEXT = {
    document_blocked: "存在阻断问题，不能确认。",
    document_not_found: "单据不存在，请刷新列表。",
    unavailable: "服务暂不可用，请稍后重试。",
  };

  const blocks = Object.fromEntries(DOC_TYPES.map(docType => [docType, {
    docType,
    block: workspace.querySelector(`[data-doc-block="${docType}"]`),
    list: workspace.querySelector(`[data-doc-block="${docType}"] [data-doc-list]`),
    message: workspace.querySelector(`[data-doc-block="${docType}"] [data-doc-message]`),
    loaded: false,
  }]));

  const by = block => selector => block.block.querySelector(selector);
  const idempotencyKey = () => globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function url(pattern, replacements) {
    let result = pattern;
    for (const [key, value] of Object.entries(replacements)) result = result.replaceAll(key, value);
    return result;
  }

  async function request(urlPath, options = {}) {
    const response = await fetch(businessUrl(urlPath), {
      credentials: "same-origin", ...options,
      headers: { "X-CSRFToken": csrf, ...(options.headers || {}) },
    });
    const body = (response.headers.get("content-type") || "").includes("application/json")
      ? await response.json() : null;
    if (!response.ok) {
      const code = body?.error_code || "unavailable";
      throw new Error(ERROR_TEXT[code] || `请求失败（${code}）`);
    }
    return body;
  }

  function field(label, value) {
    const item = document.createElement("span");
    item.className = "documents-field";
    const name = document.createElement("strong");
    name.textContent = label;
    item.append(name, ` ${value ?? "—"}`);
    return item;
  }

  function statusPill(status) {
    const pill = document.createElement("span");
    pill.className = `status-pill ${status === "confirmed" ? "confirmed" : "draft"}`;
    pill.textContent = status === "confirmed" ? "已确认" : "待确认";
    return pill;
  }

  function itemHead(doc) {
    const head = document.createElement("div");
    head.className = "documents-item-head";
    const title = document.createElement("strong");
    title.textContent = doc.kind === "payment" ? `回款 ${doc.reference || ""}` :
      doc.kind === "shipment" ? `出货 ${doc.reference || ""}` : doc.material || `行 ${doc.position}`;
    head.append(title, statusPill(doc.status));
    return head;
  }

  function fieldsFor(doc) {
    if (doc.kind === "shipment" || doc.kind === "payment") {
      const fields = [field("金额", doc.amount), field("币种", doc.currency)];
      if (doc.occurred_on) fields.push(field("日期", doc.occurred_on));
      return fields;
    }
    const fields = [field("数量", doc.quantity), field("单位", doc.unit)];
    if (doc.item_ref?.name) fields.push(field("物料编码", doc.item_ref.name));
    if (doc.expected_on) fields.push(field("期望到货", doc.expected_on));
    if (doc.received_on) fields.push(field("入库日期", doc.received_on));
    if (doc.purchase_plan_id) fields.push(field("关联采购", doc.purchase_plan_id.slice(0, 8)));
    return fields;
  }

  function renderItem(doc) {
    const item = document.createElement("article");
    item.className = "documents-item" + (doc.blocked ? " is-blocked" : "");
    item.append(itemHead(doc));
    const fields = document.createElement("div");
    fields.className = "documents-item-fields";
    fields.append(...fieldsFor(doc));
    item.append(fields);
    if (doc.blocked) {
      const blocking = (doc.issues || []).filter(issue => issue?.severity === "blocking");
      const note = document.createElement("p");
      note.className = "documents-blocked-note";
      note.textContent = `阻断问题 ${blocking.length} 项：${blocking.map(issue => issue.question || issue.issue_key).join("；")}`;
      item.append(note);
    }
    if (doc.status !== "confirmed") {
      const actions = document.createElement("div");
      actions.className = "documents-actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button primary small";
      button.textContent = "确认单据";
      button.disabled = Boolean(doc.blocked);
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await request(url(workspace.dataset.documentConfirmUrl,
            { __DOC_TYPE__: doc._docType, __DOC__: doc.id }), { method: "POST" });
          await load(doc._docType, { silent: true });
        } catch (error) {
          const message = blocks[doc._docType].message;
          message.textContent = error.message;
          button.disabled = false;
        }
      });
      actions.append(button);
      item.append(actions);
    }
    return item;
  }

  async function load(docType, { silent = false } = {}) {
    const block = blocks[docType];
    const message = block.message;
    if (!silent) message.textContent = "";
    block.list.setAttribute("aria-busy", "true");
    try {
      const body = await request(url(workspace.dataset.documentsUrl, { __DOC_TYPE__: docType }));
      block.list.replaceChildren();
      if (!body.documents?.length) {
        const empty = document.createElement("p");
        empty.className = "intake-muted";
        empty.textContent = `暂无${DOC_LABELS[docType]}记录；在“字段核对”里用对应候选类别生成单据后出现在这里。`;
        block.list.append(empty);
      } else {
        for (const doc of body.documents) block.list.append(renderItem({ ...doc, _docType: docType }));
      }
      block.loaded = true;
    } catch (error) {
      block.list.replaceChildren();
      const note = document.createElement("p");
      note.className = "intake-muted";
      note.textContent = error.message;
      block.list.append(note);
      if (!silent) message.textContent = error.message;
    } finally {
      block.list.removeAttribute("aria-busy");
    }
  }

  for (const docType of DOC_TYPES) {
    by(blocks[docType])("[data-doc-refresh]").addEventListener("click", () => load(docType));
  }
  for (const docType of DOC_TYPES) load(docType);
})();
