import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
const source=await readFile(path.join(process.env.TL_PANEL_OUTPUT_ROOT,'renderer/source-shell/replica-ui/panel-interactions.js'),'utf8')
const renderer=await readFile(path.join(process.env.TL_PANEL_OUTPUT_ROOT,'renderer/source-shell/replica-ui/renderer.js'),'utf8')
const iconStart=renderer.indexOf('function createPanelExpandIcon()'),iconEnd=renderer.indexOf('function setPanelExpandControl(',iconStart)
assert.ok(iconStart>=0&&iconEnd>iconStart)
const slice=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start);return source.slice(start,end)}
function fixture(){
 const raf=[],timers=new Map();let timer=0,slotRect={left:10,top:20,width:100,height:80},gridRect={left:0,top:0,width:800,height:600},updates=0
 const make=()=>{const attrs=new Map(),classes=new Set(),listeners=new Map();return {attrs,style:{},dataset:{},children:[],isConnected:true,classList:{add(...xs){xs.forEach(x=>classes.add(x))},remove(...xs){xs.forEach(x=>classes.delete(x))},contains:x=>classes.has(x)},setAttribute(k,v){attrs.set(k,v);if(k==='style')this.style={cssText:v}},getAttribute:k=>attrs.get(k)??null,removeAttribute(k){attrs.delete(k);if(k==='style')this.style={}},append(...xs){this.children.push(...xs)},replaceChildren(...xs){this.children=xs;this.textContent=''},addEventListener(k,fn){const ls=listeners.get(k)??new Set();ls.add(fn);listeners.set(k,ls)},removeEventListener(k,fn){listeners.get(k)?.delete(fn)},emit(k,data){for(const fn of [...(listeners.get(k)??[])])fn(data)},remove(){this.isConnected=false;this.removed=true},getBoundingClientRect:()=>({...slotRect})}}
 const panel=make(),button=make(),grid={getBoundingClientRect:()=>({...gridRect}),insertBefore(slot){this.slot=slot}},header={closest:()=>panel}
 panel.setAttribute('style','color: red');panel.closest=selector=>selector==='#grid'?grid:null;panel.querySelector=()=>button
 const document={createElement:()=>make(),createElementNS:()=>make()},window={}
 const createPanelExpandIcon=new Function('document',renderer.slice(iconStart,iconEnd)+';return createPanelExpandIcon;')(document)
 const api=new Function('document','window','createPanelExpandIcon','requestAnimationFrame','setTimeout','clearTimeout','updateResizeHandles','announce',`
 const states=new Map();${slice('  function setFullscreenButton(', '  function equalTracks(')}
 ${slice('  function transitionDone(', '  function installPanel(')}
 ${slice('  const eligibleHeader =', '  function announce(')}
 ${slice('  function onPointerDown(', '  function onContextMenu(')}
 ${slice('  function onResize()', '  function start()')}
 return {states,maximize,restore,cleanupDetached,setFullscreenButton,onResize,onPointerDown,onDoubleClick};
 `)(document,window,createPanelExpandIcon,fn=>raf.push(fn),(fn)=>{timers.set(++timer,fn);return timer},id=>timers.delete(id),()=>updates++,()=>{})
 return {api,panel,button,grid,header,flushOne(){raf.shift()?.()},flush(){while(raf.length)raf.shift()()},transition(){panel.emit('transitionend',{target:panel,propertyName:'width'})},setGrid:r=>gridRect=r,setSlot:r=>slotRect=r,finishTimers(){for(const fn of [...timers.values()])fn()},get updates(){return updates}}
}
test('fullscreen control uses two rectangle SVG layers and preserves title/aria while active layer swaps',()=>{
 const f=fixture();f.api.setFullscreenButton(f.button,false);const a=f.button.children[0];assert.equal(a?.tagName??a?.getAttribute?.('viewBox'),'0 0 24 20','real control needs an SVG, not a text glyph');assert.equal(a.children.length,1);assert.equal(a.children[0].getAttribute('class'),null,'selected layer has no height-expand opacity class');assert.equal(a.children[0].children.length,2)
 const normal=a.children[0].children.map(x=>[x.getAttribute('width'),x.getAttribute('height'),x.getAttribute('stroke')]);assert.equal(normal[0][2],'var(--text-dim)');assert.equal(normal[1][2],'currentColor');assert.equal(f.button.getAttribute('aria-pressed'),'false')
 f.api.setFullscreenButton(f.button,true);const active=f.button.children[0];assert.equal(active.children[0].children[1].getAttribute('width'),normal[0][0]);assert.equal(active.children[0].children[1].getAttribute('stroke'),'currentColor');assert.equal(f.button.title,'还原面板大小');assert.equal(f.button.getAttribute('aria-label'),f.button.title)
})
test('maximize then restore in the same RAF ignores obsolete maximize geometry and restores original style',async()=>{
 const f=fixture();await f.api.maximize(f.panel,f.button);f.api.restore(f.panel);const before=f.panel.style.left;f.flushOne();assert.equal(f.panel.style.left,before,'old maximize callback cannot overwrite restore target');f.flush();f.transition();assert.equal(f.api.states.size,0);assert.equal(f.grid.slot.removed,true);assert.equal(f.panel.getAttribute('style'),'color: red');assert.equal(f.panel.style.left,undefined)
})
test('resize during maximize and queued restore uses current grid and current placeholder geometry',async()=>{
 const f=fixture();await f.api.maximize(f.panel,f.button);f.flush();f.setGrid({left:4,top:5,width:900,height:700});f.api.onResize();assert.equal(f.panel.style.width,'900px');f.api.restore(f.panel);f.setSlot({left:35,top:45,width:200,height:150});f.api.onResize();f.flush();assert.equal(f.panel.style.left,'35px','restore reads placeholder when RAF executes');f.transition();assert.equal(f.api.states.size,0)
})
test('detaching before queued RAF cleans slot and styles; obsolete callbacks cannot mutate detached panel',async()=>{
 const f=fixture();await f.api.maximize(f.panel,f.button);f.api.restore(f.panel);f.panel.isConnected=false;f.api.cleanupDetached(f.panel);assert.equal(f.panel.style.left,undefined,'detach cleanup restores inline style');f.flush();f.finishTimers();assert.equal(f.api.states.size,0);assert.equal(f.grid.slot.removed,true);assert.equal(f.panel.style.left,undefined);assert.equal(f.panel.classList.contains('pi-maximized'),false)
})
test('actual header double-click stops native propagation while interactive controls are excluded',async()=>{
 const f=fixture();let stopped=0,prevented=0;const target={closest:q=>q==='.panel-header'?f.header:null};f.api.onPointerDown({target,detail:2,stopImmediatePropagation(){stopped++}});assert.equal(stopped,1);f.api.onDoubleClick({target,preventDefault(){prevented++},stopPropagation(){stopped++}});assert.equal(prevented,1);assert.equal(f.api.states.size,1)
 f.api.onDoubleClick({target:{closest:q=>q==='.panel-header'?f.header:{}},preventDefault(){throw Error('interactive target must be excluded')},stopPropagation(){}})
})
