const fs = require('node:fs');
const ts = require(process.env.TRADELOOM_TS);
const root = process.env.TRADELOOM_CANDIDATE;
for (const name of ['ipc', 'ai-web-diagnostics', 'browser-guests']) {
  const source = fs.readFileSync(`${root}/apps/desktop/src/${name}.ts`, 'utf8');
  let output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  if (output.diagnostics?.length) throw new Error(JSON.stringify(output.diagnostics));
  fs.writeFileSync(`${root}/${name}.cjs`, output.outputText.replaceAll('./ipc.ts', './ipc.cjs').replaceAll('./ai-web-diagnostics.ts', './ai-web-diagnostics.cjs'));
}
