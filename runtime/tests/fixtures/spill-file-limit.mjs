import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir, stat } from 'node:fs/promises';

// The parent sets a real Linux file-size limit only for this child. Keep
// stdout as a pipe, and let the actual kernel EFBIG reach normal cleanup.
process.on('SIGXFSZ', () => {});
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { Context } = await import(pathToFileURL(join(base, 'cordis/lib/index.js')));
const { LocalSpillStore, sessionDir } = await import(pathToFileURL(join(base, 'dsh-spill-local/lib/index.js')));
const root = process.argv[2], size = Number(process.argv[3]);
const ctx = new Context(), result = {};
await ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 });
try {
  result.saved = await ctx.spillStore.saveText({
    owner: { sessionId: 'fixture-session' },
    source: { kind: 'tool', toolName: 'fixture', callId: 'limited', label: 'result' },
    suggestedName: 'limited.txt', content: 'x'.repeat(size),
  });
} catch (error) {
  result.error = { code: error.code, message: error.message };
} finally {
  await ctx.fiber.dispose();
}
const dir = sessionDir(root, 'fixture-session');
result.files = await Promise.all((await readdir(dir)).map(async name => ({ name, size: (await stat(join(dir, name))).size })));
process.stdout.write(`${JSON.stringify(result)}\n`);
