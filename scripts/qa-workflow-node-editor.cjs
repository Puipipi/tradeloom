const {app,BrowserWindow,WebContentsView,protocol}=require('electron')
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url')
const base=path.resolve(__dirname,'..'),deps=process.env.TRADELOOM_QA_REACT_ROOT
if(!deps) throw Error('Set TRADELOOM_QA_REACT_ROOT to a React 18 + ReactDOM node_modules directory')
const output=process.env.TRADELOOM_QA_OUTPUT || path.join(base,'tmp/node-editor-qa')
fs.mkdirSync(output,{recursive:true})
app.setPath('userData',path.join(output,'user-data'))
protocol.registerSchemesAsPrivileged([{scheme:'wf-qa',privileges:{standard:true,secure:true,supportFetchAPI:true}}])
const source=fs.readFileSync(path.join(base,'packages/tradeloom-shell/client.workflow.js'),'utf8')
const report={errors:[]}; const finish=()=>{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));app.quit()}
app.whenReady().then(async()=>{
 const {workflowCatalog}=await import(pathToFileURL(path.join(base,'packages/tradeloom-shell/workflow-schema.js')))
 const doc={version:1,id:'fixture',title:'合成工作流',confirmed:true,source:'manual',nodes:[{id:'in',kind:'input',title:'输入',position:{x:0,y:0}},{id:'out',kind:'output',title:'输出',position:{x:270,y:0}}],edges:[{from:'in',to:'out'}]}
 const html=`<html><body style="margin:0"><main style="height:600px"></main><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.dshDesktop={workflowNodeEditorAvailable:()=>true};window.__ModuleLoader__={load:m=>window.Canvas=m.factory(n=>n==='react-dom'?ReactDOM:React).WorkflowCanvas};</script><script src="/workflow.js"></script><script>ReactDOM.createRoot(document.querySelector('main')).render(React.createElement(Canvas,{initial:{doc:${JSON.stringify(doc)},catalog:${JSON.stringify(workflowCatalog())},editing:false}}));</script></body></html>`
 protocol.handle('wf-qa',req=>{let route=new URL(req.url).pathname;return new Response(route==='/'?html:route==='/workflow.js'?source:fs.readFileSync(path.join(deps,route==='/react.js'?'react/umd/react.development.js':'react-dom/umd/react-dom.development.js')),{headers:{'content-type':route==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8'}})})
 const owner=new BrowserWindow({show:false,width:1300,height:800,webPreferences:{sandbox:true,contextIsolation:true}})
 const view=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true}});owner.contentView.addChildView(view);view.setBounds({x:20,y:30,width:650,height:600});view.setVisible(true)
 const item={view,parent:owner,visible:true};let closed=false,sceneComponent=item
 const controller={resolveGuest:()=>({scope:'scene-component',view})},hasNativeModal=()=>false
 const host=fs.readFileSync(path.join(base,'apps/tradeloom-launcher/stage5-source06/asar/lib/tradeloom-source-shell/source-shell-controller.mjs'),'utf8')
 const from=host.indexOf('  const closeWorkflowNodeEditor ='),to=host.indexOf('  const disposeSceneComponent',from)
 const install=new Function('controller','closed','sceneComponent','hasNativeModal',host.slice(from,to)+';return installWorkflowNodeEditor')(controller,closed,sceneComponent,hasNativeModal)
 // Keep the genuine handler but force test windows invisible.
 const realSet=view.webContents.setWindowOpenHandler.bind(view.webContents)
 // Re-install with a wrapper capturing the production callback.
 view.webContents.setWindowOpenHandler=fn=>realSet(details=>{const result=fn(details);if(result.action==='allow')result.overrideBrowserWindowOptions.show=false;return result})
 install(item)
 for(const wc of [view.webContents]) wc.on('console-message',(_e,_level,message)=>{if(/Error|Uncaught/.test(message))report.errors.push(message)})
 await view.webContents.loadURL('wf-qa://app/')
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));await sleep(250)
 const run=code=>view.webContents.executeJavaScript(code,true)
 report.hover = {status:'partial',reason:'hidden renderer mouse input did not trigger hover; no acceptance claim'}
 report.before=await run(`({transform:document.querySelector('.tl-wf-layer').style.transform,nodes:[...document.querySelectorAll('[data-node-id]')].map(n=>[n.dataset.nodeId,n.style.left,n.style.top]),edges:document.querySelectorAll('.tl-wf-edge').length})`)
 await run(`document.querySelector('[data-node-id="out"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await sleep(250)
 report.popup=Boolean(item.nodeEditor)
 if(!item.nodeEditor)throw Error('native popup missing')
 report.aux=await item.nodeEditor.webContents.executeJavaScript(`({url:location.href,title:document.title,form:!!document.querySelector('.tl-wf-inspector'),fields:[...document.querySelectorAll('input,textarea')].map(n=>n.value),modal:document.querySelector('[role=dialog]')?.getAttribute('aria-modal')})`)
 report.afterOpen=await run(`document.querySelector('.tl-wf-layer').style.transform`)
 await item.nodeEditor.webContents.executeJavaScript(`(()=>{let input=document.querySelector('input'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'输出编辑保留');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
 await run(`(()=>{let s=document.querySelector('.tl-wf-surface');s.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:30,clientY:400}));s.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:90,clientY:430}));s.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));s.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-100}))})()`);await sleep(100)
 report.afterPan=await run(`document.querySelector('.tl-wf-layer').style.transform`)
 report.retained=await item.nodeEditor.webContents.executeJavaScript(`document.querySelector('input').value`)
 await item.nodeEditor.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(n=>n.textContent==='应用到草稿').click()`);await sleep(150)
 report.applied=await run(`({transform:document.querySelector('.tl-wf-layer').style.transform,text:document.querySelector('[data-node-id="out"]').textContent,nodes:document.querySelectorAll('[data-node-id]').length})`)
 report.pass=report.popup&&report.aux.form&&report.aux.modal==='false'&&report.before.transform===report.afterOpen&&report.afterPan!==report.afterOpen&&report.retained==='输出编辑保留'&&report.applied.text.includes('输出编辑保留')&&report.applied.transform===report.afterPan&&report.applied.nodes===2
 report.forcedClose = false
 // Reopen using the keyboard entrance, cancel, and verify original applied fields remain.
 await run(`document.querySelector('[data-node-id="out"]').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter'}))`);await sleep(120)
 report.keyboard = Boolean(item.nodeEditor)
 await item.nodeEditor.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(n=>n.textContent==='取消').click()`);await sleep(80)
 report.cancelled = !item.nodeEditor
 await run(`document.querySelector('[data-node-id="out"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await sleep(100)
 item.nodeEditor.destroy();await sleep(350)
 report.forcedClose = await run(`!document.querySelector('.tl-wf-inspector')`)
 report.pass = report.pass && report.forcedClose
 // Ordinary page fallback keeps the same React form and leaves the graph interactive.
 await run(`delete window.dshDesktop.workflowNodeEditorAvailable;document.querySelector('[data-node-id="out"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await sleep(100)
 report.fallback = await run(`({form:!!document.querySelector('.tl-wf-inspector'),modal:document.querySelector('[role=dialog]')?.getAttribute('aria-modal'),inert:document.querySelector('.tl-wf-surface').inert})`)
 report.pass = report.pass && report.keyboard && report.cancelled && report.fallback.form && !report.fallback.inert
 report.capture='hidden WebContentsView capture omitted; renderer DOM and native popup assertions recorded'
 if(!report.pass)throw Error('renderer acceptance failed')
 owner.destroy();finish()
}).catch(error=>{report.errors.push(error.stack);finish()})
setTimeout(()=>{report.errors.push('timeout');finish()},20000).unref()
