// Compile the pinned upstream sources and their generated Host/Client faces.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [source, prefix, tools, output] = process.argv.slice(2).map(value => path.resolve(value));
assert(source && prefix && tools && output, 'source, prefix, tools and output directories are required');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db');
const require = createRequire(path.join(tools, 'package.json'));
const ts = (await import(pathToFileURL(require.resolve('typescript')))).default;
const { build } = await import(pathToFileURL(require.resolve('tsdown')));
const { WorkspaceTypertGenerator, writePackageArtifacts } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-generator')));
const { decoratorPlugin } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-generator/tsdown')));
const paths = ['packages/llm/llm/src/types.ts', 'packages/llm/llm/src/index.ts', 'packages/llm/llm-pi-ai/src/discovery.ts'];
const saved = paths.map(file => fs.readFileSync(path.join(source, file)));
const options = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
  rewriteRelativeImportExtensions: true, sourceMap: true, verbatimModuleSyntax: false };

function declaration(input, target) {
  const result = ts.transpileDeclaration(fs.readFileSync(input, 'utf8'), {
    fileName: input, compilerOptions: { ...options, declarationMap: true },
  });
  assert.equal(result.diagnostics?.length ?? 0, 0, `declaration diagnostics: ${input}`);
  fs.writeFileSync(target, result.outputText);
}

async function bundle(pkg) {
  for (const file of fs.readdirSync(path.join(pkg, 'src'), { recursive: true })) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const input = path.join(pkg, 'src', file);
    const target = path.join(pkg, 'lib/types', file.replace(/\.ts$/, '.js'));
    const result = ts.transpileModule(fs.readFileSync(input, 'utf8'), { fileName: input, compilerOptions: options });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, result.outputText);
    if (result.sourceMapText) fs.writeFileSync(target + '.map', result.sourceMapText);
  }
  // The upstream root tsdown.config.ts Host preset, restricted to this package.
  await build({ cwd: pkg, config: false, entry: ['lib/types/index.js'], outDir: 'lib',
    format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false,
    dts: false, clean: false, plugins: [decoratorPlugin()] });
}

async function browser(out) {
  const installed = path.join(prefix, 'node_modules/@deepseek-ai/dsh-api-remotes');
  const pkg = path.join(source, 'packages/api/remotes');
  fs.cpSync(path.join(installed, 'lib/types'), path.join(pkg, 'lib/types'), { recursive: true });
  const input = fs.readFileSync(path.join(pkg, 'lib/types/client/index.js'), 'utf8');
  const alias = {};
  for (const [, specifier] of input.matchAll(/from '(@deepseek-ai\/[^']+\/remote)'/g)) {
    const name = specifier.slice(0, -'/remote'.length);
    const base = path.join(prefix, 'node_modules', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    const exported = manifest.exports['./remote'];
    const relative = typeof exported === 'string' ? exported : exported.default;
    const target = path.join(source, manifest.repository.directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(name === '@deepseek-ai/dsh-llm'
      ? path.join(out, 'typert.remote-client.js') : path.join(base, relative), target);
    alias[specifier] = target;
  }
  const protocol = 'node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/remote-info.js';
  const target = path.join(source, 'packages/typert/protocol/lib/types/remote-info.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(prefix, protocol), target);
  alias['@deepseek-ai/dsh-typert-protocol/remote-info'] = target;
  const preset = (await import(pathToFileURL(path.join(pkg, 'tsdown.config.ts')))).default;
  const [config] = preset({ env: { DSH_BUILD_FACE: 'client' } });
  await build({ ...config, cwd: pkg, config: false,
    inputOptions: { ...config.inputOptions, resolve: { ...config.inputOptions.resolve, alias } } });
  fs.copyFileSync(path.join(pkg, 'lib/client.js'), path.join(out, 'remotes-client.js'));
}

try {
  for (const mode of ['pristine', 'candidate']) {
    paths.forEach((file, index) => fs.writeFileSync(path.join(source, file), mode === 'pristine'
      ? execFileSync('git', ['show', 'HEAD:' + file], { cwd: source }) : saved[index]));
    const out = path.join(output, mode);
    fs.mkdirSync(out, { recursive: true });
    const llm = path.join(source, 'packages/llm/llm');
    // Same source-only generator options as upstream scripts/generate-typert.ts.
    const artifacts = new WorkspaceTypertGenerator(source, { checkDiagnostics: false, rejectBuildOutputs: true })
      .generate(['@deepseek-ai/dsh-llm'], ['host']);
    writePackageArtifacts(llm, artifacts);
    for (const file of ['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts']) {
      fs.copyFileSync(path.join(llm, 'lib', file), path.join(out, file));
    }
    declaration(path.join(llm, 'src/types.ts'), path.join(out, 'types.d.ts'));
    declaration(path.join(llm, 'src/index.ts'), path.join(out, 'llm-index.d.ts'));
    await bundle(llm);
    fs.copyFileSync(path.join(llm, 'lib/index.js'), path.join(out, 'llm-index.js'));
    fs.copyFileSync(path.join(llm, 'lib/types/index.js'), path.join(out, 'llm-types-index.js'));
    const piai = path.join(source, 'packages/llm/llm-pi-ai');
    await bundle(piai);
    fs.copyFileSync(path.join(piai, 'lib/index.js'), path.join(out, 'piai-index.js'));
    await browser(out);
  }
} finally {
  paths.forEach((file, index) => fs.writeFileSync(path.join(source, file), saved[index]));
}
