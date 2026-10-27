import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'

// Execute the real component handlers with deterministic state hooks. Browser focus,
// layout and asynchronous polling are checked by the batch7 Electron fixture.
async function canvas() {
  const states=[];let cursor=0,registration,tree;const requests=[]
  const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(v=>v!==null&&v!==undefined&&v!==false)}),
    useState:initial=>{const i=cursor++;if(!states[i])states[i]={value:typeof initial==='function'?initial():initial};const state=states[i];return [state.value,next=>{state.value=typeof next==='function'?next(state.value):next}]},
    useRef:value=>{const i=cursor++;if(!states[i])states[i]={current:value};return states[i]},useCallback:fn=>fn,useEffect:()=>{}}
  await readFile(new URL('../client.workflow.js',import.meta.url),'utf8').then(source=>runInNewContext(source,{window:{__ModuleLoader__:{load:r=>{registration=r}}},fetch:(...args)=>{requests.push(args);throw new Error('Unexpected network request')}}))
  const {WorkflowCanvas}=registration.factory(()=>React)
  const doc={id:'doc-one',title:'草稿测试',confirmed:true,source:'manual',nodes:[{id:'agent-one',kind:'agent',title:'原名称',instruction:'原说明',agent:'unlisted-agent',model:{provider:'unlisted-provider',model:'retained-model'},position:{x:40,y:60}}],edges:[]}
  const initial={doc,catalog:{kinds:[],agents:[]},list:[doc],selected:'agent-one'}
  const render=()=>{cursor=0;tree=WorkflowCanvas({initial});return tree}
  const all=(node=tree)=>node&&typeof node==='object'?[node,...node.children.flatMap(child=>all(child))]:[]
  const text=node=>typeof node==='string'?node:(node?.children??[]).map(text).join('')
  const find=predicate=>all().find(predicate)
  const click=label=>{find(node=>node.type==='button'&&text(node)===label).props.onClick();render()}
  const change=(label,value)=>{find(node=>node.type==='label'&&node.children[0]===label).children.find(node=>typeof node==='object').props.onChange({target:{value}});render()}
  render()
  return {doc,states,requests,render,find,click,change,text}
}

test('node editor cancel preserves document, unknown identifiers and clean save state',async()=>{
 const c=await canvas();const original=JSON.stringify(c.doc)
 assert(c.find(n=>n.type==='option'&&n.props.value==='unlisted-agent'))
 assert(c.find(n=>n.type==='option'&&n.props.value==='unlisted-provider\0retained-model'))
 c.change('名称','待取消名称');c.change('说明','待取消说明');c.click('取消')
 assert.equal(JSON.stringify(c.doc),original)
 assert(c.find(n=>n.type==='strong'&&c.text(n)==='原名称'))
 assert(c.find(n=>n.type==='button'&&c.text(n)==='保存'))
 assert(!c.find(n=>n.props.role==='dialog'));assert.equal(c.requests.length,0)
})

test('node editor applies only local editable fields and preserves agent/model/position',async()=>{
 const c=await canvas();const original=JSON.stringify(c.doc)
 c.change('名称','本地名称');c.change('说明','本地说明');c.click('应用到草稿')
 assert.equal(JSON.stringify(c.doc),original,'initial document is never mutated')
 const edited=c.states.find(state=>state.value?.id==='doc-one').value.nodes[0]
 assert.equal(edited.title,'本地名称');assert.equal(edited.instruction,'本地说明');assert.equal(edited.agent,'unlisted-agent')
 assert.equal(JSON.stringify(edited.model),JSON.stringify(c.doc.nodes[0].model));assert.equal(JSON.stringify(edited.position),JSON.stringify(c.doc.nodes[0].position))
 assert(c.find(n=>n.type==='button'&&c.text(n)==='保存*'));assert(c.find(n=>n.props.className==='tl-wf-message'&&c.text(n).includes('尚未保存')))
 assert.equal(c.requests.length,0,'apply does not POST or persist')
})

for(const condition of ['workflow changed','node removed'])test(`stale node editor refuses apply when ${condition}`,async()=>{
 const c=await canvas();c.change('名称','绝不能覆盖')
 const docState=c.states.find(state=>state.value?.id==='doc-one')
 docState.value=condition==='workflow changed'?{...c.doc,id:'doc-two'}:{...c.doc,nodes:[]}
 c.render();c.click('应用到草稿')
 assert(!c.find(n=>n.props.role==='dialog'))
 assert(c.find(n=>n.props.className==='tl-wf-message'&&c.text(n).includes('未应用草稿')))
 assert.equal(docState.value.nodes[0]?.title,condition==='workflow changed'?'原名称':undefined)
 assert.equal(c.requests.length,0)
})
