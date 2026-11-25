import {appendFileSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PluginManager} from '@deepseek-ai/dsh-plugin-manager';

export const name = 'active-run-guard-observer';
export const inject = ['pluginManager'];

export function apply(ctx) {
  const root = process.env.FIXTURE_CONTROL_ROOT;
  const generation = process.env.FIXTURE_GENERATION;
  const modulePath = realpathSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-plugin-manager')));
  const moduleSha256 = createHash('sha256').update(readFileSync(modulePath)).digest('hex');
  const change = PluginManager.prototype.change;
  const proof = {
    pid: process.pid, generation, modulePath, moduleSha256,
    matchesExpectedHash: moduleSha256 === process.env.FIXTURE_EXPECTED_MANAGER_SHA256,
    runtimeInstanceOfImportedClass: ctx.pluginManager instanceof PluginManager,
    runtimeMethodIsImportedMethod: ctx.pluginManager.change === change,
    changeHasEarlyGuard: change.toString().includes('await activeRecordedRun(this.profile.dir)'),
  };
  writeFileSync(join(root, 'loaded-module-' + generation + '.json'), JSON.stringify(proof) + '\n');
  if (!proof.matchesExpectedHash || !proof.runtimeInstanceOfImportedClass || !proof.changeHasEarlyGuard) {
    throw new Error('active-run guard fixture did not load the expected real service class');
  }
  ctx.on('plugin-manager/install-state', state => {
    appendFileSync(join(root, 'install-events.jsonl'), JSON.stringify({pid: process.pid, generation, state}) + '\n');
  });
}
