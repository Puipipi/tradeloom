// Maintainer-only refresh: read public npm bytes, never run downloaded code.
import { writeFile, mkdir } from 'node:fs/promises';
import { metadata, request, boundedBody, verifyIntegrity, REGISTRY } from './core.mjs';
for (const [name, version] of [
  ['@liustack/modsearch', '5.10.11'],
  ['@liustack/modlens', '3.27.2'],
]) {
  const p = await metadata(name),
    v = p.versions[version],
    id = name.replace('@', '').replace('/', '-');
  const bytes = await boundedBody(await request(v.dist.tarball));
  if (!verifyIntegrity(bytes, v.dist.integrity)) throw new Error('integrity');
  const advisories = await (
    await request(REGISTRY + '-/npm/v1/security/advisories/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [name]: [version] }),
    })
  ).json();
  await mkdir('test/fixtures', { recursive: true });
  await writeFile(`test/fixtures/${id}.tgz`, bytes);
  await writeFile(
    `test/fixtures/${id}.json`,
    JSON.stringify(
      {
        source: v.dist.tarball,
        retrievedAt: new Date().toISOString(),
        integrity: v.dist.integrity,
        license: v.license,
        packument: { name, versions: { [version]: v }, time: { [version]: p.time[version] } },
        advisories,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`${name}@${version}: ${bytes.length} bytes`);
}
