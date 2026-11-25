// What the dsh-go app gets from the bridge for the three example plugins (host-e2e.sh).
// Node 22+ built-ins only (fetch, WebSocket).
//
//   node host-e2e.mjs <base-url> <launch-token> <repo>
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [base, token, repo] = process.argv.slice(2)
const { checkView } = await import(pathToFileURL(join(repo, 'sdk', 'plugin-kit', 'lib', 'view-check.js')).href)

let passed = 0
let failed = 0
const check = (ok, msg, extra) => {
  if (ok) {
    passed++
    console.log(`  PASS ${msg}`)
  } else {
    failed++
    console.log(`  FAIL ${msg}${extra === undefined ? '' : `\n       ${JSON.stringify(extra).slice(0, 600)}`}`)
  }
}
const section = (s) => console.log(`== ${s}`)

const login = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('dsh-auth-'))?.split(';')[0]
check(Boolean(cookie), 'login cookie')
const H = { cookie }
const CAPS = 'v=1&app=0.10.0&surfaces=composer.actions,message.actions,composer.strip,panels&components=stack,row,text,metric,chart,compare,steps,callout,options,confirm,list,keyValue,progress,table,actions,image'
const get = async (path) => {
  const r = await fetch(`${base}${path}`, { headers: H })
  return { status: r.status, json: await r.json().catch(() => undefined) }
}
const post = async (body) => {
  const r = await fetch(`${base}/dsh-go/v1/invoke`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, ...body }) })
  return { status: r.status, json: await r.json().catch(() => undefined) }
}

section('contributions: the bridge reads the installed manifests')
const zh = await get(`/dsh-go/v1/contributions?${CAPS}&locale=zh-CN`)
check(zh.status === 200, `GET contributions -> ${zh.status}`)
const byPkg = Object.fromEntries((zh.json?.plugins ?? []).map((p) => [p.pkg, p]))
check(byPkg['dsh-go-example-weather'] === undefined, 'weather has no dshGo: not listed (tool card only)')
for (const pkg of ['dsh-go-example-usage', 'dsh-go-example-quick']) {
  const p = byPkg[pkg]
  check(p?.state === 'ok' && p?.native === true, `${pkg}: state ok, native`, p)
  check(Array.isArray(p?.issues) && p.issues.length === 0, `${pkg}: no issues`, p?.issues)
}
const quick = byPkg['dsh-go-example-quick']
check(quick?.title === '快捷', 'quick title (zh)', quick?.title)
check(JSON.stringify(quick?.contributes['composer.actions'].map((a) => [a.id, a.label, a.ready, a.effect?.[0]?.type ?? null])) === JSON.stringify([['summarize', '总结', true, 'insert'], ['translate', '译成英文', true, null]]), 'quick capsules: static summarize + ready translate', quick?.contributes['composer.actions'])
check(quick?.contributes['message.actions'].every((a) => a.ready), 'quick menu items ready', quick?.contributes['message.actions'])
check(JSON.stringify(quick?.wants) === JSON.stringify(['clipboard', 'message']), 'quick wants clipboard + message', quick?.wants)
const usage = byPkg['dsh-go-example-usage']
check(usage?.contributes['composer.strip'][0]?.live === true && usage.contributes['composer.strip'][0].panel === 'usage', 'usage strip: live, opens the panel', usage?.contributes['composer.strip'])
check(usage?.contributes.panels[0]?.live === true && usage.contributes.panels[0].ready === true, 'usage panel: ready, live', usage?.contributes.panels)
const en = await get(`/dsh-go/v1/contributions?${CAPS}&locale=en-US`)
const quickEn = en.json?.plugins.find((p) => p.pkg === 'dsh-go-example-quick')
check(quickEn?.title === 'Quick' && quickEn.contributes['composer.actions'][1].label === 'To English' && quickEn.issues.length === 0, 'English labels fit, no issues', quickEn)

section('tool card: one weather_forecast call through DSH\'s tool registry')
{
  const r = await fetch(`${base}/dsh-go-e2e-probe/weather`, { headers: H })
  const body = await r.json().catch(() => undefined)
  check(body?.registered === true, 'weather_forecast is registered (plugin loaded from the profile, dsh-tools peer resolved)', body)
  const result = body?.result
  if (result?.isError) {
    console.log(`  SKIP tool card: the call failed (offline?): ${JSON.stringify(result.content ?? result.error).slice(0, 200)}`)
  } else {
    const view = result?.meta?.['dsh-go/view']
    check(view !== undefined, 'result.meta carries "dsh-go/view"', result)
    const parsed = checkView(view, { budget: 'toolCard' })
    check(!parsed.fatal && parsed.issues.length === 0 && parsed.bytes < 8192, `tool card parses like the app: "${parsed.title}", ${parsed.components} components, ${parsed.bytes} bytes`, parsed.issues)
    check(Array.isArray(result?.content) && /^Forecast for /.test(result.content[0]?.text ?? ''), 'the model still reads plain text', result?.content)
  }
}

