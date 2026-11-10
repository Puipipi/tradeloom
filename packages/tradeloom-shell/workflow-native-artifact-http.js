import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createNativeWorkflowAccess, projectNativeWorkflowRun } from './workflow-native-ui.js'
import { pairedBusinessAuthority } from './workflow-postgres.js'
import { trustedBusinessAuthority } from './business-tools.js'

export const NATIVE_ARTIFACT_COLLECTION = '/tradeloom/workflows/native/artifacts'
export const NATIVE_ARTIFACT_FILE = '/tradeloom/workflows/native/artifact'
const MAX = 32 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const fail = code => Object.assign(new Error(code), { code })
const same = (a,b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
const cordisOriginal = Symbol.for('cordis.original')
const sameService = (left,right) => (left?.[cordisOriginal] ?? left) === (right?.[cordisOriginal] ?? right)
function json(res, status, value) { res.statusCode=status; res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.end(JSON.stringify(value)) }
async function body(req) { let n=0, parts=[]; for await (const c of req) { n+=c.length; if(n>4096) throw fail('invalid_input'); parts.push(c) } try{return JSON.parse(Buffer.concat(parts))}catch{throw fail('invalid_input')} }
async function ordinary(value) {
  if(typeof value !== 'string' || !path.isAbsolute(value)) throw fail('file_unavailable')
  const full=path.resolve(value), root=path.parse(full).root
  let cursor=root
  for(const component of path.relative(root,full).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,component); const info=await lstat(cursor)
    if(info.isSymbolicLink()) throw fail('file_unavailable')
  }
  const resolved=await realpath(full); if(!same(full,resolved)) throw fail('file_unavailable')
  return resolved
}
async function mapped(fs, hostPath, signal) {
  const canonical=await ordinary(hostPath), raw=fs.processPathFromHostPath(canonical)
  if(typeof raw !== 'string' || !same(raw,canonical)) throw fail('file_unavailable')
  const target=await fs.resolve(raw,{signal})
  if(!same(fs.processPath(target),canonical)) throw fail('file_unavailable')
  return canonical
}
function inside(root,file) { const r=path.relative(root,file); return r!=='' && r!=='..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r) }
function backend(ctx, method, pathname, payload, contentType, signal, cap=MAX) {
  const paired=ctx.webServer?.host && ctx.webServer?.port ? {host:ctx.webServer.host,port:Number(ctx.webServer.port)} : undefined
  const auth=paired ? pairedBusinessAuthority(ctx.webServer,paired) : trustedBusinessAuthority(ctx.webServer)
  const key=process.env.TRADELOOM_NATIVE_BRIDGE_KEY
  if(!/^[a-f0-9]{64}$/.test(key ?? '')) throw fail('service_unavailable')
  return new Promise((resolve,reject)=>{
    const headers={host:auth.hostHeader,origin:auth.origin,'x-tradeloom-native-bridge':key,accept:'application/json'}
    if(payload) { headers['content-type']=contentType; headers['content-length']=String(payload.length) }
    const request=http.request({hostname:'127.0.0.1',port:Number(process.env.TRADELOOM_DJANGO_PORT ?? 3090),path:pathname,method,headers,signal},response=>{
      let n=0, parts=[]; response.on('data',chunk=>{n+=chunk.length;if(n>cap){request.destroy(fail('too_large'));return}parts.push(chunk)})
      response.on('error',reject); response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,data:Buffer.concat(parts)}))
    })
    const timeout=setTimeout(()=>request.destroy(fail('service_unavailable')),30_000)
    request.on('close',()=>clearTimeout(timeout));request.on('error',reject); if(payload)request.end(payload);else request.end()
  })
}
function safeVersion(value, runId) {
  if(!value || !UUID.test(value.id ?? '') || value.runId !== runId || typeof value.nodeId !== 'string' || !Number.isSafeInteger(value.attempt)
    || !value.source || typeof value.source.sessionId !== 'string' || !Number.isSafeInteger(value.source.seq) || !Number.isSafeInteger(value.source.index)
    || !['ready','unavailable'].includes(value.availability) || typeof value.name !== 'string' || !value.name || value.name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(value.name) || typeof value.mimeType !== 'string'
    || typeof value.source.callId !== 'string' || !value.source.callId || !Number.isSafeInteger(value.source.turn) || value.source.turn < 1
    || !Number.isSafeInteger(value.byteSize) || value.byteSize < 0 || value.byteSize > MAX || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) throw fail('service_unavailable')
  const result={id:value.id,runId,nodeId:value.nodeId,attempt:value.attempt,name:value.name,mimeType:value.mimeType,byteSize:value.byteSize,sha256:value.sha256,
    source:{sessionId:value.source.sessionId,seq:value.source.seq,index:value.source.index,callId:value.source.callId,turn:value.source.turn},availability:value.availability}
  if(value.availability==='ready') {
    result.previewSupported = typeof value.previewSupported === 'boolean' ? value.previewSupported : null
    const query=new URLSearchParams({runId,id:value.id,action:'download'}); result.downloadUrl=`${NATIVE_ARTIFACT_FILE}?${query}`
    if(value.previewSupported === true) { query.set('action','preview'); result.previewUrl=`${NATIVE_ARTIFACT_FILE}?${query}` }
    else if(value.previewSupported === false) result.reason='preview_unsupported'
  } else result.reason='file_unavailable'
  return result
}
export function createNativeArtifactHandler(ctx, dependencies={}) {
  const access=dependencies.access ?? createNativeWorkflowAccess(ctx)
  const send=dependencies.backend ?? ((...args)=>backend(ctx,...args))
  const active=new Set(); let disposed=false
  const get = name => ctx.get?.(name)
  async function owned(runId,signal,expected) {
    if(disposed || signal.aborted || !UUID.test(runId ?? '')) throw fail('unavailable')
    const parent=await access.center(); if(signal.aborted || disposed || expected && parent!==expected.parent) throw fail('unavailable')
    const run=await access.tool('get',{runId},parent,signal,randomUUID())
    if(signal.aborted || disposed || await access.center()!==parent || run?.id!==runId || run.parentAgentId!==parent.id || run.sessionId!==parent.session?.id) throw fail('unavailable')
    const projection=projectNativeWorkflowRun(run)
    if(expected && (run.bindingRevision!==expected.run.bindingRevision || run.definitionRevision!==expected.run.definitionRevision)) throw fail('unavailable')
    return {parent,run,projection}
  }
  function item(context,input) {
    const node=context.projection.nodes.find(n=>n.id===input.nodeId && n.attempt===input.attempt)
    if(!node?.settled || node.terminalReceipt?.source!=='subagent/end' || node.artifactState!=='declared') throw fail('source_unavailable')
    const matches=node.artifactEvidence.declarations.filter(d=>d.sourceSessionSeq===input.sourceSessionSeq && d.fileIndex===input.fileIndex)
    if(matches.length!==1) throw fail('source_unavailable')
    return {node, declaration:matches[0]}
  }
  async function verifyEvent(context,input,signal) {
    const {node,declaration}=item(context,input), query=get('sessionQuery'); if(!query?.readEvent) throw fail('service_unavailable')
    const result=await query.readEvent({sessionId:node.childId,seq:input.sourceSessionSeq,before:0,after:0},signal)
    if(signal.aborted || disposed || !sameService(get('sessionQuery'),query)) throw fail('unavailable')
    const data=result?.target?.data, file=data?.files?.[input.fileIndex]
    if(result?.target?.seq!==input.sourceSessionSeq || result?.session?.id!==node.childId || result?.target?.type!=='deliverables/presented' || data?.callId!==declaration.presentCallId || data?.turn!==declaration.sourceTurn || file?.path!==declaration.path || (file?.description ?? null)!==(declaration.description ?? null)) throw fail('source_unavailable')
    return {node,declaration,session:result.session}
  }
  async function handle(req,res) {
    if(typeof ctx.connection?.requestRejection !== 'function'){json(res,503,{ok:false,reason:'unavailable'});return}
    const rejection=ctx.connection.requestRejection(req); if(rejection!==undefined){json(res,rejection,{ok:false,reason:'unavailable'});return}
    const controller=new AbortController();active.add(controller);const signal=controller.signal
    const abort=()=>controller.abort(); const onReq=()=>{if(!req.complete && !req.readableEnded)abort()};const onRes=()=>{if(!res.writableEnded)abort()}
    req.on?.('aborted',abort);req.on?.('close',onReq);res.on?.('close',onRes)
    try {
      const url=new URL(req.url,'http://local'), collection=url.pathname===NATIVE_ARTIFACT_COLLECTION
      if(collection && req.method==='POST') {
        const input=await body(req)
        if(!input || Object.keys(input).sort().join(',')!=='attempt,fileIndex,nodeId,runId,sourceSessionSeq' || !UUID.test(input.runId ?? '') || typeof input.nodeId!=='string' || !input.nodeId || !Number.isSafeInteger(input.attempt) || input.attempt<1 || !Number.isSafeInteger(input.sourceSessionSeq) || input.sourceSessionSeq<0 || !Number.isSafeInteger(input.fileIndex) || input.fileIndex<0) throw fail('invalid_input')
        let state=await owned(input.runId,signal), first=await verifyEvent(state,input,signal); state=await owned(input.runId,signal,state)
        const picker=get('directoryPicker'), fs=get('fs'), files=get('workspaceFiles'); const capability=picker?.capability?.()
        if(capability?.kind!=='native' || typeof capability.pick!=='function' || !fs?.resolve || !fs?.processPathFromHostPath || !files?.stat || !files?.readBytes) throw fail('service_unavailable')
        const fresh=()=>{if(signal.aborted || disposed || !sameService(get('directoryPicker'),picker) || !sameService(get('fs'),fs) || !sameService(get('workspaceFiles'),files)) throw fail('unavailable')}
        const chosen=await capability.pick(signal); if(!chosen) throw fail('cancelled')
        fresh()
        state=await owned(input.runId,signal,state); fresh(); const second=await verifyEvent(state,input,signal)
        if(JSON.stringify(first.declaration)!==JSON.stringify(second.declaration) || first.node.childId!==second.node.childId || first.session?.cwd!==second.session?.cwd) throw fail('source_unavailable')
        const root=await mapped(fs,chosen,signal); state=await owned(input.runId,signal,state); fresh()
        const cwd=second.session?.cwd ?? get('sandboxPolicy')?.workspaceRoot
        const nativeCwd=await mapped(fs,cwd,signal); state=await owned(input.runId,signal,state); fresh()
        const candidate=path.isAbsolute(second.declaration.path) ? second.declaration.path : path.resolve(nativeCwd,second.declaration.path)
        const file=await mapped(fs,candidate,signal); if(!inside(root,file)) throw fail('file_unavailable')
        state=await owned(input.runId,signal,state); fresh()
        if(typeof dependencies.authorizeImport !== 'function') throw fail('authorization_unavailable')
        const consent=await dependencies.authorizeImport(Object.freeze({runId:input.runId,nodeId:input.nodeId,attempt:input.attempt,
          sourceSessionSeq:input.sourceSessionSeq,fileIndex:input.fileIndex,childSessionId:second.node.childId,
          presentCallId:second.declaration.presentCallId,sourceTurn:second.declaration.sourceTurn,
          parentAgentId:state.parent.id,parentSessionId:state.parent.session.id,root,file}),signal)
        if(consent !== 'allowed-once') throw fail('authorization_unavailable')
        fresh(); state=await owned(input.runId,signal,state); fresh(); const confirmed=await verifyEvent(state,input,signal)
        if(JSON.stringify(confirmed.declaration)!==JSON.stringify(first.declaration) || confirmed.node.childId!==first.node.childId || confirmed.session?.cwd!==first.session?.cwd
          || !same(await mapped(fs,candidate,signal),file) || !same(await mapped(fs,chosen,signal),root)) throw fail('source_unavailable')
        fresh(); state=await owned(input.runId,signal,state); fresh(); const scope={sessionId:second.node.childId,workspaceRoot:cwd}
        const before=await files.stat(scope,second.declaration.path,signal)
        if(!before || !same(before.absolutePath,file) || typeof before.version!=='string' || (before.bytes !== undefined && (!Number.isSafeInteger(before.bytes) || before.bytes<0 || before.bytes>MAX))) throw fail(before?.bytes>MAX?'too_large':'file_unavailable')
        state=await owned(input.runId,signal,state); fresh()
        const bytes=await files.readBytes(scope,second.declaration.path,{},signal)
        if(!(bytes?.data instanceof Uint8Array) || !bytes.eof || bytes.offset!==0 || (before.bytes !== undefined && bytes.data.length!==before.bytes) || (bytes.bytes !== undefined && bytes.bytes!==bytes.data.length) || bytes.data.length>MAX || bytes.version!==before.version || !same(bytes.absolutePath,file)) throw fail('file_unavailable')
        state=await owned(input.runId,signal,state); fresh(); const after=await files.stat(scope,second.declaration.path,signal)
        if(!after || after.version!==before.version || (before.bytes !== undefined && after.bytes !== undefined && after.bytes!==before.bytes) || (after.bytes !== undefined && after.bytes!==bytes.data.length) || !same(after.absolutePath,file) || !same(await mapped(fs,candidate,signal),file) || !same(await mapped(fs,chosen,signal),root)) throw fail('file_unavailable')
        fresh(); state=await owned(input.runId,signal,state); fresh(); const last=await verifyEvent(state,input,signal)
        if(JSON.stringify(last.declaration)!==JSON.stringify(first.declaration) || last.node.childId!==first.node.childId || last.session?.cwd!==first.session?.cwd) throw fail('source_unavailable')
        const grant={sessionId:first.node.childId,runId:input.runId,nodeId:input.nodeId,attempt:input.attempt,sourceSessionSeq:input.sourceSessionSeq,fileIndex:input.fileIndex,authorized:true,rootScope:createHash('sha256').update(root,'utf8').digest('hex')}
        const meta=JSON.stringify({...input,grant}), boundary=`tradeloom-${randomUUID()}`
        const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="artifact"\r\nContent-Type: application/octet-stream\r\n\r\n`),Buffer.from(bytes.data),Buffer.from(`\r\n--${boundary}--\r\n`)])
        fresh(); state=await owned(input.runId,signal,state); fresh()
        const response=await send('POST','/api/native-artifacts',payload,`multipart/form-data; boundary=${boundary}`,signal,64*1024)
        state=await owned(input.runId,signal,state); fresh(); const finalEvent=await verifyEvent(state,input,signal)
        if(JSON.stringify(finalEvent.declaration)!==JSON.stringify(first.declaration) || finalEvent.node.childId!==first.node.childId || finalEvent.session?.cwd!==first.session?.cwd) throw fail('source_unavailable')
        if(![200,201].includes(response.status)) throw fail('service_unavailable')
        fresh(); const value=JSON.parse(response.data.toString('utf8'))
        if(value.nodeId!==input.nodeId || value.attempt!==input.attempt || value.source?.sessionId!==first.node.childId || value.source?.seq!==input.sourceSessionSeq || value.source?.index!==input.fileIndex || value.source?.callId!==first.declaration.presentCallId || value.source?.turn!==first.declaration.sourceTurn || value.byteSize!==bytes.data.length || value.sha256!==createHash('sha256').update(bytes.data).digest('hex')) throw fail('service_unavailable')
        json(res,200,{ok:true,version:safeVersion(value,input.runId)}); return
      }
      if(collection && req.method==='GET') {
        const runId=url.searchParams.get('runId'), offset=url.searchParams.get('offset') ?? '0'
        if([...url.searchParams.keys()].some(k=>!['runId','offset'].includes(k)) || url.searchParams.getAll('runId').length!==1 || url.searchParams.getAll('offset').length>1 || !UUID.test(runId ?? '') || !/^\d{1,15}$/.test(offset)) throw fail('invalid_input')
        let state=await owned(runId,signal); const query=new URLSearchParams({runId,parentAgentId:state.parent.id,parentSessionId:state.parent.session.id,offset})
        const response=await send('GET',`/api/native-artifacts?${query}`,null,null,signal,256*1024); state=await owned(runId,signal,state)
        if(response.status!==200) throw fail('service_unavailable');const data=JSON.parse(response.data.toString('utf8'))
        if(data.runId!==runId || !Array.isArray(data.items) || data.items.length>10 || !(data.nextOffset===null || (Number.isSafeInteger(data.nextOffset) && data.nextOffset===Number(offset)+10 && data.items.length===10))) throw fail('service_unavailable')
        json(res,200,{ok:true,items:data.items.map(v=>safeVersion(v,runId)),nextOffset:data.nextOffset});return
      }
      if(url.pathname===NATIVE_ARTIFACT_FILE && req.method==='GET') {
        const runId=url.searchParams.get('runId'), id=url.searchParams.get('id'), action=url.searchParams.get('action')
        if([...url.searchParams.keys()].some(k=>!['runId','id','action'].includes(k)) || ['runId','id','action'].some(k=>url.searchParams.getAll(k).length!==1) || !UUID.test(runId ?? '') || !UUID.test(id ?? '') || !['preview','download'].includes(action)) throw fail('invalid_input')
        let state=await owned(runId,signal);const response=await send('GET',`/api/native-artifacts/${runId}/${id}/${action}`,null,null,signal,MAX)
        state=await owned(runId,signal,state);if(response.status!==200) throw fail(response.status===415?'preview_unsupported':'file_unavailable')
        const type=String(response.headers['content-type'] ?? 'application/octet-stream').split(';')[0].toLowerCase()
        if(action==='preview' && !['text/plain','image/png','image/jpeg'].includes(type)) throw fail('preview_unsupported')
        res.statusCode=200;res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('content-security-policy',"sandbox; default-src 'none'; img-src data:; style-src 'none'")
        res.setHeader('content-type',action==='preview'?type:'application/octet-stream');res.setHeader('content-disposition',action==='preview'?'inline':'attachment');res.end(response.data);return
      }
      throw fail('invalid_input')
    } catch(error) {
      if(!res.headersSent && !res.destroyed) {const allowed=new Set(['invalid_input','cancelled','too_large','source_unavailable','file_unavailable','preview_unsupported','service_unavailable','authorization_unavailable','unavailable']);const reason=allowed.has(error?.code)?error.code:'unavailable';json(res,reason==='invalid_input'?400:reason==='preview_unsupported'?415:503,{ok:false,reason})}
    } finally {active.delete(controller);req.off?.('aborted',abort);req.off?.('close',onReq);res.off?.('close',onRes)}
  }
  return {handle,dispose(){disposed=true;for(const controller of active)controller.abort();active.clear()}}
}
