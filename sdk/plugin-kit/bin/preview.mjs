#!/usr/bin/env node
// Developer-only snapshots through the App's real PluginView renderer.
// No plugin JavaScript is loaded. Requires a prepared Flutter/App checkout.
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkView, checkViewText, exitCode, formatReport } from '../lib/check.js'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../app')
const usage = `node sdk/plugin-kit/bin/preview.mjs view.json --out NEW_DIRECTORY
  [--data data.json] [--budget toolCard|panel|strip] [--lang zh|en]
  [--width 320] [--height 960] [--scale 1.3] [--theme light|dark|both]
  [--flutter /path/to/flutter]
输出真实 Flutter 视口 PNG 和诊断；不连接主机、不执行插件动作、不更新 golden。
Renders native Flutter viewport PNGs and diagnostics; no host, plugin actions or golden updates.`

function jsonFile(path) {
  if (!statSync(path).isFile()) throw new Error(`Not a file: ${path}`)
  if (statSync(path).size > 1024 * 1024) throw new Error(`Input exceeds 1 MiB: ${path}`)
  const raw = readFileSync(path, 'utf8')
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new Error(`Input exceeds 1 MiB: ${path}`)
  return { raw, value: JSON.parse(raw) }
}

export function prepare(argv, cwd = process.cwd()) {
  const opts = { width: '390', height: '960', scale: '1', theme: 'both', lang: 'zh', flutter: 'flutter' }
  const names = new Set(['out', 'data', 'budget', 'width', 'height', 'scale', 'theme', 'lang', 'flutter'])
  let input
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (!names.has(key)) throw new Error(`Unknown option ${a}`)
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${a} requires a value`)
      opts[key] = value
    } else if (input === undefined) input = a
    else throw new Error(`Unexpected input ${a}`)
  }
  if (!input || !opts.out) throw new Error(usage)
  if (!['zh', 'en'].includes(opts.lang)) throw new Error('--lang must be zh or en')
  if (!['light', 'dark', 'both'].includes(opts.theme)) throw new Error('--theme must be light, dark or both')
  for (const [key, low, high] of [['width', 240, 800], ['height', 240, 2400], ['scale', 1, 2]]) {
    const n = Number(opts[key])
    if (!Number.isFinite(n) || n < low || n > high || (key !== 'scale' && !Number.isInteger(n))) throw new Error(`--${key} must be ${low}..${high}${key === 'scale' ? '' : ' (integer)'}`)
    opts[key] = n
  }
  const source = jsonFile(resolve(cwd, input))
  const object = source.value !== null && typeof source.value === 'object' && !Array.isArray(source.value)
  const wrapped = object && Object.hasOwn(source.value, 'dsh-go/view') && source.value.type === undefined
  const budget = opts.budget ?? (wrapped ? 'toolCard' : 'panel')
  if (!['toolCard', 'panel', 'strip'].includes(budget)) throw new Error('--budget must be toolCard, panel or strip')
  const view = wrapped ? source.value['dsh-go/view'] : source.value
  const data = opts.data ? jsonFile(resolve(cwd, opts.data)).value : null
  const report = checkViewText(source.raw, { budget, lang: opts.lang, target: input })
  // Tool cards have no data model. Panel/strip bindings use the supplied snapshot.
  if (budget !== 'toolCard') report.views = [{ where: input, ...checkView(view, { budget, lang: opts.lang, data }) }]
  const request = { view, data: budget === 'toolCard' ? null : data, budget, width: opts.width, height: opts.height, scale: opts.scale, themes: opts.theme === 'both' ? ['light', 'dark'] : [opts.theme], lang: opts.lang }
  return { opts, report, request, out: resolve(cwd, opts.out) }
}

// Windows cannot start flutter.bat (or the bare `flutter` on PATH, which is a .bat)
// without cmd.exe; anything ending in .exe still starts directly.
export function flutterCommand(flutter, args, platform = process.platform) {
  if (platform !== 'win32' || /\.exe$/i.test(flutter)) return { file: flutter, args, options: {} }
  const line = [flutter, ...args].map(a => `"${a}"`).join(' ')
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } }
}

export function main(argv, run = spawnSync) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { process.stdout.write(`${usage}\n`); return 0 }
  let job
  try { job = prepare(argv) } catch (error) { process.stderr.write(`${error.message}\n`); return 3 }
  process.stdout.write(`${formatReport(job.report, job.opts.lang)}\n`)
  const checked = exitCode(job.report)
  if (job.report.views.some(v => v.fatal)) return checked
  try {
    if (existsSync(job.out)) throw new Error(`Output directory already exists; choose a new one: ${job.out}`)
    mkdirSync(job.out, { recursive: true })
    writeFileSync(join(job.out, 'request.json'), JSON.stringify(job.request, null, 2) + '\n', { flag: 'wx' })
    writeFileSync(join(job.out, 'sdk-diagnostics.json'), JSON.stringify(job.report, null, 2) + '\n', { flag: 'wx' })
    const cmd = flutterCommand(job.opts.flutter, ['test', '--no-pub', 'test/plugins/view/local_preview_test.dart'])
    const result = run(cmd.file, cmd.args, {
      ...cmd.options, cwd: appDir, stdio: 'inherit', env: { ...process.env, DSH_PLUGIN_PREVIEW_REQUEST: join(job.out, 'request.json') },
    })
    if (result.error) throw result.error
    if (result.status !== 0) { process.stderr.write(`Flutter preview failed; partial output: ${job.out}\n`); return 3 }
    let nativeFatal = false
    for (const theme of job.request.themes) {
      if (!existsSync(join(job.out, `${theme}.png`))) throw new Error(`Flutter did not write ${theme}.png`)
      const native = JSON.parse(readFileSync(join(job.out, `${theme}.json`), 'utf8'))
      nativeFatal ||= native.fatal === true
    }
    process.stdout.write(`Preview: ${job.out}\n`)
    return Math.max(checked, nativeFatal ? 2 : 0)
  } catch (error) { process.stderr.write(`${error.message}\n`); return 3 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
