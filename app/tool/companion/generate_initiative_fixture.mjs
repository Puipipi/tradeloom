// Re-run the unchanged C213 reference, then keep its full transition results.
// Usage: node tool/companion/generate_initiative_fixture.mjs /path/to/initiative-c212
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const reference = path.resolve(process.argv[2]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-initiative-'));
try {
  const resultPath = path.join(temp, 'reference-results.json');
  const run = spawnSync(process.execPath, [path.join(reference, 'cases.mjs'), resultPath], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout || 'C213 reference failed');
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (result.status !== 'PASS_SCOPED_REFERENCE') throw new Error('C213 reference cases did not pass');
  const fixture = {
    schema: 'c451/c212-oracle-v1',
    scope: 'Synthetic reference transitions; no App, device, persistence driver, model or audio execution.',
    sourceHashes: result.sourceHashes,
    constants: result.constants,
    referenceCounts: result.counts,
    cases: result.cases.map(({ name, traces, violatedPremiseExample }) => ({
      name, traces, ...(violatedPremiseExample ? { violatedPremiseExample } : {}),
    })),
  };
  const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/companion_initiative_c212.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(fixture, null, 2) + '\n');
  console.log(JSON.stringify({ output, referenceCounts: result.counts, sourceHashes: result.sourceHashes }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
