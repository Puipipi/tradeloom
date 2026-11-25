// The Dart constant is the authoring source; keep the host's instructions exact.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(path.join(root, 'app/lib/companion/companion_adapt_contract.dart'), 'utf8');
const match = source.match(/const companionAdaptSystem = '''\r?\n([\s\S]*?)''';/);
if (!match || match[1].includes('$') || match[1].includes('\\')) {
  throw new Error('Expected one literal companionAdaptSystem; update the extractor if the Dart syntax changes');
}
const target = path.join(root, 'app/assets/skills/companion-adapt/contract.txt');
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== match[1]) throw new Error('companion-adapt prompt is stale');
  console.log('companion-adapt prompt matches the Dart constant');
} else {
  await writeFile(target, match[1], 'utf8');
  console.log('Updated companion-adapt/contract.txt');
}
