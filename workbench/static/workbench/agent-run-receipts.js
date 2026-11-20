(() => {
  const storageKey = "tradeloom.agent-runs.pending.v1";

  function pendingReceiptScope(taskId, capabilityId) {
    return JSON.stringify([taskId, capabilityId]);
  }

  function readPendingReceipts(storage) {
    const raw = storage.getItem(storageKey);
    if (raw === null) return {};
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("无法读取运行回执，请清理本页会话存储后重试。");
    }
    return value;
  }

  function persistPendingReceipts(storage, pending) {
    const serialized = JSON.stringify(pending);
    storage.setItem(storageKey, serialized);
    if (storage.getItem(storageKey) !== serialized) {
      throw new Error("无法保存运行回执，本次请求未发送。");
    }
  }

  function ensure(storage, taskId, capabilityId, createKey) {
    const pending = readPendingReceipts(storage);
    const receiptScope = pendingReceiptScope(taskId, capabilityId);
    const existing = pending[receiptScope];
    if (typeof existing === "string" && existing.length > 0) return existing;
    const key = createKey();
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("无法生成运行回执，本次请求未发送。");
    }
    pending[receiptScope] = key;
    persistPendingReceipts(storage, pending);
    return key;
  }

  function clear(storage, taskId, capabilityId, key) {
    const pending = readPendingReceipts(storage);
    const receiptScope = pendingReceiptScope(taskId, capabilityId);
    if (pending[receiptScope] !== key) return;
    delete pending[receiptScope];
    if (Object.keys(pending).length === 0) storage.removeItem(storageKey);
    else persistPendingReceipts(storage, pending);
  }

  function validateReceipt(result) {
    if (!result || Array.isArray(result) || typeof result !== "object") {
      throw new Error("运行回执格式未知；已保留原回执，请重试。");
    }
    if (typeof result.run_id !== "string" || result.run_id.length === 0) {
      throw new Error("运行回执缺少运行编号；已保留原回执，请重试。");
    }
    if (result.status === "running") return;
    if (
      (result.status === "needs_confirmation" || result.status === "succeeded")
      && result.output
      && !Array.isArray(result.output)
      && typeof result.output === "object"
      && typeof result.output.product_count === "number"
      && typeof result.output.pending_count === "number"
      && typeof result.output.execution_mode === "string"
      && Array.isArray(result.pending_items)
      && Array.isArray(result.artifact_refs)
    ) {
      return;
    }
    throw new Error("运行结果状态或内容未知；已保留原回执，请重试。");
  }

  async function dispatch(storage, taskId, capabilityId, createKey, send) {
    const key = ensure(storage, taskId, capabilityId, createKey);
    try {
      const result = await send(key);
      validateReceipt(result);
      if (result.status !== "running") clear(storage, taskId, capabilityId, key);
      return result;
    } catch (error) {
      if (error?.terminal === true) clear(storage, taskId, capabilityId, key);
      throw error;
    }
  }

  globalThis.AgentRunReceipts = { dispatch, ensure, clear };
})();
