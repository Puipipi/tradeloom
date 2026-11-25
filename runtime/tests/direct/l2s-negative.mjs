// Captures the pinned PRoot/native identity difference without mutating data.
import fs from 'node:fs/promises';
import { Context } from '/opt/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { LocalFileSystem } from '/opt/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js';
import { SandboxedFileSystem } from '/opt/dsh/node_modules/@deepseek-ai/dsh-fs-sandbox/lib/index.js';

const file = process.argv[2];
const provider = new LocalFileSystem(new Context(), { cwd: '/root/workspace', diffBasisMaxBytes: 1024 * 1024 });
const target = await provider.resolve(file);
const nativeFile = globalThis[Symbol.for('dsh.go.direct')]?.toHost(file) ?? file;
const result = { file, target, nativeRealpath: await fs.realpath(nativeFile),
  nativeIsSymbolicLink: (await fs.lstat(nativeFile)).isSymbolicLink(),
  content: await provider.readText(target) };
try {
  result.checked = await SandboxedFileSystem.prototype.checkedTarget.call({ resolve: (path) => provider.resolve(path) },
    target, { mode: 'workspace-write', workspaceRoot: '/root/workspace' });
} catch (error) { result.denied = { code: error.code, message: error.message }; }
console.log(JSON.stringify(result));
