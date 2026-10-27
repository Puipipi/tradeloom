import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {runInNewContext} from 'node:vm'
import test from 'node:test'

const require=createRequire(import.meta.url)
async function harness(t,run){
  const reactPath=process.env.TRADELOOM_REACT_LIBRARY,serverPath=process.env.TRADELOOM_REACT_SERVER_LIBRARY,domPath=process.env.TRADELOOM_DOM_MODULE
  if(!reactPath||!serverPath||!domPath)return t.skip('requires pinned React/JSDOM')
  const React=require(reactPath),{createRoot}=createRequire(serverPath)('react-dom/client'),{createPortal}=createRequire(serverPath)('react-dom'),{JSDOM}=require(domPath)
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://fixture.local/',pretendToBeVisual:true})
  const previous={window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT}
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})
  let registration
  dom.window.__ModuleLoader__={load(value){registration=value}}
  runInNewContext(await readFile(new URL('../client.scenes.js',import.meta.url),'utf8'),{window:dom.window,document:dom.window.document,setTimeout,clearTimeout,URL,URLSearchParams})
  const scenes=registration.factory(name=>{if(name==='react')return React;throw Error('unused optional module')})
  const contributions=[]
  scenes.register({slots:{inject:(_name,fn)=>fn(),register:(options,Component)=>{contributions.push({options,Component});return ()=>{}}}})
  const copies=contributions.filter(x=>x.options.id==='tradeloom-copy-path')
  assert.deepEqual(copies.map(x=>x.options.name),['sidebar.right.tab.files.actions','sidebar.right.tab.document.actions'])
  const Component=copies[0].Component,root=createRoot(dom.window.document.getElementById('root'))
  const render=path=>React.act(async()=>root.render(React.createElement(Component,{absolutePath:path})))
  const click=()=>React.act(async()=>dom.window.document.querySelector('[data-tl-copy-path]').click())
  const renderIn=(path,container)=>React.act(async()=>root.render(createPortal(React.createElement(Component,{absolutePath:path}),container)))
  try{await run({dom,render,renderIn,JSDOM,click,act:React.act})}finally{await React.act(async()=>root.unmount());dom.window.close();Object.assign(globalThis,previous)}
}

test('native path copy uses only the owning document clipboard and native slot path',async t=>harness(t,async h=>{
  const writes=[]
  Object.defineProperty(h.dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async value=>writes.push(value)}})
  await h.render('C:/owned/织贸.txt');await h.click()
  assert.deepEqual(writes,['C:/owned/织贸.txt'])
  assert.equal(h.dom.window.document.querySelector('[role="status"]').textContent,'完整路径已复制')
  await h.render('C:/owned/other.txt')
  assert.equal(h.dom.window.document.querySelector('[role="status"]').textContent,'')
  await h.click();assert.equal(writes[1],'C:/owned/other.txt')
}))

test('native path copy reports clipboard failure and permits an explicit retry',async t=>harness(t,async h=>{
  let fail=true
  Object.defineProperty(h.dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async()=>{if(fail)throw Error('fixture denied')}}})
  await h.render('C:/owned/one.txt');await h.click()
  const button=h.dom.window.document.querySelector('[data-tl-copy-path]')
  assert.equal(h.dom.window.document.querySelector('[role="status"]').textContent,'复制失败，请重试')
  assert.equal(button.disabled,false)
  fail=false;await h.click();assert.equal(h.dom.window.document.querySelector('[role="status"]').textContent,'完整路径已复制')
}))

test('pending copy never announces success for a different native path',async t=>harness(t,async h=>{
  let finish
  Object.defineProperty(h.dom.window.navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise(resolve=>{finish=resolve})}})
  await h.render('C:/owned/one.txt');await h.click()
  assert.equal(h.dom.window.document.querySelector('[data-tl-copy-path]').disabled,true)
  await h.render('C:/owned/two.txt');await h.act(async()=>finish())
  assert.equal(h.dom.window.document.querySelector('[role="status"]').textContent,'')
  await h.render(undefined);assert.equal(h.dom.window.document.querySelector('[data-tl-copy-path]'),null)
}))

test('a portaled native path control uses the secondary document clipboard',async t=>harness(t,async h=>{
  const secondary=new h.JSDOM('<!doctype html><div id="portal"></div>',{url:'http://fixture.local/'})
  const primaryWrites=[],secondaryWrites=[]
  Object.defineProperty(h.dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async value=>primaryWrites.push(value)}})
  Object.defineProperty(secondary.window.navigator,'clipboard',{configurable:true,value:{writeText:async value=>secondaryWrites.push(value)}})
  try{
    await h.renderIn('C:/owned/floating.txt',secondary.window.document.getElementById('portal'))
    await h.act(async()=>secondary.window.document.querySelector('[data-tl-copy-path]').click())
    assert.deepEqual(primaryWrites,[]);assert.deepEqual(secondaryWrites,['C:/owned/floating.txt'])
    assert.equal(secondary.window.document.querySelector('[role="status"]').textContent,'完整路径已复制')
    await h.render(undefined)
  }finally{secondary.window.close()}
}))
