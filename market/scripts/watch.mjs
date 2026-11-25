import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { metadata, inspect, filename } from './core.mjs';
export function newer(entry, packument) {
  const version = packument['dist-tags']?.latest;
  return semver.valid(version) === version && semver.gt(version, entry.version) ? { ...entry, version } : null;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const updates = [];
  for (const file of (await readdir('plugins')).filter((f) => f.endsWith('.json')).sort()) {
    const entry = JSON.parse(await readFile('plugins/' + file, 'utf8'));
    const packument = await metadata(entry.name);
    const next = newer(entry, packument);
    if (!next) continue;
    const report = await inspect(next, { packument });
    if (report.status !== 'passed') {
      console.error(`${entry.name}@${next.version}: ${report.denials.join(', ')}`);
      continue;
    }
    updates.push({ path: 'plugins/' + filename(next.name), entry: next, from: entry.version, report });
  }
  await mkdir('reports', { recursive: true });
  await writeFile('reports/updates.json', JSON.stringify(updates, null, 2) + '\n');
  console.log(`${updates.length} checked upgrades`);
}
