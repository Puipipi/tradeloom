import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
const {JSDOM}=createRequire(import.meta.url)(process.env.TRADELOOM_DOM_MODULE)
const source=await readFile(new URL('../../static/workbench/run-filters.js',import.meta.url),'utf8')
function fixture(statuses){
 const dom=new JSDOM('<!doctype html><div data-neighbor>保留相邻面板</div><section data-run-records><div data-run-filters hidden></div><p data-run-filter-summary hidden></p><p data-run-filter-empty hidden></p><table id="run-records-table"><tbody></tbody></table></section>',{runScripts:'outside-only'})
 const {document}=dom.window
 for(const status of statuses){const row=document.createElement('tr');row.dataset.runStatus=status;row.innerHTML='<td><details open><summary>运行 ID</summary>固定身份</details></td>';document.querySelector('tbody').appendChild(row)}
 dom.window.eval(source)
 return {dom,document,rows:[...document.querySelectorAll('tr')],click:key=>document.querySelector(`[data-run-filter="${key}"]`).click()}
}
test('filters only loaded rows, keeps unknown statuses and restores existing row/details identity',()=>{
 const f=fixture(['running','queued','completed','cancelled','failed','unavailable','future-value'])
 try{assert.equal(f.document.querySelector('[data-run-filter="all"]').textContent,'全部 · 7');assert.equal(f.document.querySelector('[data-run-filter="ended"]').textContent,'已结束 · 2');f.click('attention');assert.deepEqual(f.rows.map(r=>r.hidden),[true,true,true,true,false,false,true]);f.click('other');assert.equal(f.rows[6].hidden,false);assert.equal(f.rows.filter(r=>!r.hidden).length,1);f.click('all');assert.ok(f.rows.every(r=>!r.hidden));assert.equal(f.document.querySelector('tbody').firstElementChild,f.rows[0]);assert.ok(f.rows.every(r=>r.querySelector('details').open));assert.equal(f.document.querySelector('[data-neighbor]').textContent,'保留相邻面板');assert.equal(f.document.querySelector('[data-run-filter-summary]').textContent,'当前已加载 7 条，筛选后 7 条')}finally{f.dom.window.close()}
})
test('zero rows keep fallback untouched; unknown status is literal data, not injected markup',()=>{
 const empty=fixture([]);try{assert.equal(empty.document.querySelector('[data-run-filters]').hidden,true)}finally{empty.dom.window.close()}
 const f=fixture(['<img src=x onerror=alert(1)>']);try{assert.equal(f.document.querySelector('[data-run-filter="other"]').textContent,'其他状态 · 1');assert.equal(f.document.querySelectorAll('img').length,0);f.click('other');assert.equal(f.rows[0].hidden,false);assert.equal(f.document.querySelector('[data-run-filter="other"]').getAttribute('aria-pressed'),'true')}finally{f.dom.window.close()}
})
