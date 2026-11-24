// Isolated Electron integration proof: full detached shell, synthetic Registry/HTTP/native canvas.
// Run with Electron, never with an active application/profile. QA_REPO and QA_OUT are optional.
const {app,BrowserWindow,WebContentsView,protocol,ipcMain}=require('electron');
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),http=require('http'),vm=require('vm'),{createHash}=require('crypto'),{pathToFileURL}=require('url');
const repo=process.env.QA_REPO||path.resolve(__dirname,'../../..'),out=process.env.QA_OUT||path.join(require('os').tmpdir(),'tl-detached-assistant-qa-'+Date.now());
const source=path.join(repo,'apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell');fs.mkdirSync(out,{recursive:true});fs.rmSync(path.join(out,'error.txt'),{force:true});app.setPath('userData',path.join(out,'userdata'));
protocol.registerSchemesAsPrivileged([{scheme:'dsh-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const preload=`const {ipcRenderer}=require('electron');const config=${JSON.stringify(JSON.parse(fs.readFileSync(path.join(repo,'packages/tradeloom-shell/scenes.json'))))};config.roles=[...new Set(config.scenes.map(s=>s.roleId).filter(Boolean))].map(id=>({id}));config.sessionBindings=Object.fromEntries(config.roles.map(r=>[r.id,'synthetic-'+r.id]));window.qaCalls=[];window.qaStatus='owned-elsewhere';const response={status:'context-mounted',placement:'docked',componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main',toolbar:{canStart:true,canRefresh:true}};const call=(action,args)=>{window.qaCalls.push({action,args});return ipcRenderer.invoke('qa-surface',action,args).then(()=>response)};window.app={sourceConfig:async()=>config,getUiScale:async()=>1,accountSurface:{},harnessSurface:{assistantTabCatalog:async(...args)=>{const rows=await ipcRenderer.invoke('qa-catalog',...args);window.qaLockedPanel=rows.find(r=>r.label==='交付协同')?.panelId;return rows},create:async(s,p)=>{window.qaCalls.push({action:'create',args:[s,p]});return {status:p===window.qaLockedPanel?window.qaStatus:'context-mounted'}},status:async()=>({status:'context-mounted'}),setVisible:async(...args)=>{window.qaCalls.push({action:'role-visible',args})},setBounds:async()=>{}},workflowCanvas:{mount:()=>call('mount'),status:async()=>response,setVisible:(...args)=>call('visible',args),setBounds:(...args)=>call('bounds',args),toolbarAction:async()=>{}}};`;
fs.writeFileSync(path.join(out,'preload.cjs'),preload);
app.whenReady().then(async()=>{
 const imp=name=>import(pathToFileURL(path.join(repo,'node_modules/@deepseek-ai',name,'lib/index.js')).href);
 const {Context}=await imp('cordis');const {default:Registry}=await imp('dsh-agent-preset-registry');const ctx=new Context();const registry=new Registry(ctx,{default:'standard'});
 for(const id of ['standard','ptc','minimal','cordis'])await registry.register({id,plugins:[]});
 await registry.register({id:'qa-extra',name:'交付协同',plugins:[]});
 const {createAssistantPresetsHandler}=await import(pathToFileURL(path.join(repo,'packages/tradeloom-shell/host.js')).href);
 const route=createAssistantPresetsHandler({get:name=>name==='agentPresets'?registry:undefined,connection:{requestRejection:()=>undefined},logger:{error(){}}});
 const server=http.createServer((req,res)=>{if(req.url!=='/tradeloom/assistant-presets'){res.statusCode=404;res.end();return}Promise.resolve(route(req,res)).catch(()=>{res.statusCode=500;res.end()})});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const roster=async()=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/tradeloom/assistant-presets');assert.equal(response.status,200);return (await response.json()).presets};
 const officialPhase=await roster();assert.deepEqual(officialPhase.map(p=>p.id),['qa-extra']);

 // In a second synthetic registry, publish a named declaration with a shipped ID.

 const customCtx=new Context();const customRegistry=new Registry(customCtx,{default:'standard'});
 for(const id of ['standard','ptc','cordis'])await customRegistry.register({id,plugins:[]});
 await customRegistry.register({id:'minimal',name:'极简审核助手',plugins:[]});await customRegistry.register({id:'qa-extra',name:'交付协同',plugins:[]});

 const customRoute=createAssistantPresetsHandler({get:name=>name==='agentPresets'?customRegistry:undefined,connection:{requestRejection:()=>undefined},logger:{error(){}}});
 server.removeAllListeners('request');server.on('request',(req,res)=>{Promise.resolve(customRoute(req,res)).catch(()=>{res.statusCode=500;res.end()})});
 const customPhase=await roster();assert.deepEqual(customPhase.map(p=>p.id),['minimal','qa-extra']);
 fs.writeFileSync(path.join(out,'catalog.json'),JSON.stringify({officialPhase,customPhase,officialExcluded:['standard','ptc','minimal','cordis'],status:200},null,2));

 protocol.handle('dsh-app',r=>{try{const f=path.join(source,decodeURIComponent(new URL(r.url).pathname)),ext=path.extname(f);return new Response(fs.readFileSync(f),{headers:{'content-type':['.js','.mjs'].includes(ext)?'text/javascript':ext==='.css'?'text/css':ext==='.html'?'text/html':'application/octet-stream'}})}catch{return new Response('',{status:404})}});
 const w=new BrowserWindow({show:false,offscreen:true,width:1440,height:900,webPreferences:{preload:path.join(out,'preload.cjs'),contextIsolation:false,sandbox:false}});
 const config=JSON.parse(fs.readFileSync(path.join(repo,'packages/tradeloom-shell/scenes.json')));config.roles=[...new Set(config.scenes.map(s=>s.roleId).filter(Boolean))].map(id=>({id}));
 const controller=fs.readFileSync(path.join(repo,'apps/tradeloom-launcher/stage5-source06/asar/lib/tradeloom-source-shell/source-shell-controller.mjs'),'utf8');const start=controller.indexOf("      bind('assistantTabCatalog', async (event, hostSceneId, hostPanelId) => {");const end=controller.indexOf("      bind('create',",start);let catalog;
 vm.runInNewContext(controller.slice(start,end),{bind:(_,f)=>catalog=f,assertWindow:()=>w,scene:id=>config.scenes.find(s=>s.id===id),windows:new Map(),main:w,hasNativeModal:()=>false,configurationEpoch:1,config,assistantRoleTabTargets:new Map(),key:(s,p)=>s+'/'+p,listAssistantPresets:roster,closed:false,createHash});
 ipcMain.handle('qa-catalog',(_,scene,panel)=>catalog({},scene,panel));
 const canvas=new WebContentsView({webPreferences:{sandbox:true}});w.contentView.addChildView(canvas);canvas.setVisible(false);
 await canvas.webContents.loadURL('data:text/html,<html><body><div id="draft">2 nodes 106%</div><script>window.draft={nodes:[{id:1},{id:2}],viewport:{x:31,y:47,zoom:1.06}};window.token=Math.random()</script></body></html>');
 const calls=[];ipcMain.handle('qa-surface',(_,action,args)=>{calls.push({action,args});if(action==='visible')canvas.setVisible(args[0]);if(action==='bounds'){const r=args[0];canvas.setBounds({x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)})}return true});
 const js=s=>w.webContents.executeJavaScript(s);const pause=()=>new Promise(r=>setTimeout(r,280));
 const click=async selector=>{const p=await js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b)throw Error('missing '+${JSON.stringify(selector)});b.scrollIntoView({block:'nearest',inline:'nearest'});const r=b.getBoundingClientRect();return{scene:location.search,rect:{x:r.x,y:r.y,width:r.width,height:r.height},target:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,350),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);assert.equal(p.hit,true,selector+' hit '+JSON.stringify(p));w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:p.x,y:p.y});w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:p.x,y:p.y});await pause();return p};
 const result=[];
 for(const scene of ['agent-center','products','deliverables']){
  await w.loadURL('dsh-app://app/source-entry.html?scene='+scene+'&solo=1');await new Promise(r=>setTimeout(r,1300));
  await js(`window.qaPanels=[...document.querySelectorAll('#grid>.panel')];window.qaHost=document.querySelector('.business-workflow-host');true`);
  const draft=await canvas.webContents.executeJavaScript('JSON.stringify({draft,token})'),start=calls.length;
  const open=async()=>{await js(`document.querySelector('#grid .panel-chat .panel-header').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:1100,clientY:650}));true`);await pause();await click('.pi-menu button');assert.equal(await js(`Boolean(document.querySelector('.business-assistant-menu'))`),true);const labels=await js(`Array.from(document.querySelectorAll('.business-assistant-menu button'),b=>b.textContent)`);const openLabels=await js(`Array.from(document.querySelectorAll('[data-assistant-tab-role]'),b=>b.textContent)`);for(const name of ['交付协同','极简审核助手'])assert.equal(labels.includes(name),!openLabels.includes(name),'catalog dedup '+name)};
  await open();await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);await pause();
  await open();await js(`document.querySelectorAll('.business-assistant-menu button').forEach(b=>{if(b.textContent==='交付协同')b.id='qa-choice'})`);await click('#qa-choice');
  const locked=await js(`document.querySelector('.business-runtime-state[data-state="owned-elsewhere"]')?.textContent||document.querySelector('#grid .panel-chat').textContent`);
  await open();await js(`document.querySelectorAll('.business-assistant-menu button').forEach(b=>{if(b.textContent==='极简审核助手')b.id='qa-choice'})`);await click('#qa-choice');
  // Switch and close the inactive locked tab using Chromium's actual input dispatch.
  await click('.business-assistant-tabs-scroll .business-assistant-tab-close');
  assert.equal(await js(`document.querySelectorAll('.business-assistant-tab-close').length`),1);
  await click('.business-assistant-tab-current .business-assistant-tab-close');
  assert.equal(await js(`document.querySelectorAll('.business-assistant-tab-close').length`),0);
  const fixed=await js(`document.querySelector('[data-assistant-fixed]').textContent`);await click('[data-assistant-fixed]');
  // Active owned-elsewhere tab must also be removable; its session is untouched.
  await open();await js(`document.querySelectorAll('.business-assistant-menu button').forEach(b=>{if(b.textContent==='交付协同')b.id='qa-choice'})`);await click('#qa-choice');await click('.business-assistant-tab-current .business-assistant-tab-close');
  const same=await js(`qaPanels.every(p=>p.isConnected)&&qaHost===document.querySelector('.business-workflow-host')`);assert.equal(same,true,'panel identity');
  assert.equal(await js(`document.querySelectorAll('.business-assistant-tab-close').length`),0);
  const placeholder=await js(`(()=>{const n=document.querySelector('.business-workflow-host .business-runtime-state');return n&&{hidden:n.hidden,display:getComputedStyle(n).display,text:n.textContent}})()`);if(placeholder?.hidden)assert.equal(placeholder.display,'none','connected placeholder remains hidden');const after=await canvas.webContents.executeJavaScript('JSON.stringify({draft,token})');assert.equal(after,draft,'draft and viewport');
  const workflowCalls=calls.slice(start),hidden=workflowCalls.filter(c=>c.action==='visible'&&c.args[0]===false);assert.equal(workflowCalls.filter(c=>c.action==='mount').length,0,'no remount');
  result.push({scene,fixed,locked:locked.includes('其他窗口'),samePanels:same,draftUnchanged:after===draft,mounts:workflowCalls.filter(c=>c.action==='mount').length,overlappingContextMenuHides:hidden.length,remainingAdded:0,placeholder});
  fs.writeFileSync(path.join(out,scene+'.png'),(await w.webContents.capturePage()).toPNG());
 }
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));w.destroy();server.close();await ctx.fiber.dispose();await customCtx.fiber.dispose();app.quit();
}).catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);app.exit(1)});
