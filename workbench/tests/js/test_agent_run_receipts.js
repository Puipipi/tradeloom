const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "../../static/workbench/agent-run-receipts.js"),
  "utf8",
);
const storageKey = "tradeloom.agent-runs.pending.v1";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function loadReceipts() {
  const context = { sessionStorage: undefined };
  vm.runInNewContext(source, context);
  return context.AgentRunReceipts;
}

async function main() {
  const storage = new MemoryStorage();
  let keySequence = 0;
  const createKey = () => `key-${++keySequence}`;
  const firstPage = loadReceipts();
  let firstSentKey;
  await assert.rejects(
    firstPage.dispatch(storage, "task-a", "product_profile", createKey, async (key) => {
      firstSentKey = key;
      throw new TypeError("connection lost after request");
    }),
  );
  assert.equal(firstSentKey, "key-1");
  assert.ok(storage.getItem(storageKey));

  const reloadedPage = loadReceipts();
  let replayedKey;
  const running = await reloadedPage.dispatch(
    storage,
    "task-a",
    "product_profile",
    createKey,
    async (key) => {
      replayedKey = key;
      return { run_id: "run-active", status: "running" };
    },
  );
  assert.equal(replayedKey, firstSentKey);
  assert.equal(running.status, "running");

  for (const malformed of [
    {},
    "<html>old server</html>",
    { run_id: "run-unknown", status: "queued" },
  ]) {
    await assert.rejects(
      reloadedPage.dispatch(storage, "task-a", "product_profile", createKey, async () => malformed),
    );
    assert.equal(
      reloadedPage.ensure(storage, "task-a", "product_profile", createKey),
      firstSentKey,
    );
  }

  const otherCapabilityKey = reloadedPage.ensure(
    storage,
    "task-a",
    "quotation",
    createKey,
  );
  assert.equal(otherCapabilityKey, "key-2");
  const missingOnOldServer = Object.assign(new Error("HTTP 404"), { status: 404 });
  await assert.rejects(
    reloadedPage.dispatch(storage, "task-a", "product_profile", createKey, async () => {
      throw missingOnOldServer;
    }),
  );
  assert.equal(
    reloadedPage.ensure(storage, "task-a", "product_profile", createKey),
    firstSentKey,
  );

  const unknownServerFailure = Object.assign(new Error("HTTP 500"), {
    status: 500,
    terminal: false,
  });
  await assert.rejects(
    reloadedPage.dispatch(storage, "task-a", "product_profile", createKey, async () => {
      throw unknownServerFailure;
    }),
  );
  assert.equal(
    reloadedPage.ensure(storage, "task-a", "product_profile", createKey),
    firstSentKey,
  );

  const terminalServerFailure = Object.assign(new Error("Agent run failed"), {
    status: 500,
    terminal: true,
  });
  await assert.rejects(
    reloadedPage.dispatch(storage, "task-a", "product_profile", createKey, async () => {
      throw terminalServerFailure;
    }),
  );
  assert.equal(
    reloadedPage.ensure(storage, "task-a", "product_profile", createKey),
    "key-3",
  );

  await reloadedPage.dispatch(
    storage,
    "task-a",
    "product_profile",
    createKey,
    async (key) => ({
      run_id: key,
      status: "needs_confirmation",
      output: { product_count: 1, pending_count: 1, execution_mode: "local_demo" },
      pending_items: [],
      artifact_refs: [],
    }),
  );
  assert.equal(
    reloadedPage.ensure(storage, "task-a", "product_profile", createKey),
    "key-4",
  );
  assert.equal(
    reloadedPage.ensure(storage, "task-a", "quotation", createKey),
    otherCapabilityKey,
  );

  const blockedStorage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota exceeded"); },
    removeItem() {},
  };
  let sent = false;
  await assert.rejects(
    reloadedPage.dispatch(blockedStorage, "task-b", "product_profile", createKey, async () => {
      sent = true;
      return { status: "succeeded" };
    }),
  );
  assert.equal(sent, false);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
