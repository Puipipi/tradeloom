import { readFile, writeFile, unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(shellRoot, 'vendor', 'dockview-entry.ts')
const temporaryBundle = join(shellRoot, '.client.dockview.tmp.cjs')
const output = join(shellRoot, 'client.dockview.js')

function option(name) {
  const prefix = `--${name}=`
  const value = process.argv.slice(2).find(argument => argument.startsWith(prefix))
  if (!value) throw new Error(`Missing ${prefix}<path>`)
  return resolve(value.slice(prefix.length))
}

const nodeModules = option('node-modules')
const esbuild = option('esbuild')
const dependencyLock = JSON.parse(await readFile(join(shellRoot, 'vendor', 'dockview-package-lock.json'), 'utf8'))
for (const [name, expectedVersion] of Object.entries({
  'dockview-react': '8.6.0',
  dockview: '8.6.1',
  'dockview-core': '8.6.1',
})) {
  const lockedVersion = dependencyLock.packages[`node_modules/${name}`]?.version
  const installed = JSON.parse(await readFile(join(nodeModules, name, 'package.json'), 'utf8'))
  if (lockedVersion !== expectedVersion || installed.version !== expectedVersion) {
    throw new Error(`Expected ${name} ${expectedVersion}; lock=${lockedVersion ?? 'missing'}, installed=${installed.version}`)
  }
}

const version = spawnSync(process.execPath, [esbuild, '--version'], { encoding: 'utf8' })
if (version.status !== 0 || version.stdout.trim() !== '0.25.12') {
  throw new Error(`Expected esbuild 0.25.12; received ${version.stdout.trim() || version.stderr.trim()}`)
}

const build = spawnSync(process.execPath, [
  esbuild, source,
  '--bundle', '--format=cjs', '--platform=browser',
  '--external:react', '--external:react-dom', '--external:react-dom/client', '--external:react/jsx-runtime',
  '--loader:.css=text', `--outfile=${temporaryBundle}`,
], { cwd: shellRoot, encoding: 'utf8', env: { ...process.env, NODE_PATH: nodeModules } })
if (build.status !== 0) {
  if (build.stdout) process.stderr.write(build.stdout)
  if (build.stderr) process.stderr.write(build.stderr)
  process.exit(build.status ?? 1)
}

try {
  const body = await readFile(temporaryBundle, 'utf8')
  const wrapped = `window.__ModuleLoader__.load({\n  id: '@tradeloom/dsh-business-shell',\n  chunk: 'client.dockview.js',\n  factory(require) {\n    var module = { exports: {} };\n    var exports = module.exports;\n${body}\n    return module.exports;\n  }\n});\n`
  await writeFile(output, wrapped, 'utf8')
} finally {
  await unlink(temporaryBundle).catch(error => { if (error.code !== 'ENOENT') throw error })
}
process.stdout.write(`built ${output}\n`)
