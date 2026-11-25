// Versioned runtime-owned preload. Configuration contains paths/argv only;
// credentials and caller environments never get written into it.
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPaths } from './paths.mjs';
import { installLookup } from './dns.mjs';
import { installCommands } from './processes.mjs';
import { installModules } from './modules.mjs';

const rootfs = fileURLToPath(import.meta.url).replace(/\/opt\/dsh-go\/direct\/preload\.mjs$/u, '');
try {
  if (rootfs === fileURLToPath(import.meta.url)) throw new Error('preload is outside its runtime path');
  const config = JSON.parse(fs.readFileSync(`${rootfs}/opt/dsh-app/direct/config.json`, 'utf8'));
  if (config.schema !== 2 || config.rootfs !== rootfs) throw new Error('direct launch configuration does not match this rootfs');
  const paths = createPaths(rootfs, config.mounts);
  // Existing PRoot fake hard links require PRoot's filesystem semantics. The
  // Android planner falls back before launch; this closes the preparation race
  // and also protects child node launches after a guest command creates one.
  const backing = `${rootfs}/root/.l2s`;
  let backingInfo;
  try { backingInfo = fs.lstatSync(backing); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (backingInfo) {
    if (!backingInfo.isDirectory()) throw new Error('this runtime needs compatible launch; turn off Direct engine');
    const directory = fs.opendirSync(backing);
    try {
      if (directory.readSync() !== null) throw new Error('this runtime needs compatible launch; turn off Direct engine');
    } finally { directory.closeSync(); }
  }
  const processes = installCommands(config, paths);
  const adapter = Object.freeze({ ...paths, ...processes });
  globalThis[Symbol.for('dsh.go.direct')] = adapter;
  const nativeModules = JSON.parse(fs.readFileSync(`${rootfs}/opt/dsh-go/direct/native-addons.json`, 'utf8'));
  installModules(paths, nativeModules);
  installLookup({ resolvConf: `${rootfs}/etc/resolv.conf`, hostsFile: `${rootfs}/etc/hosts` });
  // pnpm 11's exact environment spelling is covered by the locked-source test.
  process.env.pnpm_config_package_import_method = 'copy';
  process.env.npm_config_package_import_method = 'copy';
  const main = process.env.DSH_GO_DIRECT_MAIN === '1';
  delete process.env.DSH_GO_DIRECT_MAIN;
  if (main) fs.writeFileSync(`${rootfs}/tmp/dsh-web.pid`, `${process.pid}\n`, { mode: 0o600 });
  // Same hook point as the proot shim; the cache's physical-root support belongs
  // to the independent cache follow-up. Do not claim cache hits from this import.
  if (main) await import(pathToFileURL(`${rootfs}/opt/dsh-go/boot-cache.mjs`).href);
} catch (error) {
  console.error(`[dsh-app-direct] launch failed: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
}
