const assert=require('node:assert/strict')
if(!process.versions.electron)require('node:test')('hidden SceneDock layout lifecycle',{skip:'Real independent Electron15/Dockview layout runner required'},()=>{})
exports.run=async({js,win,wait,capture})=>{
 const waitCanvas=async()=>{for(let i=0;i<150;i++){if(await js(`!!document.querySelector('[data-business-view-tabs="agent-center"] .tl-wf')`))return;await wait(20)}throw new Error('Canvas not ready')}
 const jump=async label=>{const rect=await js(`(()=>{const b=[...document.querySelectorAll('.tl-navigation button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent===${JSON.stringify(label)});b.scrollIntoView({block:'nearest',inline:'nearest'});const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',...rect,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...rect,button:'left',clickCount:1});await wait(250)}
 const phase=label=>js(`window.fixturePhase=${JSON.stringify(label)}`)
 const snapshot=()=>js(`new Promise((resolve,reject)=>{const samples=[];let last='',stable=0;function frame(){const f=window.workflowFixture,a=f.scenes.getDockviewApi('agent-center');const value={raw:a.toJSON(),saved:f.scenes.getSnapshot().dockLayouts.scenes['agent-center'].dockview,bounds:a.panels.map(p=>({id:p.id,rect:p.group.element.getBoundingClientRect().toJSON()})),computedFont:getComputedStyle(document.querySelector('.tl-workbench')).fontSize};const key=JSON.stringify(value);stable=key===last?stable+1:1;last=key;samples.push({frame:samples.length,phase:window.fixturePhase,stable});if(stable>=4)resolve({...value,settle:samples});else if(samples.length>=120)reject(new Error('Layout never settled over120 RAF'));else requestAnimationFrame(frame)}requestAnimationFrame(frame)})`)
 await jump('工作流');await waitCanvas();await wait(100)
 await js(`window.layoutIdentity={frame:document.querySelector('[data-business-view-tabs="agent-center"] iframe'),canvas:document.querySelector('[data-business-view-tabs="agent-center"] .tl-wf'),editor:document.querySelector('[data-scene-id="agent-center"] [data-synthetic-editor]')};window.layoutIdentity.file=window.layoutIdentity.editor?.fixtureFile`)
 await phase('same-viewport-before');const before=await snapshot()
 await phase('hide-visit-other');await jump('商品')
 await phase('show-return');await jump('工作流');await wait(100);const after=await snapshot()
 const sameViewport={before,after,rawEqual:JSON.stringify(before.raw)===JSON.stringify(after.raw),savedEqual:JSON.stringify(before.saved)===JSON.stringify(after.saved),boundsEqual:JSON.stringify(before.bounds)===JSON.stringify(after.bounds)}
 await phase('wide-initial-canonical');win.setContentSize(1280,900);await wait(50);let wideBefore=await snapshot();let canonicalMaterialization=null
 if(wideBefore.saved.grid.width!==wideBefore.raw.grid.width||wideBefore.saved.grid.height!==wideBefore.raw.grid.height){
  const initial=wideBefore
  await phase('visible-canonical-materialization-narrow');win.setContentSize(640,900);await wait(50);await snapshot()
  await phase('visible-canonical-materialization-wide');win.setContentSize(1280,900);await wait(50);wideBefore=await snapshot()
  canonicalMaterialization={before:initial,after:wideBefore,rawEqual:JSON.stringify(initial.raw)===JSON.stringify(wideBefore.raw),boundsEqual:JSON.stringify(initial.bounds)===JSON.stringify(wideBefore.bounds)}
 }
 await phase('wide-baseline')
 await phase('narrow-before-hide');win.setContentSize(640,900);await wait(300)
 await phase('hide-before-resize');await jump('商品')
 await phase('hidden-resize-900');win.setContentSize(900,900);await wait(250)
 await phase('hidden-resize-1280');win.setContentSize(1280,900);await wait(250)
 await phase('show-wide-return');await jump('工作流');await wait(500);const wideAfter=await snapshot()
 const restoredWide={before:wideBefore,after:wideAfter,rawEqual:JSON.stringify(wideBefore.raw)===JSON.stringify(wideAfter.raw),savedEqual:JSON.stringify(wideBefore.saved)===JSON.stringify(wideAfter.saved),boundsEqual:JSON.stringify(wideBefore.bounds)===JSON.stringify(wideAfter.bounds)}
 const lifecycle=await js(`(()=>{const f=window.workflowFixture,s=window.layoutIdentity;return {iframe:s.frame===document.querySelector('[data-business-view-tabs="agent-center"] iframe'),canvas:s.canvas===document.querySelector('[data-business-view-tabs="agent-center"] .tl-wf'),editor:s.editor?document.contains(s.editor):null,file:s.editor?s.editor.fixtureFile===s.file:null,counters:f.counters,trace:f.trace,puts:f.requests.filter(r=>r.method==='PUT'),dependencyPaths:f.dependencyPaths}})()`)
 const hiddenMutations=lifecycle.trace.filter(t=>t.scene==='工作流工作区'&&t.active===false&&['exitMaximizedGroup','fromJSON','group.setSize'].includes(t.kind))
 const constructorZeros=lifecycle.trace.filter(t=>t.kind==='wrapperRO'&&t.zeroPhase==='constructor-initial-zero')
 const revisitZeros=lifecycle.trace.filter(t=>t.kind==='wrapperRO'&&t.zeroPhase==='revisit-hidden-zero')
 await capture()
 const result={passed:sameViewport.rawEqual&&sameViewport.savedEqual&&restoredWide.rawEqual&&restoredWide.savedEqual&&restoredWide.boundsEqual&&(!canonicalMaterialization||canonicalMaterialization.rawEqual&&canonicalMaterialization.boundsEqual),layoutContractPassed:sameViewport.rawEqual&&sameViewport.savedEqual&&restoredWide.rawEqual&&restoredWide.savedEqual&&restoredWide.boundsEqual&&(!canonicalMaterialization||canonicalMaterialization.rawEqual&&canonicalMaterialization.boundsEqual),sameViewport,canonicalMaterialization,restoredWide,lifecycle,hiddenMutations,constructorZeros,revisitZeros}
 // Report every real red dimension; never erase the constructor-zero evidence.
 if(hiddenMutations.length||!lifecycle.iframe||!lifecycle.canvas||lifecycle.counters.providerUnmounts!==0)result.passed=result.layoutContractPassed=false
 return result
}
