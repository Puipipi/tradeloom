(() => {
  const businessUrl = globalThis.TradeLoomBusiness?.businessUrl || (value => value);
  const resultLabels = {
    recommended: "建议跟进",
    not_recommended: "暂不建议",
    insufficient_data: "数据不足",
  };
  const outcomeLabels = {
    order_placed: "观察期内下单",
    no_order: "观察期内未下单",
    censored: "观察不足",
  };

  function formatHitRate(value) {
    if (value === null || value === undefined || value === "") return "未知";
    const rate = Number(value);
    return Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : "未知";
  }

  function backtestSummaryText(summary) {
    return `评估 ${summary.evaluation_count} 次 · 建议 ${summary.recommended_count} 次 · `
      + `可判定建议 ${summary.resolved_recommendation_count} 次 · 命中率 ${formatHitRate(summary.hit_rate)} · `
      + `观察不足 ${summary.censored_count} 次`;
  }

  async function request(url, body) {
    const response = await fetch(businessUrl(url), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": document.querySelector('meta[name="csrf-token"]')?.content || "",
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      const failure = new Error(payload.error_code || `HTTP ${response.status}`);
      failure.code = payload.error_code || "http_error";
      failure.status = response.status;
      throw failure;
    }
    return payload;
  }

  function showError(error) {
    const element = document.getElementById("customer-page-error");
    if (!element) return;
    element.textContent = `操作未完成：${error.code || error.message || "网络错误"}`;
    element.hidden = false;
  }

  function clearError() {
    const element = document.getElementById("customer-page-error");
    if (element) element.hidden = true;
  }

  async function submitCustomerChangeAndReload(button, send) {
    button.disabled = true;
    try {
      await send();
      globalThis.location.reload();
    } catch (error) {
      showError(error);
      button.disabled = false;
    }
  }

  function renderBacktest(backtest) {
    const container = document.getElementById("backtest-result");
    const rows = document.getElementById("backtest-rows");
    if (!container || !rows) return;
    document.getElementById("backtest-summary").textContent = backtestSummaryText(backtest.summary);
    rows.replaceChildren();
    for (const row of backtest.rows) {
      const tr = document.createElement("tr");
      tr.dataset.testid = `backtest-${row.as_of}`;
      const values = [
        row.as_of,
        resultLabels[row.result] || row.result,
        String(row.order_count),
        `${row.silence_days ?? "—"} / ${row.threshold_days ?? "—"}`,
        outcomeLabels[row.outcome] || row.outcome,
      ];
      for (const value of values) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      }
      rows.appendChild(tr);
    }
    container.hidden = false;
  }

  function bindCandidateEvent() {
    for (const form of document.querySelectorAll(".candidate-event-form")) {
      form.addEventListener("submit", async event => {
        event.preventDefault();
        clearError();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          const payload = await request("/api/customer-events/from-candidate", {
            candidate_id: form.dataset.candidateId,
            event_type: form.elements.event_type.value,
            occurred_on: form.elements.occurred_on.value,
          });
          if (payload.status === "recorded") {
            globalThis.location.assign(businessUrl(`/customers/${payload.event.customer_id}`));
          } else {
            globalThis.location.reload();
          }
        } catch (error) {
          showError(error);
          button.disabled = false;
        }
      });
    }
  }

  function bindAliasDecisions() {
    for (const form of document.querySelectorAll(".alias-decision-form")) {
      for (const button of form.querySelectorAll(".alias-decision")) {
        button.addEventListener("click", async () => {
          clearError();
          const decision = button.dataset.decision;
          const body = { decision };
          if (decision === "confirm" && button.dataset.mode === "existing") {
            const customerId = form.elements.customer_id.value;
            if (!customerId) {
              showError(new Error("customer_required"));
              return;
            }
            body.customer_id = customerId;
          } else if (decision === "confirm") {
            const displayName = form.elements.display_name.value.trim();
            if (!displayName) {
              showError(new Error("display_name_required"));
              return;
            }
            body.display_name = displayName;
          }
          await submitCustomerChangeAndReload(button, () =>
            request(`/api/customer-aliases/${form.dataset.aliasId}/decision`, body));
        });
      }
    }
  }

  function bindAsOfCustomerChangeForm(id, urlFor) {
    const form = document.getElementById(id);
    if (!form) return;
    form.addEventListener("submit", async event => {
      event.preventDefault();
      clearError();
      const button = form.querySelector('button[type="submit"]');
      await submitCustomerChangeAndReload(button, () =>
        request(urlFor(form), { as_of: form.elements.as_of.value }));
    });
  }

  function bindCustomerActionDecisions() {
    for (const form of document.querySelectorAll(".customer-action-form")) {
      for (const button of form.querySelectorAll(".customer-action-decision")) {
        button.addEventListener("click", async () => {
          clearError();
          await submitCustomerChangeAndReload(button, () =>
            request(`/api/customer-actions/${form.dataset.actionId}/decision`, {
              decision: button.dataset.decision,
              note: form.elements.note.value,
            }));
        });
      }
    }
  }

  function bindBacktest() {
    const form = document.getElementById("customer-backtest-form");
    if (!form) return;
    form.addEventListener("submit", async event => {
      event.preventDefault();
      clearError();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const payload = await request(`/api/customers/${form.dataset.customerId}/backtest`, {
          start: form.elements.start.value,
          end: form.elements.end.value,
          step_days: Number(form.elements.step_days.value),
        });
        renderBacktest(payload.backtest);
      } catch (error) {
        showError(error);
      } finally {
        button.disabled = false;
      }
    });
  }

  function bindIdentityOperations() {
    for (const form of document.querySelectorAll(".identity-operation-form")) {
      form.addEventListener("submit", async event => {
        event.preventDefault();
        clearError();
        const button = form.querySelector('button[type="submit"]');
        const body = {};
        for (const name of ["customer_id", "source_customer_id", "note"]) {
          if (form.elements[name]) body[name] = form.elements[name].value;
        }
        await submitCustomerChangeAndReload(button, () => request(form.dataset.url, body));
      });
    }
  }

  globalThis.TradeLoomCustomers = {
    backtestSummaryText,
    formatHitRate,
    renderBacktest,
  };

  if (typeof document !== "undefined") {
    bindCandidateEvent();
    bindAliasDecisions();
    bindAsOfCustomerChangeForm("customer-evaluation-form", form => `/api/customers/${form.dataset.customerId}/evaluate`);
    bindAsOfCustomerChangeForm("customer-reconcile-form", form => `/api/customers/${form.dataset.customerId}/reconcile`);
    bindCustomerActionDecisions();
    bindBacktest();
    bindIdentityOperations();
  }
})();
