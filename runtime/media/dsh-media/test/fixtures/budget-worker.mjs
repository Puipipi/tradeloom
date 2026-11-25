import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBudgetLedger } from '../../src/budget-ledger.js';

const [mode, directory, payload] = process.argv.slice(2);
const input = JSON.parse(payload);
const ledger = createBudgetLedger(directory, {
  clock: () => Date.parse('2026-10-28T12:00:00Z'),
  checkpoint: async point => {
    if (mode === 'hold-intent' && point === 'intent:durable') {
      console.log(JSON.stringify({ checkpoint: point }));
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
  },
});
try {
  let result;
  if (mode === 'reserve') result = await ledger.reserve(input);
  else if (['begin', 'hold-intent'].includes(mode)) {
    result = await ledger.beginSubmission(input.rid, input.identity);
    if (result.started) await writeFile(join(directory, `transport-gate-${process.pid}`), '1', { flag: 'wx' });
  } else throw new Error('unknown test mode');
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code }));
  process.exitCode = 2;
}
