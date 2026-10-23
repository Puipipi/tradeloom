(() => {
  const root = document.querySelector('[data-testid="intake-workbench"]');
  const workspace = root?.querySelector('[data-testid="intake-links"]');
  if (!root || !workspace) return;

  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || "";
  const businessUrl = globalThis.TradeLoomBusiness?.businessUrl || (value => value);
  const sides = Object.fromEntries(["left", "right"].map(name => [name, {
    name, sourceId: "", candidates: [], candidateOffset: 0, nextCandidateOffset: null,
    candidateGeneration: 0, links: [], linkOffset: 0, nextLinkOffset: null, historyGeneration: 0,
  }]));
  let sources = [];
  let sourceOffset = 0;
  let nextSourceOffset = 0;
  let sourcesGeneration = 0;
  let busy = false;
  let pending = null;
  const candidateTypeLabels = {
    product_identity: "产品身份候选", commercial_source: "商业单据候选",
    production_instruction: "生产指令候选", labor_analysis: "工时分析候选",
  };
  const summaryFields = {
    product_identity: [["style_number", "款号"], ["description", "描述"], ["customer_item_code", "客户货号"]],
    commercial_source: [["document_reference", "单据编号"], ["item_description", "货品描述"], ["party_text", "往来方"]],
    production_instruction: [["source_order_reference", "来源单号"], ["description", "描述"], ["specification", "规格"]],
    labor_analysis: [["process", "工序"], ["notes", "备注"]],
  };

  const by = selector => workspace.querySelector(selector);
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const idempotencyKey = () => globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const request = async (url, options = {}) => {
    const response = await fetch(businessUrl(url), {
      credentials: "same-origin", ...options,
      headers: { "X-CSRFToken": csrf, ...(options.headers || {}) },
    });
    const body = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const error = new Error(body?.error_code === "candidate_not_found" ? "候选已不可用，请重新载入来源资料。"
        : body?.error_code === "idempotency_conflict" ? "同一请求编号对应了不同判断内容，请编辑后重新保存。"
          : body?.error_code === "invalid_arguments" ? "关联判断内容无效，请检查选择和理由。"
            : `读取或保存失败（HTTP ${response.status}）。`);
      error.code = body?.error_code || "unavailable";
      throw error;
    }
    return body;
  };
  const query = (base, params) => {
    const url = new URL(businessUrl(base), location.href);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    return `${url.pathname}${url.search}`;
  };

  function showMessage(element, message, error = false) {
    element.textContent = message;
    element.classList.toggle("is-error", error);
  }

  function renderSources() {
    for (const name of ["left", "right"]) {
      const select = by(`[data-link-source="${name}"]`);
      const selected = sides[name].sourceId;
      select.replaceChildren(node("option", "", sources.length ? "选择来源资料" : "没有已保存的来源资料"));
      select.options[0].value = "";
      for (const source of sources) {
        const option = node("option", "", source.display_name || `来源 ${source.id.slice(0, 8)}`);
        option.value = source.id;
        select.append(option);
      }
      select.value = selected;
      by(`[data-link-more-sources="${name}"]`).hidden = nextSourceOffset === null;
      by(`[data-link-retry-sources="${name}"]`).hidden = true;
    }
  }

  async function loadSources(offset = 0) {
    const generation = ++sourcesGeneration;
    for (const name of ["left", "right"]) showMessage(by(`[data-link-status="${name}"]`), "正在读取来源资料…");
    try {
      const body = await request(query(root.dataset.sourcesUrl, { offset, limit: 50 }));
      if (generation !== sourcesGeneration) return;
      sources = offset === 0 ? body.sources || [] : [...sources, ...(body.sources || [])];
      nextSourceOffset = body.next_offset ?? null;
      renderSources();
      for (const name of ["left", "right"]) showMessage(by(`[data-link-status="${name}"]`), sources.length
        ? "请选择来源资料；候选列表按来源过滤。" : "尚无来源资料，请先保存一份工作簿。");
    } catch (error) {
      if (generation !== sourcesGeneration) return;
      for (const name of ["left", "right"]) showMessage(by(`[data-link-status="${name}"]`), `${error.message} 可重试。`, true);
      for (const name of ["left", "right"]) by(`[data-link-retry-sources="${name}"]`).hidden = false;
    }
  }

  function renderCandidates(side) {
    const select = by(`[data-link-candidate="${side.name}"]`);
    const current = select.value;
    select.replaceChildren(node("option", "", side.sourceId ? "选择候选" : "先选择来源资料"));
    select.options[0].value = "";
    for (const candidate of side.candidates) {
      const type = candidateTypeLabels[candidate.candidate_type] || "待确认候选";
      const summary = (summaryFields[candidate.candidate_type] || []).map(([key, label]) => {
        const values = candidate.fields?.[key];
        if (!Array.isArray(values)) return "";
        const entry = values.find(item => item?.state === "present" &&
          (typeof item.value === "string" || typeof item.value === "number"));
        return entry ? `${label}：${String(entry.value).slice(0, 60)}` : "";
      }).find(Boolean);
      const option = node("option", "", `${type}${summary ? ` · ${summary}` : " · 没有可显示的字段摘要"} · ${candidate.id.slice(0, 8)}`);
      option.value = candidate.id;
      select.append(option);
    }
    select.value = side.candidates.some(item => item.id === current) ? current : "";
    select.disabled = busy || !side.sourceId;
    const more = by(`[data-link-more-candidates="${side.name}"]`);
    more.hidden = side.nextCandidateOffset === null;
    more.disabled = busy;
    if (side.sourceId && side.candidates.length === 0) showMessage(by(`[data-link-status="${side.name}"]`), "此来源尚无候选；可切换到另一来源或稍后重试。");
  }

  async function loadCandidates(side, offset = 0) {
    const generation = ++side.candidateGeneration;
    const sourceId = side.sourceId;
    if (!sourceId) return;
    showMessage(by(`[data-link-status="${side.name}"]`), offset ? "正在载入更多候选…" : "正在读取此来源的候选…");
    try {
      const body = await request(query(root.dataset.candidatesUrl, { source_id: sourceId, offset, limit: 50 }));
      if (generation !== side.candidateGeneration || sourceId !== side.sourceId) return;
      side.candidates = offset === 0 ? body.candidates || [] : [...side.candidates, ...(body.candidates || [])];
      side.nextCandidateOffset = body.next_offset ?? null;
      renderCandidates(side);
      if (side.candidates.length) showMessage(by(`[data-link-status="${side.name}"]`), `${side.candidates.length} 个候选已载入${side.nextCandidateOffset === null ? "。" : "，还可继续载入。"}`);
    } catch (error) {
      if (generation !== side.candidateGeneration || sourceId !== side.sourceId) return;
      showMessage(by(`[data-link-status="${side.name}"]`), `${error.message} 可重试。`, true);
      by(`[data-link-retry-candidates="${side.name}"]`).hidden = false;
    }
  }

  function renderHistory(side) {
    const host = by(`[data-link-history="${side.name}"]`);
    host.replaceChildren();
    if (!by(`[data-link-candidate="${side.name}"]`).value) {
      host.textContent = "选择候选查看其关联判断历史。";
      by(`[data-link-more-history="${side.name}"]`).hidden = true;
      return;
    }
    host.append(node("p", "intake-muted", "最近判断排在前面；可继续载入较早记录。"));
    if (!side.links.length) host.append(node("p", "intake-muted", "此候选尚无关联判断历史。"));
    for (const link of side.links) {
      const item = node("article", "intake-link-record");
      const relation = link.left_candidate_id === by(`[data-link-candidate="${side.name}"]`).value
        ? link.right_candidate_id : link.left_candidate_id;
      const labels = { suggested: "建议关联", confirmed: "确认关联判断", rejected: "否决关联" };
      item.append(node("strong", "", labels[link.decision] || "关联判断"));
      item.append(node("span", "intake-muted", `另一候选 ${relation} · 人工判断记录`));
      item.append(node("span", "intake-muted", `${link.actor || "操作者未记录"} · ${link.created_at || "时间未记录"}`));
      const reason = typeof link.evidence?.reason === "string" && link.evidence.reason.length <= 1000
        ? link.evidence.reason : "未填写理由";
      item.append(node("p", "", `理由：${reason}`));
      host.append(item);
    }
    by(`[data-link-more-history="${side.name}"]`).hidden = side.nextLinkOffset === null;
  }

  async function loadHistory(side, offset = 0) {
    const candidateId = by(`[data-link-candidate="${side.name}"]`).value;
    if (!candidateId) { side.links = []; side.nextLinkOffset = null; renderHistory(side); return; }
    const generation = ++side.historyGeneration;
    try {
      const base = root.dataset.candidateLinksUrl.replace("__CANDIDATE__", encodeURIComponent(candidateId));
      const body = await request(query(base, { offset, limit: 50 }));
      if (generation !== side.historyGeneration || candidateId !== by(`[data-link-candidate="${side.name}"]`).value) return;
      side.links = offset === 0 ? body.links || [] : [...side.links, ...(body.links || [])];
      side.nextLinkOffset = body.next_offset ?? null;
      renderHistory(side);
    } catch (error) {
      if (generation !== side.historyGeneration || candidateId !== by(`[data-link-candidate="${side.name}"]`).value) return;
      const host = by(`[data-link-history="${side.name}"]`);
      host.replaceChildren(node("p", "intake-message is-error", `${error.message} 可重试。`));
      by(`[data-link-more-history="${side.name}"]`).hidden = false;
    }
  }

  function refreshSubmitState() {
    const left = by('[data-link-candidate="left"]').value;
    const right = by('[data-link-candidate="right"]').value;
    const reason = by('[data-link-form] [name="reason"]').value.trim();
    const validId = value => /^[a-f0-9]{32}$/.test(value);
    by("[data-link-submit]").disabled = busy || !validId(left) || !validId(right) || left === right || !reason;
  }

  async function saveLink(event) {
    event.preventDefault();
    const leftId = by('[data-link-candidate="left"]').value;
    const rightId = by('[data-link-candidate="right"]').value;
    const form = by("[data-link-form]");
    const payload = JSON.stringify({ other_candidate_id: rightId, decision: form.elements.decision.value,
      reason: form.elements.reason.value.trim() });
    if (!leftId || !rightId || leftId === rightId || !form.elements.reason.value.trim()) return;
    if (!pending || pending.payload !== payload || pending.leftId !== leftId) pending = { payload, leftId, key: idempotencyKey() };
    busy = true;
    const controls = workspace.querySelectorAll("select, textarea, button");
    controls.forEach(element => { element.disabled = true; });
    showMessage(by("[data-link-message]"), "正在保存人工关联判断…");
    try {
      const url = root.dataset.candidateLinksUrl.replace("__CANDIDATE__", encodeURIComponent(leftId));
      await request(url, { method: "POST", headers: {
        "Content-Type": "application/json", "Idempotency-Key": pending.key,
      }, body: pending.payload });
      if (leftId !== by('[data-link-candidate="left"]').value || rightId !== by('[data-link-candidate="right"]').value) return;
      pending = null;
      showMessage(by("[data-link-message]"), "关联判断已保存为一条历史记录；候选和业务对象没有变更。");
      await Promise.all([loadHistory(sides.left), loadHistory(sides.right)]);
    } catch (error) {
      showMessage(by("[data-link-message]"), `${error.message} 重新保存会重试同一请求。`, true);
    } finally {
      busy = false;
      controls.forEach(element => { element.disabled = false; });
      for (const name of ["left", "right"]) renderCandidates(sides[name]);
      refreshSubmitState();
    }
  }

  function selectionChanged(side) {
    side.historyGeneration++;
    const id = by(`[data-link-candidate="${side.name}"]`).value;
    side.links = [];
    side.nextLinkOffset = null;
    renderHistory(side);
    refreshSubmitState();
    if (id) loadHistory(side);
    if (pending && (pending.leftId !== by('[data-link-candidate="left"]').value ||
        JSON.stringify({ other_candidate_id: by('[data-link-candidate="right"]').value,
          decision: by('[data-link-form] [name="decision"]').value,
          reason: by('[data-link-form] [name="reason"]').value.trim() }) !== pending.payload)) pending = null;
  }

  for (const name of ["left", "right"]) {
    const side = sides[name];
    by(`[data-link-source="${name}"]`).addEventListener("change", event => {
      side.sourceId = event.target.value;
      side.candidates = [];
      side.nextCandidateOffset = null;
      side.candidateOffset = 0;
      side.candidateGeneration++;
      side.historyGeneration++;
      by(`[data-link-retry-candidates="${name}"]`).hidden = true;
      const placeholder = node("option", "", side.sourceId ? "正在读取候选…" : "先选择来源资料");
      placeholder.value = "";
      by(`[data-link-candidate="${name}"]`).replaceChildren(placeholder);
      by(`[data-link-candidate="${name}"]`).disabled = !side.sourceId || busy;
      renderHistory(side);
      refreshSubmitState();
      if (side.sourceId) loadCandidates(side);
    });
    by(`[data-link-candidate="${name}"]`).addEventListener("change", () => selectionChanged(side));
    by(`[data-link-more-candidates="${name}"]`).addEventListener("click", () => {
      if (side.nextCandidateOffset !== null) loadCandidates(side, side.nextCandidateOffset);
    });
    by(`[data-link-more-history="${name}"]`).addEventListener("click", () => loadHistory(side, side.nextLinkOffset ?? 0));
    by(`[data-link-retry-candidates="${name}"]`).addEventListener("click", () => loadCandidates(side));
    by(`[data-link-retry-sources="${name}"]`).addEventListener("click", () => loadSources(sourceOffset));
  }
  by('[data-link-form] [name="decision"]').addEventListener("change", refreshSubmitState);
  by('[data-link-form] [name="reason"]').addEventListener("input", refreshSubmitState);
  by("[data-link-form]").addEventListener("submit", saveLink);
  workspace.querySelectorAll("[data-link-more-sources]").forEach(button => button.addEventListener("click", () => {
    if (nextSourceOffset !== null) { sourceOffset = nextSourceOffset; loadSources(sourceOffset); }
  }));
  loadSources();
})();
