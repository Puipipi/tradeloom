import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect, filename } from './core.mjs';
export async function checkDirectory(directory = 'plugins', options = {}) {
  const rows = [];
  const names = new Set();
  for (const file of (await readdir(directory)).filter((f) => f.endsWith('.json')).sort()) {
    const entry = JSON.parse(await readFile(resolve(directory, file), 'utf8'));
    const report = await inspect(entry, options);
    if (file !== filename(entry.name ?? '')) report.denials.push('filename-mismatch');
    if (names.has(entry.name)) report.denials.push('duplicate-package');
    names.add(entry.name);
    report.status = report.denials.length ? 'denied' : 'passed';
    rows.push({ entry, report });
  }
  return rows;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const rows = await checkDirectory(process.argv[2] ?? 'plugins');
    await mkdir('reports', { recursive: true });
    for (const { entry, report } of rows)
      await writeFile(resolve('reports', basename(filename(entry.name))), JSON.stringify(report, null, 2) + '\n');
    console.log(
      JSON.stringify(
        { passed: rows.every((r) => r.report.status === 'passed'), results: rows.map((r) => r.report) },
        null,
        2,
      ),
    );
    if (rows.some((r) => r.report.status !== 'passed')) process.exitCode = 1;
  } catch (e) {
    console.error(JSON.stringify({ passed: false, error: e.message }));
    process.exitCode = 1;
  }
}
