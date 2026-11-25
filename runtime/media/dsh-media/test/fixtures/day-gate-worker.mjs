// Independent contender: forward real filesystem calls and report an actual
// writer-lock EEXIST. The parent advances only this injected ledger clock.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [directory, encoded, initial] = process.argv.slice(2);
const record = JSON.parse(encoded);
let clock = Number(initial);
let reported = false;
// Both lock implementations delegate real exclusive opens; observe either API.
for (const method of ['open', 'writeFile']) {
  const original = fs[method];
  fs[method] = async (...args) => {
    try { return await original(...args); }
    catch (error) {
      if (!reported && args[0] === join(directory, 'ledger-v1.json.lock')
        && error?.code === 'EEXIST') {
        reported = true;
        process.send({ type: 'blocked' });
      }
      throw error;
    }
  };
}
syncBuiltinESMExports();
process.on('message', value => {
  if (value?.type === 'clock') {
    clock = value.value;
    process.send({ type: 'advanced' });
  }
});
const { createBudgetLedger } = await import('../../src/budget-ledger.js');
try {
  const result = await createBudgetLedger(directory, { clock: () => clock })
    .beginSubmission(record.rid, record.identity);
  process.send({ type: 'outcome', started: result.started }, () => process.disconnect());
} catch (error) {
  process.send({ type: 'outcome', code: error.code }, () => process.disconnect());
}
