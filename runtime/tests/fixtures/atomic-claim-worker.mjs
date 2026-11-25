import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const [mode, filename] = process.argv.slice(2);
if (mode === 'fail-claim') process.on('SIGXFSZ', () => {});
// A message listener references the child IPC channel while the explicit gate
// is held; an unresolved Promise alone does not keep Node running.
if (mode === 'hold-main' || mode === 'hold-claim') process.on('message', () => {});

// Pause only after a real exclusive claim write succeeds. Both entry points
// delegate the real filesystem operation before reporting the gate.
if (mode === 'hold-claim') {
  const pause = async path => {
    if (!String(path).includes('.takeover-')) return;
    process.send({ type: 'claim-held' });
    await new Promise(() => {});
  };
  const originalWrite = fs.writeFile;
  fs.writeFile = async (...args) => {
    const value = await originalWrite(...args);
    await pause(args[0]);
    return value;
  };
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes('.takeover-')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => {
        const value = await write(...values);
        await pause(args[0]);
        return value;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
}

const { withFileLock } = await import(pathToFileURL(join(resolve(process.env.DSH_PREFIX),
  'node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js')));

if (mode === 'hold-main' || mode === 'hold-claim') {
  await withFileLock(filename, async () => {
    process.send({ type: 'main-held' });
    await new Promise(() => {});
  }, { waitMs: 0 });
} else {
  const result = { operations: 0 };
  try {
    await withFileLock(filename, () => { result.operations++; }, { waitMs: 0 });
  } catch (error) {
    result.error = { code: error.code, message: error.message };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
