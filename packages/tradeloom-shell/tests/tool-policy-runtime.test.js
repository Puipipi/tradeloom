import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const base = process.env.TRADELOOM_DSH_PINNED_SOURCE
const evidence = fileURLToPath(new URL('../../../../workspace/testing/agent-capability-configuration-20261023/', import.meta.url))
const sourcePolicy = new URL('../tool-policy.js', import.meta.url)

test('original physical policy rejects outside profile and uses official profile resolution with isolated guards', async t => {
  if (!base) { t.skip('requires explicit pinned compiled runtime'); return }
  const sdk = relative => import(pathToFileURL(resolve(base, relative)).href)
  const [{ Context }, { default: Loader }, { default: Group }, { default: Registry }, testkit, boot] = await Promise.all([
    sdk('vendor/cordis/lib/index.js'), sdk('vendor/loader/lib/index.js'), sdk('vendor/group/lib/index.js'),
    sdk('packages/preset/agent-preset-registry/lib/index.js'), sdk('packages/test-support/agent-loop-testkit/lib/index.js'),
    sdk('packages/boot/app-boot/lib/index.js'),
  ])
  await mkdir(evidence, {recursive:true})
  const home = await mkdtemp(join(evidence, 'policy-profile-'))
  const profileDir = join(home, 'profiles/policy-regression')
  boot.initProfile(profileDir, [])
  const target = join(profileDir, 'plugins/tradeloom-shell')
  await mkdir(target, {recursive:true})
  await copyFile(sourcePolicy, join(target,'tool-policy.js'))
  await copyFile(new URL('../package.json',import.meta.url),join(target,'package.json'))
  assert.deepEqual(await readFile(join(target,'tool-policy.js')),await readFile(sourcePolicy))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home,{recursive:true,force:true}) })
  await ctx.plugin(Loader, {baseUrl:pathToFileURL(profileDir+'/').href})
  ctx.loader.builtins.group = Group
  const outside = await import(sourcePolicy.href)
  await assert.rejects(outside.apply(ctx,{deniedTools:[]}),{code:'ERR_MODULE_NOT_FOUND'})
  const installAnchor = join(base,'apps/cli/package.json')
  const profile = boot.loadProfileDirectory('dsh',profileDir,installAnchor)
  const resolution = await boot.createRuntimeResolution({installAnchor,profile,home})
  const mapping = resolution.entries.find(row=>row.name==='@deepseek-ai/dsh-scope')
  assert.equal(mapping.scope,'installation'); assert.equal(mapping.version,'0.2.1-rc.3')
  assert.deepEqual(JSON.parse(await readFile(join(profileDir,'package.json'),'utf8')).dependencies,{})
  await ctx.plugin(boot.PluginPackages,{resolution})
  const policyUrl = pathToFileURL(join(target,'tool-policy.js')).href
  assert.equal(ctx.pluginPackages.packageOf('@deepseek-ai/dsh-scope',policyUrl).dir,mapping.packageDir)
  await assert.rejects(outside.apply(ctx,{deniedTools:[]}),{code:'ERR_MODULE_NOT_FOUND'},'external importer is not silently granted the profile layer')
  const policy = await import(policyUrl)
  await assert.rejects(policy.apply(ctx,{deniedTools:[]}),/requires a preset scope/)
  await testkit.mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Registry,{default:'center'})
  await testkit.mountAgentLoopTestHarness(ctx)
  const presets = ctx.get('agentPresets')
  for(const [id,deniedTools] of [['center',['synthetic-protected']],['expert',[]],['sibling',[]]]) await presets.register({id,plugins:[{id:'policy',name:policyUrl,config:{deniedTools}}]})
  assert.equal((await presets.list()).some(row=>row.broken!==undefined),false)
  await presets.register({id:'invalid-config',plugins:[{id:'policy',name:policyUrl,config:{deniedTools:null}}]})
  assert.match((await presets.list()).find(row=>row.id==='invalid-config').broken,/configuration is invalid/)
  let calls=0
  ctx.tools.register({name:'synthetic-protected',description:'offline synthetic body',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{calls++;return 'ran'}})
  const handles=[]
  try {
    handles.push(await ctx.agents.create({sessionId:'policy-root'}))
    for(const id of ['center','expert','sibling']) handles.push(await ctx.agents.create({sessionId:'policy-'+id,setup:async agentCtx=>{await presets.mount(agentCtx,id)}}))
    const run=handle=>ctx.tools.execute({callId:'guard-'+handle.agent.id,name:'synthetic-protected',arguments:{},agent:handle.agent,signal:new AbortController().signal})
    assert.equal((await run(handles[1])).isError,true);assert.equal(calls,0)
    for(const handle of [handles[0],handles[2],handles[3]]) assert.equal((await run(handle)).value,'ran')
    assert.equal(calls,3);assert.equal((await run(handles[1])).isError,true);assert.equal(calls,3)
  } finally {for(const handle of handles) await handle.dispose()}
})
