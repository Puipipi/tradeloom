import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';

// The parent starts this child under a real Linux RLIMIT_FSIZE of zero.
// Catch the kernel signal so the actual write EFBIG can reach normal cleanup.
process.on('SIGXFSZ', () => {});
const { withFileLock } = await import(pathToFileURL(join(resolve(process.env.DSH_PREFIX),
  'node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js')));
const filename = process.argv[2];
const result = { operations: 0 };
try {
  await withFileLock(filename, () => { result.operations++; }, { waitMs: 0 });
} catch (error) {
  result.error = { code: error.code, message: error.message };
}
try {
  result.lock = { size: (await stat(`${filename}.lock`)).size, record: await readFile(`${filename}.lock`, 'utf8') };
} catch (error) {
  result.lockError = error.code;
}
process.stdout.write(`${JSON.stringify(result)}\n`);
