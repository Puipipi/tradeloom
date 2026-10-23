(() => {
  const embeddedBusinessPage = document.documentElement?.dataset?.businessEmbed === "true";
  if (embeddedBusinessPage && window.parent !== window) {
    document.documentElement.dataset.businessIframe = "true";
    const onThemeMessage = (event) => {
      const value = event.data;
      if (event.source !== window.parent || event.origin !== window.location.origin
        || !value || value.type !== "tradeloom:theme"
        || Object.keys(value).sort().join(",") !== "colorScheme,palette,type"
        || !["light", "dark"].includes(value.colorScheme)) return;
      const paletteKeys = ["accent", "border", "canvas", "header", "muted", "panel", "teal", "text"];
      if (!value.palette || Object.keys(value.palette).sort().join(",") !== paletteKeys.join(",")
        || paletteKeys.some(key => typeof value.palette[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(value.palette[key]))) return;
      document.documentElement.dataset.colorScheme = value.colorScheme;
      for (const key of paletteKeys) document.documentElement.style.setProperty(`--wb-theme-${key}`, value.palette[key]);
    };
    window.addEventListener("message", onThemeMessage);
    window.parent.postMessage({ type: "tradeloom:theme:request" }, window.location.origin);
  }

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
  const businessUrl = globalThis.TradeLoomBusiness?.businessUrl || (value => value);

  async function jsonFetch(url, options = {}) {
    const response = await fetch(businessUrl(url), {
      credentials: "same-origin",
      ...options,
      headers: {
        "X-CSRFToken": csrfToken,
        ...(options.headers || {}),
      },
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      const failure = new Error(
        (typeof body === "object" && body?.detail) || `HTTP ${response.status}`,
      );
      failure.status = response.status;
      failure.code = body?.code;
      failure.terminal = body?.terminal === true;
      throw failure;
    }
    return body;
  }

  function showError(id, message) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
  }

  const workflowCreateForm = document.getElementById("workflow-create-form");
  if (workflowCreateForm) {
    const draftStorageKey = "tradeloom.workflow-create.pending.v1";
    const draftNotice = document.getElementById("workflow-create-notice");
    const error = document.getElementById("workflow-create-error");
    const previewPanel = document.getElementById("workflow-intent-preview");
    const previewReason = previewPanel.querySelector("[data-intent-reason]");
    const previewTaskType = previewPanel.querySelector("[data-intent-task-type]");
    const previewEvidence = previewPanel.querySelector("[data-intent-evidence]");
    const previewSources = previewPanel.querySelector("[data-intent-sources]");
    const previewVersions = previewPanel.querySelector("[data-intent-versions]");
    const previewClarification = previewPanel.querySelector("[data-intent-clarification]");
    const previewMode = previewPanel.querySelector("[data-intent-mode]");
    const confirmButton = previewPanel.querySelector("[data-intent-confirm]");
    const loadProposalButton = document.getElementById("workflow-load-agent-proposal");
    const supportedTaskTypes = new Set(["prepare_product_data", "generate_deliverables"]);
    const taskTypeLabels = {
      prepare_product_data: "产品资料准备",
      generate_deliverables: "生成交付文件",
    };
    let storageAvailable = true;
    let drafts = [];
    let activeDraft = null;
    let shownPayload = null;
    let proposedTaskType = "";
    let pendingAgentProposal = null;

    function currentWorkflowPayload() {
      const payload = {
        batch_id: workflowCreateForm.elements.batch_id.value,
        user_goal: workflowCreateForm.elements.user_goal.value,
      };
      if (proposedTaskType) payload.task_type = proposedTaskType;
      return payload;
    }

    function sameWorkflowPayload(left, right) {
      return left?.batch_id === right?.batch_id
        && left?.user_goal === right?.user_goal
        && left?.task_type === right?.task_type;
    }

    function persistDrafts() {
      try {
        globalThis.sessionStorage.setItem(draftStorageKey, JSON.stringify({
          version: 2,
          activeKey: activeDraft?.key || null,
          requests: drafts,
        }));
        storageAvailable = true;
      } catch (_error) {
        storageAvailable = false;
        showDraftNotice("此浏览器无法保存未确认请求，请保持本页重试；刷新后需先查看任务列表。");
      }
    }

    function draftFor(payload) {
      let draft = drafts.find((item) => sameWorkflowPayload(item.payload, payload));
      if (!draft) {
        draft = { key: newWorkflowKey(), payload, preview: null, createAttempted: false };
        drafts.push(draft);
      }
      activeDraft = draft;
      shownPayload = payload;
      persistDrafts();
      return draft;
    }

    function hidePreview() {
      previewPanel.hidden = true;
      confirmButton.disabled = true;
      confirmButton.hidden = true;
    }

    function renderPreview(preview) {
      previewPanel.hidden = false;
      previewMode.textContent = `${preview.mode || "local_mock"} · ${preview.execution || "simulated_rules"} · ${preview.model_provider || "not_configured"}`;
      previewReason.textContent = preview.classification?.reason || "";
      previewTaskType.textContent = preview.classification?.task_type
        ? `提案类型：${taskTypeLabels[preview.classification.task_type] || "不支持的类型"}`
        : "";
      previewEvidence.textContent = preview.evidence?.length
        ? `匹配依据：${preview.evidence.join("、")}`
        : (preview.mode === "agent_proposal" ? "这是 Agent 提案，尚无规则匹配依据。" : "没有足够依据形成确定候选。");
      previewSources.textContent = `只读上下文：${(preview.sources || []).map((source) => `${source.kind} ${source.id || ""} ${source.title || `数量 ${source.count}`}`).join("；")}`;
      previewVersions.textContent = `规则 ${preview.rules?.version || "—"} / ${preview.rules?.sha256 || "—"} · 提示模板 ${preview.prompt?.version || "—"} / ${preview.prompt?.sha256 || "—"}`;
      previewClarification.textContent = preview.clarification || (preview.status === "unsupported" ? preview.classification?.reason || "该目标当前不受支持。" : "");
      previewClarification.hidden = preview.status === "ready";
      confirmButton.hidden = preview.status !== "ready";
      confirmButton.disabled = preview.status !== "ready" || !preview.confirmation_token;
      confirmButton.textContent = "确认并保存计划";
      if (activeDraft?.legacyReplayPayload) {
        confirmButton.hidden = false;
        confirmButton.disabled = false;
        confirmButton.textContent = "重试上次已确认请求";
        previewClarification.textContent = "这是更新前已经明确提交、但结果未知的原请求；重试会原样复用其幂等键。";
        previewClarification.hidden = false;
      }
    }

    function newWorkflowKey() {
      try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
      } catch (_error) {
        // Use the local fallback when browser crypto is unavailable.
      }
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function showDraftNotice(message) {
      if (!draftNotice) return;
      draftNotice.textContent = message;
      draftNotice.hidden = false;
    }

    function readAgentProposal(hash) {
      if (typeof hash !== "string" || !hash.startsWith("#proposal=")) return { present: false };
      try {
        const proposal = JSON.parse(decodeURIComponent(hash.slice("#proposal=".length)));
        const keys = Object.keys(proposal || {}).sort();
        if (
          keys.join(",") !== "batch_id,task_type,user_goal,version"
          || proposal.version !== 1
          || typeof proposal.batch_id !== "string"
          || !proposal.batch_id.trim()
          || proposal.batch_id.length > 32
          || typeof proposal.user_goal !== "string"
          || !proposal.user_goal.trim()
          || proposal.user_goal.length > 4000
          || !supportedTaskTypes.has(proposal.task_type)
        ) return { present: true, invalid: true };
        return { present: true, proposal: {
          batch_id: proposal.batch_id,
          user_goal: proposal.user_goal,
          task_type: proposal.task_type,
        } };
      } catch (_error) {
        return { present: true, invalid: true };
      }
    }

    function loadAgentProposal(proposal, persist) {
      if (persist) {
        for (const draft of drafts) {
          if (!draft.createAttempted) draft.preserveAfterAgentProposal = true;
        }
      }
      proposedTaskType = proposal.task_type;
      workflowCreateForm.elements.batch_id.value = proposal.batch_id;
      workflowCreateForm.elements.user_goal.value = proposal.user_goal;
      shownPayload = null;
      hidePreview();
      if (persist) draftFor(currentWorkflowPayload());
      if (loadProposalButton) loadProposalButton.hidden = true;
      pendingAgentProposal = null;
      showDraftNotice("Agent提案，待确认。请检查批次和字面目标，再点击“解析目标”；只有你明确确认后才会保存计划。");
    }

    try {
      const saved = globalThis.sessionStorage.getItem(draftStorageKey);
      if (saved) {
        const draft = JSON.parse(saved);
        if (draft?.version === 2 && Array.isArray(draft.requests)) {
          drafts = draft.requests.filter((item) => typeof item?.key === "string" && item.payload);
          activeDraft = drafts.find((item) => item.key === draft.activeKey) || null;
        } else if (
          typeof draft?.key === "string" && draft.key
          && typeof draft?.payload?.batch_id === "string"
          && typeof draft?.payload?.user_goal === "string"
          && typeof draft?.payload?.task_type === "string"
        ) {
          const legacy = {
            key: draft.key,
            payload: { batch_id: draft.payload.batch_id, user_goal: draft.payload.user_goal },
            legacyReplayPayload: draft.payload,
            preview: { status: "legacy_retry", mode: "local_mock", execution: "simulated_rules", model_provider: "not_configured" },
          };
          drafts = [legacy];
          activeDraft = legacy;
          showDraftNotice("已恢复更新前的未知创建请求。重试时会原样复用之前已确认的请求和幂等键。");
        }
        if (activeDraft) {
          proposedTaskType = supportedTaskTypes.has(activeDraft.payload.task_type)
            ? activeDraft.payload.task_type
            : "";
          if (proposedTaskType && !activeDraft.createAttempted) {
            activeDraft.preview = null;
            persistDrafts();
          }
          const batchSelect = workflowCreateForm.elements.batch_id;
          if (
            batchSelect.options
            && !Array.from(batchSelect.options).some((option) => option.value === activeDraft.payload.batch_id)
            && typeof document.createElement === "function"
            && typeof batchSelect.add === "function"
          ) {
            const restoredOption = document.createElement("option");
            restoredOption.value = activeDraft.payload.batch_id;
            restoredOption.textContent = `已提交批次（${activeDraft.payload.batch_id}）`;
            batchSelect.add(restoredOption);
          }
          workflowCreateForm.elements.batch_id.value = activeDraft.payload.batch_id;
          workflowCreateForm.elements.user_goal.value = activeDraft.payload.user_goal;
          shownPayload = currentWorkflowPayload();
          if (activeDraft.preview) renderPreview(activeDraft.preview);
          if (activeDraft.createAttempted) {
            showDraftNotice("已恢复结果未知的原创建请求，重试会沿用原请求和幂等键。");
          } else if (proposedTaskType) {
            showDraftNotice("Agent提案，待确认。刷新后预览已失效，请重新解析目标。");
          } else if (!activeDraft.legacyReplayPayload) {
            showDraftNotice("已恢复尚未提交创建的目标。预览和创建请求会沿用该目标对应的会话草稿。");
          }
        } else if (draft) {
          globalThis.sessionStorage.removeItem(draftStorageKey);
        }
      }
    } catch (_error) {
      storageAvailable = false;
      showDraftNotice("此浏览器无法保存未确认请求，请保持本页重试；刷新后需先查看任务列表。");
    }

    const handoff = readAgentProposal(globalThis.location?.hash || "");
    if (handoff.present) {
      if (handoff.invalid) {
        showDraftNotice("Agent提案无效或不受支持，未载入表单。");
      } else if (activeDraft && sameWorkflowPayload(activeDraft.payload, handoff.proposal)) {
        proposedTaskType = handoff.proposal.task_type;
        showDraftNotice(activeDraft.createAttempted
          ? "已恢复结果未知的原创建请求，重试会沿用原请求和幂等键。"
          : "Agent提案，待确认。刷新后预览已失效，请重新解析目标。");
      } else if (drafts.length) {
        pendingAgentProposal = handoff.proposal;
        if (loadProposalButton) {
          loadProposalButton.hidden = false;
          loadProposalButton.addEventListener("click", () => loadAgentProposal(pendingAgentProposal, true));
        }
        showDraftNotice("已有未确认草稿；当前 Agent 提案未载入。可选择保留旧草稿并载入此提案。");
      } else {
        loadAgentProposal(handoff.proposal, false);
      }
    }

    workflowCreateForm.addEventListener("input", () => {
      shownPayload = null;
      hidePreview();
      if (activeDraft?.payload?.task_type && !activeDraft.createAttempted) {
        activeDraft.preview = null;
        persistDrafts();
        showDraftNotice("Agent提案字段已变化，旧预览已失效；请重新解析目标。");
      }
    });
    workflowCreateForm.addEventListener("change", () => {
      shownPayload = null;
      hidePreview();
      if (activeDraft?.payload?.task_type && !activeDraft.createAttempted) {
        activeDraft.preview = null;
        persistDrafts();
        showDraftNotice("Agent提案字段已变化，旧预览已失效；请重新解析目标。");
      }
    });
    workflowCreateForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!workflowCreateForm.reportValidity()) return;
      const button = workflowCreateForm.querySelector('button[type="submit"]');
      const payload = currentWorkflowPayload();
      const draft = draftFor(payload);
      if (draft.legacyReplayPayload || (draft.createAttempted && draft.preview)) {
        renderPreview(draft.preview);
        return;
      }
      button.disabled = true;
      error.hidden = true;
      try {
        const preview = await jsonFetch(workflowCreateForm.dataset.intentPreviewEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        draft.preview = preview;
        activeDraft = draft;
        shownPayload = sameWorkflowPayload(currentWorkflowPayload(), payload) ? payload : null;
        persistDrafts();
        if (shownPayload) {
          renderPreview(preview);
        } else {
          hidePreview();
          error.textContent = "解析期间目标已变化。旧预览已失效，请对当前目标重新解析。";
          error.hidden = false;
        }
      } catch (requestError) {
        error.textContent = `预览未完成，因此没有创建工作流。${requestError.message}`;
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    });

    confirmButton.addEventListener("click", async () => {
      const payload = currentWorkflowPayload();
      if (!activeDraft || !sameWorkflowPayload(activeDraft.payload, payload) || !sameWorkflowPayload(shownPayload, payload)) {
        error.textContent = "目标已变化，请重新解析后再确认。";
        error.hidden = false;
        hidePreview();
        return;
      }
      if (!activeDraft.legacyReplayPayload && (!activeDraft.preview?.confirmation_token || activeDraft.preview.status !== "ready")) {
        error.textContent = "当前预览未就绪，不能创建工作流。";
        error.hidden = false;
        return;
      }
      const requestPayload = activeDraft.legacyReplayPayload
        ? { ...activeDraft.legacyReplayPayload, idempotency_key: activeDraft.key }
        : {
            ...activeDraft.payload,
            task_type: activeDraft.preview.action.task_type,
            confirmation_token: activeDraft.preview.confirmation_token,
            idempotency_key: activeDraft.key,
          };
      confirmButton.disabled = true;
      workflowCreateForm.elements.batch_id.disabled = true;
      workflowCreateForm.elements.user_goal.disabled = true;
      error.hidden = true;
      activeDraft.createAttempted = true;
      persistDrafts();
      try {
        const workflow = await jsonFetch(workflowCreateForm.dataset.workflowCreateEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
        });
        if (typeof workflow?.id !== "string" || !workflow.id.trim()) {
          throw new Error("服务器响应未返回有效工作流编号，请保持本页重试同一请求。");
        }
        drafts = drafts.filter((item) => (
          item.key !== activeDraft.key && (item.createAttempted || item.preserveAfterAgentProposal)
        ));
        activeDraft = drafts.at(-1) || null;
        shownPayload = activeDraft?.payload || null;
        try {
          if (activeDraft) persistDrafts();
          else globalThis.sessionStorage.removeItem(draftStorageKey);
        } catch (_error) {
          showDraftNotice("创建已确认，但浏览器无法清除暂存记录；若再次访问本页，请先查看任务列表。");
        }
        location.href = businessUrl(`/workflow-tasks/${workflow.id}`);
      } catch (requestError) {
        if (requestError.code === "intent_confirmation_invalid") {
          activeDraft.createAttempted = false;
          activeDraft.preview = null;
          activeDraft.key = newWorkflowKey();
          shownPayload = null;
          persistDrafts();
          hidePreview();
          error.textContent = "服务器明确拒绝了过期或不匹配的预览，未创建工作流。请重新解析目标后再确认。";
        } else {
        error.textContent = storageAvailable
          ? `${requestError.message}。尚未确认是否创建成功；再次确认会沿用相同目标、token 和幂等键。`
          : `此浏览器无法保存未确认请求，请保持本页重试；刷新后需先查看任务列表。${requestError.message}`;
        }
        error.hidden = false;
        confirmButton.disabled = false;
        workflowCreateForm.elements.batch_id.disabled = false;
        workflowCreateForm.elements.user_goal.disabled = false;
      }
    });
  }

  document.querySelectorAll(".review-note-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button[type="submit"]');
      const note = form.elements.note.value.trim();
      const reviewer = form.elements.reviewer.value.trim();
      const error = form.querySelector("[data-review-error]");
      if (!note || !reviewer) {
        error.textContent = "请填写补充说明和填写人标签。";
        error.hidden = false;
        return;
      }
      button.disabled = true;
      error.hidden = true;
      try {
        await jsonFetch(form.dataset.submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            review_key: form.dataset.reviewKey,
            answer: { note },
            reviewer,
          }),
        });
        location.reload();
      } catch (requestError) {
        error.textContent = requestError.message;
        error.hidden = false;
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll(".review-image-upload-form").forEach((form) => {
    const imageInput = form.elements.image;
    imageInput.addEventListener("change", () => {
      form.dataset.idempotencyKey = "";
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const image = imageInput.files?.[0];
      const reviewer = form.elements.reviewer.value.trim();
      const button = form.querySelector('button[type="submit"]');
      const error = form.querySelector("[data-upload-error]");
      if (!image || !reviewer) {
        error.textContent = "请选择真实图片并填写上传人标签。";
        error.hidden = false;
        return;
      }
      if (!form.dataset.idempotencyKey) {
        form.dataset.idempotencyKey = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      }
      const payload = new FormData();
      payload.set("image", image);
      payload.set("review_key", form.dataset.reviewKey);
      payload.set("idempotency_key", form.dataset.idempotencyKey);
      payload.set("reviewer", reviewer);
      button.disabled = true;
      error.hidden = true;
      try {
        const response = await fetch(businessUrl(form.dataset.uploadUrl), {
          method: "POST",
          credentials: "same-origin",
          headers: { "X-CSRFToken": csrfToken },
          body: payload,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.detail || `HTTP ${response.status}`);
        location.reload();
      } catch (requestError) {
        error.textContent = requestError.message;
        error.hidden = false;
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll(".review-typed-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button[type="submit"]');
      const reviewer = form.elements.reviewer.value.trim();
      const error = form.querySelector("[data-review-error]");
      const refresh = form.querySelector("[data-review-refresh]");
      if (!reviewer) {
        error.textContent = "请填写操作人标签。";
        error.hidden = false;
        return;
      }
      let response;
      if (form.dataset.answerType === "set_literal_field") {
        const value = form.elements.value.value;
        if (!value.trim()) {
          error.textContent = "请按原文填写字段值。";
          error.hidden = false;
          return;
        }
        response = {
          type: "set_literal_field",
          field: form.dataset.field,
          value,
        };
      } else if (form.dataset.answerType === "resolve_duplicate_sku") {
        const value = form.elements.value.value;
        if (!value.trim()) {
          error.textContent = "请明确填写货号；保留原货号时也需要亲自输入。";
          error.hidden = false;
          return;
        }
        response = {
          type: "resolve_duplicate_sku",
          value,
        };
      } else if (form.dataset.answerType === "confirm_current_revision") {
        response = {
          type: "confirm_current_revision",
          revision_id: form.dataset.revisionId,
        };
      } else if (form.dataset.answerType === "select_image_candidate") {
        const taskFileId = form.elements.task_file_id.value;
        if (!taskFileId) {
          error.textContent = "请明确选择一张候选图片。";
          error.hidden = false;
          return;
        }
        response = {
          type: "select_image_candidate",
          task_file_id: taskFileId,
        };
      } else if (form.dataset.answerType === "provide_image") {
        const uploadStepId = form.elements.upload_step_id.value;
        if (!uploadStepId) {
          error.textContent = "请明确选择一张已上传图片。";
          error.hidden = false;
          return;
        }
        response = {
          type: "provide_image",
          upload_step_id: uploadStepId,
        };
      } else {
        error.textContent = "此人审类型暂不支持结构化提交。";
        error.hidden = false;
        return;
      }
      button.disabled = true;
      error.hidden = true;
      refresh.hidden = true;
      try {
        await jsonFetch(form.dataset.submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            review_key: form.dataset.reviewKey,
            answer: response,
            reviewer,
          }),
        });
        location.reload();
      } catch (requestError) {
        error.textContent = requestError.message;
        error.hidden = false;
        refresh.hidden = false;
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll(".review-cycle-apply-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button[type="submit"]');
      const error = form.querySelector("[data-apply-error]");
      const refresh = form.querySelector("[data-apply-refresh]");
      const reviewer = form.elements.reviewer.value.trim();
      button.disabled = true;
      error.hidden = true;
      refresh.hidden = true;
      try {
        await jsonFetch(form.dataset.applyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            review_ids: Array.from(form.querySelectorAll('input[name="review_id"]'), (input) => input.value),
            idempotency_key: form.dataset.idempotencyKey,
            decision: "apply_and_confirm",
            reviewer,
          }),
        });
        location.reload();
      } catch (requestError) {
        error.textContent = requestError.message;
        error.hidden = false;
        refresh.hidden = false;
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll(".workflow-dispatch-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const error = form.querySelector("[data-dispatch-error]");
      const refresh = form.querySelector("[data-dispatch-refresh]");
      button.disabled = true;
      error.hidden = true;
      refresh.hidden = true;
      try {
        await jsonFetch(form.dataset.dispatchUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotency_key: form.elements.idempotency_key.value,
          }),
        });
        location.reload();
      } catch (requestError) {
        error.textContent = requestError.message;
        error.hidden = false;
        refresh.hidden = false;
        button.disabled = false;
      }
    });
  });

  const pendingTakeoverForm = document.querySelector(".generation-takeover-pending-form");
  const generationTakeoverPendingStorageKey = pendingTakeoverForm?.dataset.workflowId
    ? `tradeloom.generation-takeover.pending.v1:${pendingTakeoverForm.dataset.workflowId}`
    : "";
  const readPendingGenerationTakeover = () => {
    if (!generationTakeoverPendingStorageKey) return null;
    try {
      const saved = sessionStorage.getItem(generationTakeoverPendingStorageKey);
      return saved ? JSON.parse(saved) : null;
    } catch (_error) {
      return null;
    }
  };
  const clearPendingGenerationTakeover = () => {
    if (!generationTakeoverPendingStorageKey) return;
    try {
      sessionStorage.removeItem(generationTakeoverPendingStorageKey);
    } catch (_error) {
      // The server-side receipt remains authoritative.
    }
  };

  if (pendingTakeoverForm) {
    const pending = readPendingGenerationTakeover();
    if (pending && pending.payload && pending.url && pending.body) {
      pendingTakeoverForm.hidden = false;
      const details = pendingTakeoverForm.querySelector("[data-pending-request]");
      details.hidden = false;
      pendingTakeoverForm.querySelector("[data-pending-target]").textContent = `原执行步骤：${pending.expected_step_id}`;
      pendingTakeoverForm.querySelector("[data-pending-key]").textContent = `幂等键：${pending.idempotency_key}`;
      pendingTakeoverForm.querySelector("[data-pending-operator]").textContent = `操作人标签：${pending.payload.operator_label}`;
      pendingTakeoverForm.querySelector("[data-pending-note]").textContent = `接管说明：${pending.payload.note}`;
      const button = pendingTakeoverForm.querySelector('button[type="submit"]');
      button.hidden = false;
      const error = pendingTakeoverForm.querySelector("[data-pending-error]");
      pendingTakeoverForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        button.disabled = true;
        error.hidden = true;
        try {
          await jsonFetch(pending.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: pending.body,
          });
          clearPendingGenerationTakeover();
          location.reload();
        } catch (requestError) {
          error.textContent = `结果未知；再次提交会继续使用原请求核对回执。${requestError.message}`;
          error.hidden = false;
          button.disabled = false;
        }
      });
    }
  }

  document.querySelectorAll(".workflow-retry-form, .workflow-interrupt-form, .generation-takeover-form").forEach((form) => {
    const isGenerationTakeover = form.classList.contains("generation-takeover-form");
    const pending = isGenerationTakeover ? readPendingGenerationTakeover() : null;
    if (pending && pending.idempotency_key === form.dataset.idempotencyKey) {
      form.hidden = true;
    }
    if (isGenerationTakeover && pending && pending.idempotency_key === form.dataset.idempotencyKey) {
      form.elements.operator_label.value = pending.payload.operator_label;
      form.elements.note.value = pending.payload.note;
      form.elements.operator_label.readOnly = true;
      form.elements.note.readOnly = true;
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button[type="submit"]');
      const error = form.querySelector("[data-execution-error]");
      const refresh = form.querySelector("[data-execution-refresh]");
      button.disabled = true;
      error.hidden = true;
      refresh.hidden = true;
      let payload;
      let body;
      if (isGenerationTakeover && pending && pending.idempotency_key !== form.dataset.idempotencyKey) {
        error.textContent = "请先按原请求核对上一次接管回执。";
        error.hidden = false;
        refresh.hidden = true;
        button.disabled = false;
        return;
      }
      if (isGenerationTakeover && pending && pending.idempotency_key === form.dataset.idempotencyKey) {
        payload = pending.payload;
        body = pending.body;
      } else if (isGenerationTakeover) {
        const fields = new FormData(form);
        payload = {
          expected_step_id: form.dataset.expectedStepId,
          decision: fields.get("decision"),
          idempotency_key: form.dataset.idempotencyKey,
          operator_label: fields.get("operator_label"),
          note: fields.get("note") || "",
        };
        body = JSON.stringify(payload);
        try {
          sessionStorage.setItem(generationTakeoverPendingStorageKey, JSON.stringify({
            url: form.dataset.executionUrl,
            expected_step_id: payload.expected_step_id,
            idempotency_key: payload.idempotency_key,
            payload,
            body,
          }));
        } catch (_error) {
          // The in-page form still retains the original payload for retry.
        }
      } else {
        payload = { expected_step_id: form.dataset.expectedStepId };
      }
      if (form.classList.contains("workflow-retry-form")) {
        payload.idempotency_key = form.dataset.idempotencyKey;
      } else if (form.classList.contains("workflow-interrupt-form")) {
        const fields = new FormData(form);
        payload.operator_label = fields.get("operator_label");
        payload.note = fields.get("note") || "";
      }
      try {
        await jsonFetch(form.dataset.executionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body || JSON.stringify(payload),
        });
        if (isGenerationTakeover) {
          clearPendingGenerationTakeover();
        }
        location.reload();
      } catch (requestError) {
        error.textContent = isGenerationTakeover
          ? `结果未知；可按原请求核对接管回执。${requestError.message}`
          : requestError.message;
        error.hidden = false;
        if (refresh) refresh.hidden = false;
        if (isGenerationTakeover) {
          form.querySelectorAll('input[name="operator_label"], textarea[name="note"]').forEach((field) => {
            field.readOnly = true;
          });
        }
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll(".delivery-generate-form, .delivery-review-form, .delivery-complete-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = event.submitter || form.querySelector('button[type="submit"]');
      const error = form.querySelector("[data-delivery-error]");
      const refresh = form.querySelector("[data-delivery-refresh]");
      button.disabled = true;
      error.hidden = true;
      refresh.hidden = true;
      let payload = {};
      let method = "POST";
      if (form.classList.contains("delivery-generate-form")) {
        payload = { idempotency_key: form.dataset.key };
      } else if (form.classList.contains("delivery-review-form")) {
        payload = {
          decision: button.value,
          reviewer: form.elements.reviewer.value.trim(),
          note: form.elements.note.value.trim(),
        };
      }
      try {
        await jsonFetch(form.dataset.url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        location.reload();
      } catch (requestError) {
        error.textContent = requestError.message;
        error.hidden = false;
        refresh.hidden = false;
        button.disabled = false;
      }
    });
  });

  const newPage = document.querySelector("#upload-form");
  if (newPage) {
    document.querySelector('[data-testid="load-demo"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const task = await jsonFetch("/api/tasks/demo", { method: "POST" });
        location.href = businessUrl(`/tasks/${task.id}`);
      } catch (error) {
        showError("new-task-error", error.message);
        button.disabled = false;
      }
    });
    newPage.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = newPage.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const task = await jsonFetch("/api/tasks", {
          method: "POST",
          body: new FormData(newPage),
        });
        location.href = businessUrl(`/tasks/${task.id}`);
      } catch (error) {
        showError("new-task-error", error.message);
        button.disabled = false;
      }
    });
  }

  const detail = document.querySelector("[data-testid='task-detail']");
  if (detail) {
    document.querySelectorAll(".edit-product").forEach((button) => {
      button.addEventListener("click", () => {
        const card = button.closest(".product-card");
        card.querySelector(".edit-form").hidden = false;
        button.hidden = true;
      });
    });
    document.querySelectorAll(".cancel-edit").forEach((button) => {
      button.addEventListener("click", () => {
        const card = button.closest(".product-card");
        card.querySelector(".edit-form").hidden = true;
        card.querySelector(".edit-product").hidden = false;
      });
    });
    document.querySelectorAll(".edit-form").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const card = form.closest(".product-card");
        const payload = Object.fromEntries(new FormData(form).entries());
        try {
          await jsonFetch(`/api/products/${card.dataset.productId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          location.reload();
        } catch (error) {
          showError("detail-error", error.message);
        }
      });
    });
    document.querySelector('[data-testid="confirm-task"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await jsonFetch(`/api/tasks/${detail.dataset.taskId}/confirm`, {
          method: "POST",
        });
        location.reload();
      } catch (error) {
        showError("detail-error", error.message);
        button.disabled = false;
      }
    });
  }

  const agentsPage = document.getElementById("agents-page");
  if (agentsPage) {
    const tasks = JSON.parse(document.getElementById("tasks-data").textContent);
    const capabilities = JSON.parse(document.getElementById("capabilities-data").textContent);
    const select = document.getElementById("agent-task-select");
    const runList = document.getElementById("agent-run-list");
    const errorBox = document.getElementById("agent-error");
    const result = document.getElementById("agent-result");
    const pendingList = document.getElementById("result-pending-list");
    const runButton = document.getElementById("run-product");
    let selectedAgent = "product_profile";
    let requestSequence = 0;
    let running = false;

    const labels = {
      product_profile: ["产品资料", "归一产品字段，按文件名与货号精确匹配图片，并列出待确认项。"],
      quotation: ["询报价", "尚未接入；调用返回 409，不产生报价结果。"],
      catalog_package: ["目录备样", "尚未接入；调用返回 409，不产生目录或 PDF。"],
      shared_task_data: ["共享任务资料", "PostgreSQL 中持久化任务、产品、文件引用和运行记录。"],
    };
    document.querySelectorAll("[data-agent-id]").forEach((button) => {
      button.addEventListener("click", () => {
        requestSequence += 1;
        selectedAgent = button.dataset.agentId;
        document.querySelectorAll("[data-agent-id]").forEach((item) => item.classList.remove("selected"));
        button.classList.add("selected");
        const [name, description] = labels[selectedAgent];
        document.getElementById("agent-kicker").textContent = selectedAgent;
        document.getElementById("agent-name").textContent = name;
        document.getElementById("agent-description").textContent = description;
        runButton.hidden = selectedAgent !== "product_profile";
        clearResult();
      });
    });

    function clearResult() {
      result.hidden = true;
      pendingList.hidden = true;
      pendingList.replaceChildren();
      errorBox.hidden = true;
    }

    function setResultStatus(status) {
      const element = document.getElementById("agent-result-status");
      element.className = "status-pill";
      element.classList.add(
        status === "succeeded"
          ? "confirmed"
          : status === "failed"
            ? "failed"
            : "awaiting_confirmation",
      );
      element.textContent = status;
    }

    async function loadRuns(taskId, sequence) {
      if (!taskId) return;
      runList.textContent = "正在读取运行记录…";
      try {
        const runs = await jsonFetch(`/api/tasks/${taskId}/runs`);
        if (sequence !== requestSequence || select.value !== taskId) return;
        if (!runs.length) {
          runList.textContent = "当前任务还没有 Agent 运行记录。";
          return;
        }
        runList.replaceChildren();
        for (const run of runs) {
          const row = document.createElement("article");
          row.className = "run-row";
          row.dataset.testid = "agent-run-row";
          row.dataset.runId = run.run_id;
          const left = document.createElement("div");
          const capability = document.createElement("strong");
          capability.className = "mono";
          capability.textContent = run.capability_id;
          const id = document.createElement("span");
          id.className = "mono run-id";
          id.textContent = run.run_id.slice(0, 12);
          left.append(capability, id);
          const status = document.createElement("span");
          status.className = "status-pill";
          status.classList.add(
            run.status === "succeeded"
              ? "confirmed"
              : run.status === "failed"
                ? "failed"
                : "awaiting_confirmation",
          );
          status.textContent = run.status;
          const time = document.createElement("time");
          time.className = "mono";
          time.textContent = run.started_at;
          row.append(left, status, time);
          runList.append(row);
        }
      } catch (error) {
        if (sequence !== requestSequence || select.value !== taskId) return;
        runList.textContent = error.message;
      }
    }

    function selectTask(taskId) {
      if (!taskId) return;
      const url = new URL(location.href);
      url.searchParams.set("task", taskId);
      history.replaceState({}, "", url);
      requestSequence += 1;
      clearResult();
      runList.replaceChildren();
      loadRuns(taskId, requestSequence);
    }

    const requestedTask = new URL(location.href).searchParams.get("task");
    if (requestedTask && tasks.some((task) => task.id === requestedTask)) {
      select.value = requestedTask;
    }
    if (select.value) {
      selectTask(select.value);
    } else {
      runButton.disabled = true;
      runList.textContent = "请先创建任务。";
    }
    document.getElementById("refresh-runs").addEventListener("click", () => {
      selectTask(select.value);
    });
    select.addEventListener("change", () => selectTask(select.value));
    runButton.addEventListener("click", async (event) => {
      const taskId = select.value;
      const sequence = ++requestSequence;
      const capabilityId = "product_profile";
      running = true;
      select.disabled = true;
      runButton.disabled = true;
      clearResult();
      try {
        const payload = await globalThis.AgentRunReceipts.dispatch(
          globalThis.sessionStorage,
          taskId,
          capabilityId,
          () => globalThis.crypto.randomUUID(),
          (key) => jsonFetch(
            `/api/tasks/${taskId}/agents/${capabilityId}/runs`,
            { method: "POST", headers: { "Idempotency-Key": key } },
          ),
        );
        if (sequence !== requestSequence || select.value !== taskId) return;
        if (payload.status === "running") {
          errorBox.textContent = "此运行仍在处理中；再次点击会读取同一运行回执。";
          errorBox.hidden = false;
          await loadRuns(taskId, sequence);
          return;
        }
        setResultStatus(payload.status);
        document.getElementById("result-products").textContent = payload.output.product_count;
        document.getElementById("result-pending").textContent = payload.output.pending_count;
        document.getElementById("result-mode").textContent = payload.output.execution_mode;
        pendingList.replaceChildren();
        for (const item of payload.pending_items || []) {
          const row = document.createElement("li");
          row.textContent = `${item.sku} 待补：${item.missing_fields.join("、")}`;
          pendingList.append(row);
        }
        pendingList.hidden = (payload.pending_items || []).length === 0;
        result.hidden = false;
        await loadRuns(taskId, sequence);
      } catch (error) {
        if (sequence !== requestSequence || select.value !== taskId) return;
        errorBox.textContent = error.message;
        errorBox.hidden = false;
      } finally {
        running = false;
        select.disabled = false;
        runButton.disabled = false;
      }
    });
  }
})();
