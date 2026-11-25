// Separate-process probes. Built-in wrappers forward real filesystem calls;
// only the explicit failure mode substitutes a sync error.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
const [mode, directory, encoded] = process.argv.slice(2);
const input = JSON.parse(encoded);
const synced = [];
if (mode === 'hold-mkdir') {
  const mkdir = fs.mkdir;
  fs.mkdir = async (...args) => {
    const first = await mkdir(...args);
    if (args[0] === directory && first) {
      process.stdout.write(JSON.stringify({ checkpoint: 'mkdir-returned', first }) + '\n');
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
    return first;
  };
} else {
  const open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (mode === 'deny-ancestor-sync' && args[0] === dirname(directory)) {
        const error = new Error('synthetic ancestor sync unavailable');
        error.code = 'EIO';
        throw error;
      }
      await sync();
      synced.push(String(args[0]));
    };
    return handle;
  };
}
syncBuiltinESMExports();
const { createBudgetLedger } = await import('../../src/budget-ledger.js');
try {
  const ledger = createBudgetLedger(directory);
  const reserved = await ledger.reserve(input);
  const gate = await ledger.beginSubmission(reserved.record.rid, reserved.record.identity);
  console.log(JSON.stringify({ started: gate.started, synced }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, synced }));
  process.exitCode = 2;
}