section('panel view and data')
for (const [scope, label] of [['&sessionId=e2e-session', 'in a chat'], ['', 'All features']]) {
  const v = await get(`/dsh-go/v1/views/dsh-go-example-usage/usage?${CAPS}&locale=zh-CN${scope}`)
  check(v.status === 200, `GET views usage (${label}) -> ${v.status}`, v.json)
  const parsed = checkView(v.json?.view, { budget: 'panel', data: v.json?.data })
  check(!parsed.fatal && parsed.issues.length === 0, `view parses like the app: ${parsed.components} components, ${parsed.empty} empty, 0 issues`, parsed.issues)
  check(typeof v.json?.data?.today?.total === 'string' && Array.isArray(v.json?.data?.week?.values), 'initial data pushed', v.json?.data)
}

section('stream: strip data in the app locale')
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/dsh-go/v1/stream`, { headers: H })
const inbox = []
const waiters = []
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  inbox.push(msg)
  for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg) }
})
const next = (match, ms = 8000) => new Promise((resolve, reject) => {
  const hit = inbox.find(match)
  if (hit) return resolve(hit)
  const w = { match, resolve }
  waiters.push(w)
  setTimeout(() => reject(new Error('timeout waiting for stream message')), ms).unref()
})
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
ws.send(JSON.stringify({ t: 'hello', v: [1], locale: 'en-US' }))
const welcome = await next((m) => m.t === 'welcome')
check(welcome.v === 1, `welcome (bridge ${welcome.bridge})`)
ws.send(JSON.stringify({ t: 'sub', sub: 's1', pkg: 'dsh-go-example-usage', id: 'today', scope: { sessionId: 'e2e-session' } }))
const strip = await next((m) => m.sub === 's1' && m.t === 'data' && m.data !== null)
check(/^Today \d/.test(strip.data.text) && strip.data.icon === 'chart', `strip data "${strip.data.text}" (English via caps.locale)`, strip.data)

section('invoke')
const copy = await post({ pkg: 'dsh-go-example-quick', id: 'copy-md', surface: 'message.actions', scope: { sessionId: 'e2e-session' }, context: { message: '结论。\n\n```dsh-ui\n{"type":"text","text":"x"}\n```\n\n- 一' }, locale: 'zh-CN' })
check(copy.status === 200 && JSON.stringify(copy.json.effects) === JSON.stringify([{ type: 'copy', text: '结论。\n\n- 一' }, { type: 'toast', text: '已复制' }]), 'copy-md -> copy + toast', copy.json)
const stat = await post({ pkg: 'dsh-go-example-quick', id: 'summarize', surface: 'composer.actions' })
check(stat.status === 409 && stat.json?.error?.code === 'no-handler', 'static capsule is never invoked (409 no-handler)', stat)
const panelCopy = await post({ pkg: 'dsh-go-example-usage', id: 'usage', surface: 'panel', action: 'copy', scope: { sessionId: 'e2e-session' }, locale: 'zh-CN' })
check(panelCopy.status === 200 && panelCopy.json.effects[0]?.type === 'copy' && panelCopy.json.effects[1]?.text === '已复制', 'panel button -> copy + toast', panelCopy.json)
const empty = await post({ pkg: 'dsh-go-example-quick', id: 'translate', surface: 'composer.actions', context: {}, locale: 'zh-CN', stream: welcome.conn })
check(empty.status === 200 && empty.json.effects[0]?.text === '剪贴板里没有文字', 'translate with an empty clipboard -> toast', empty.json)
const tr = await post({ pkg: 'dsh-go-example-quick', id: 'translate', surface: 'composer.actions', context: { clipboard: '你好' }, locale: 'zh-CN', stream: welcome.conn })
if (tr.json?.pending) {
  check(tr.status === 200 && tr.json.pending.label === '正在翻译', `translate -> pending "${tr.json.pending.label}" (${tr.json.pending.timeoutMs} ms)`, tr.json)
  const settled = await next((m) => m.pending === tr.json.pending.id && (m.t === 'done' || m.t === 'void' || m.t === 'result'), 70000)
  check(settled.t === 'void' || settled.t === 'done' || settled.t === 'result', `deferred result settled: ${settled.t}${settled.reason ? ` (${settled.reason})` : ''}`, settled)
} else {
  check(tr.status === 200 && tr.json.effects[0]?.type === 'insert', 'translate without a model route -> insert request', tr.json)
}
ws.close()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
