import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {readFileSync, appendFileSync} from 'node:fs';
const prefix = process.env.TREE_FIXTURE_PREFIX;
const control = process.env.TREE_FIXTURE_CONTROL;
const originalKill = process.kill.bind(process);
const read = name => { try {return JSON.parse(readFileSync(join(control, name), 'utf8'));} catch {return undefined;} };
const stillSame = prior => {
  if (!prior) return false;
  try {const text = readFileSync('/proc/' + prior.pid + '/stat', 'utf8'); const f = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return Number(f[19]) === prior.startTicks && Number(f[2]) === prior.pgrp;
  } catch {return false;}
};
// Test-only fault injection. It never suppresses a signal to an unrecorded group.
// Both the service guard and Execa call process.kill for their own POSIX group.
process.kill = function(pid, signal) {
  const pair = ['', 'repair-'].map(role => ({role, parent: read(role + 'parent-ready.json'), child: read(role + 'descendant-ready.json')}))
    .find(({parent, child}) => pid < 0 && parent?.pid === -pid && parent.pgrp === -pid
      && (stillSame(parent) || child?.pgrp === -pid && stillSame(child)));
  const owned = pair !== undefined;
  if (owned && signal !== 0) {
    const mode = process.env.TREE_FIXTURE_CASE;
    const suppressed = (['stop-unconfirmed', 'stop-unconfirmed-emit', 'compat-primary-unconfirmed'].includes(mode)
      || mode === 'compat-repair-unconfirmed' && pair.role === 'repair-') && (signal === 'SIGKILL' || signal === 9);
    appendFileSync(join(control, 'signals.jsonl'), JSON.stringify({pid, signal, role: pair.role || 'primary', suppressed, at: performance.now()}) + '\n');
    if (suppressed) return true;
  }
  return originalKill(pid, signal);
};
const {runCli} = await import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js')));
process.argv = [process.execPath, join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--no-open', '--host', '127.0.0.1', '--port', process.env.TREE_FIXTURE_PORT];
await runCli({packageManager: {command: process.execPath, args: [process.env.TREE_FIXTURE_PM],
  env: {TREE_FIXTURE_CONTROL: control, TREE_FIXTURE_CASE: process.env.TREE_FIXTURE_CASE}}});
