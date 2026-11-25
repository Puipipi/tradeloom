import {realpathSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {PluginManager} from '@deepseek-ai/dsh-plugin-manager';
export const name = 'cancel-tree-confirmation-observer';
export const inject = ['pluginManager'];
export function apply(ctx) {
  const modulePath = realpathSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-plugin-manager')));
  const hash = createHash('sha256').update(readFileSync(modulePath)).digest('hex');
  const proof = {pid: process.pid, modulePath, sha256: hash,
    officialServiceInstance: ctx.pluginManager instanceof PluginManager};
  if (hash !== process.env.TREE_FIXTURE_MANAGER_SHA || !proof.officialServiceInstance) throw Error('Wrong actual manager service');
  if (process.env.TREE_FIXTURE_CASE === 'late-cancel') {
    const original = ctx.pluginManager.runPnpm.bind(ctx.pluginManager);
    ctx.pluginManager.runPnpm = async (...args) => {
      const result = await original(...args);
      writeFileSync(join(process.env.TREE_FIXTURE_CONTROL, 'run-result-held.json'), JSON.stringify({stage: 'actual runPnpm returned; outer install has not resumed', exitCode: result.exitCode}) + '\n');
      while (!existsSync(join(process.env.TREE_FIXTURE_CONTROL, 'release-run-result'))) await new Promise(resolve => setTimeout(resolve, 20));
      return result;
    };
    proof.scheduleSeam = 'hold result of actual runPnpm before outer continuation';
  }
  if (process.env.TREE_FIXTURE_CASE === 'stop-unconfirmed-emit') {
    const owner = ctx.pluginManager.ownerContext;
    const original = owner.emit.bind(owner);
    owner.emit = function(event, ...args) {
      if (event === 'plugin-manager/install-log' && args[0]?.text?.includes('cannot confirm that the package process tree stopped')) {
        writeFileSync(join(process.env.TREE_FIXTURE_CONTROL, 'emit-failure-injected.json'), JSON.stringify({event, at: performance.now()}) + '\n');
        throw new Error('Owned observer simulated install-log emission failure');
      }
      return original(event, ...args);
    };
    proof.errorSeam = 'throw from owner emit of stop-failure install-log only';
  }
  writeFileSync(join(process.env.TREE_FIXTURE_CONTROL, 'loaded-service.json'), JSON.stringify(proof) + '\n');
}
