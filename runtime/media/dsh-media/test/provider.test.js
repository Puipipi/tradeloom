import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PROVIDERS, buildProviderCreate, buildProviderQuery, normalizeProviderImage, normalizeProviderCreated, normalizeProviderTask } from '../src/provider-protocol.js';
import { createProviderClient } from '../src/provider-client.js';
const input = name => ({ model: PROVIDERS[name].model, prompt: '合成协议夹具', ...(name.endsWith('video') ? { duration: 5, resolution: '720p', ratio: '16:9', ...(name === 'ark-video' ? { generateAudio: false } : { promptExtend: false }) } : { n: 1, size: name === 'ali-qwen-image' ? '1024x1024' : '2048x2048', ...(name === 'ark-image' ? { responseFormat: 'url' } : {}) }) });
const target = { baseUrl: 'https://ark.cn-beijing.volces.com', apiKey: 'synthetic-key' };
const url = 'https://example.com/synthetic-output?signature=private';
for (const name of Object.keys(PROVIDERS)) {
  test(`${name}: exact model/parameters; reject unknown fields and unsupported choice`, () => {
    const req = buildProviderCreate(name, input(name));
    assert.equal(req.path, PROVIDERS[name].path); assert.equal(req.method, 'POST');
    assert.equal(req.body.model, PROVIDERS[name].model);
    for (const change of [{ model: 'latest' }, { prompt: '' }, { prompt: 'x'.repeat(4097) }, { extra: true }, name.endsWith('video') ? { duration: 6 } : { n: 2 }, name.endsWith('video') ? { resolution: '1080p' } : { size: 'auto' }]) assert.throws(() => buildProviderCreate(name, { ...input(name), ...change }), { code: 'invalid_request' });
  });
}
test('protocols have independent exact request shapes', () => {
 assert.deepEqual(buildProviderCreate('ark-image',input('ark-image')).body,{model:PROVIDERS['ark-image'].model,prompt:'合成协议夹具',size:'2048x2048',sequential_image_generation:'disabled',response_format:'url'});
 assert.deepEqual(buildProviderCreate('ali-qwen-image',input('ali-qwen-image')).headers,{});
 assert.deepEqual(buildProviderCreate('ali-wan-image',input('ali-wan-image')).body,{model:'wan2.7-image',input:{messages:[{role:'user',content:[{text:'合成协议夹具'}]}]},parameters:{n:1,size:'2048*2048',enable_sequential:false}});
 assert.equal(buildProviderCreate('ali-video',input('ali-video')).headers['X-DashScope-Async'],'enable');
 assert.equal(buildProviderCreate('ali-video',input('ali-video')).body.parameters.resolution,'720P');
 assert.throws(()=>buildProviderCreate('ali-video',{...input('ali-video'),promptExtend:true}));
 assert.throws(()=>buildProviderCreate('ark-video',{...input('ark-video'),generateAudio:'false'}));
 assert.equal(buildProviderQuery('ali-video','task-1').path,'/api/v1/tasks/task-1');
 assert.throws(()=>buildProviderQuery('ark-video','../other'));
});
test('images: URL/base64/native choices; reject partial errors and ambiguous counts',()=>{
 assert.equal(normalizeProviderImage('ark-image',{data:[{url}]}).source.value,url);
 assert.equal(normalizeProviderImage('ark-image',{data:[{b64_json:'YQ=='}]}).source.type,'base64');
 assert.equal(normalizeProviderImage('ali-qwen-image',{data:[{url}]}).source.type,'url');
 assert.equal(normalizeProviderImage('ali-wan-image',{output:{choices:[{message:{content:[{image:url}]}}]}}).source.value,url);
 for(const data of [[],[{url},{error:{message:'sensitive'}}],[{url,b64_json:'YQ=='}],[{error:{message:'sensitive'}}],[{url:'http://127.0.0.1/x'}],[{b64_json:'Y==='}]])assert.throws(()=>normalizeProviderImage('ark-image',{data}));
 assert.throws(()=>normalizeProviderImage('ali-wan-image',{output:{results:[{url}]}}));
});
for(const [name,states] of [['ark-video',['queued','running','cancelled','succeeded','failed','expired']],['ali-video',['PENDING','RUNNING','SUCCEEDED','FAILED','CANCELED','UNKNOWN']]]) {
 for(const status of states)test(`${name} status ${status}`,()=>{
  const value=name==='ark-video'?{id:'task-1',status,content:{video_url:url},...(status==='failed'?{error:{message:'sensitive'}}:{})}:{output:{task_id:'task-1',task_status:status,video_url:url}};
  const r=normalizeProviderTask(name,'task-1',value); assert.ok(r.state);assert.equal(!!r.source,status.toLowerCase()==='succeeded'); assert.ok(!JSON.stringify(r).includes('sensitive'));
 });
}
test('task receipts, query identities and unknown new states are strict',()=>{
 assert.deepEqual(normalizeProviderCreated('ark-video',{id:'task-1'}),{kind:'video-task',taskId:'task-1'});
 assert.equal(normalizeProviderCreated('ali-video',{output:{task_id:'task-1',task_status:'PENDING'}}).state,'queued');
 for(const value of [{id:'other',status:'queued'},{id:'task-1',status:'NEW'},{id:'task-1',status:'succeeded'}])assert.throws(()=>normalizeProviderTask('ark-video','task-1',value));
});
test('official origins only and pre-abort does not invoke transport',async()=>{
 let count=0;const client=createProviderClient({transport:async()=>{count++;throw Error();}});
 for(const baseUrl of ['https://example.com','https://ark.cn-beijing.volces.com/path','https://ark.cn-beijing.volces.com?key=x','http://127.0.0.1:123'])await assert.rejects(()=>client.create('ark-video',input('ark-video'),{...target,baseUrl}));
 const ac=new AbortController();ac.abort();assert.equal((await client.create('ark-video',input('ark-video'),target,{signal:ac.signal})).outcome,'not_submitted');assert.equal(count,0);
});
for(const [status,body,expected] of [[503,'sensitive','submission_unknown'],[408,'sensitive','submission_unknown'],[302,'sensitive','submission_unknown'],[429,'sensitive','rejected'],[409,'sensitive','rejected'],[200,'not-json','submission_unknown'],[200,'{}','submission_unknown']])test(`single POST ${status}/${expected}`,async()=>{
 let calls=0;const c=createProviderClient({transport:async()=>{calls++;return {status,body:Buffer.from(body)}}});const r=await c.create('ark-video',input('ark-video'),target);assert.equal(r.outcome,expected);assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes('sensitive'));assert.equal(r.refund,undefined);
});
test('disconnect, timeout and late aborted POST never publish or retry',async()=>{
 for(const transport of [async()=>{throw Error('credential private URL')},async(_url,{signal})=>{await new Promise(r=>setTimeout(r,15));assert.ok(signal.aborted);return{status:200,body:Buffer.from('{"id":"task-1"}')}}]) {
  const r=await createProviderClient({transport}).create('ark-video',input('ark-video'),{...target,timeoutMs:1});assert.equal(r.outcome,'submission_unknown');assert.equal(r.result,undefined);
 }
});
test('query 404/UNKNOWN never create another task or imply refund',async()=>{
 let calls=[];const c=createProviderClient({transport:async(_url,opt)=>{calls.push(opt.method);return{status:404,body:Buffer.from('sensitive')}}});
 assert.equal((await c.query('ark-video','task-1',target)).outcome,'query_failed');assert.deepEqual(calls,['GET']);
 assert.equal(normalizeProviderTask('ali-video','task-1',{output:{task_id:'task-1',task_status:'UNKNOWN'}}).state,'unknown');
});
test('actual loopback HTTP captures all five official-shaped synthetic requests; bounds/redirects',async()=>{
 const seen=[];let response={status:200,body:{id:'task-1'}};
 const server=createServer(async(req,res)=>{let chunks=[];for await(const c of req)chunks.push(c);seen.push({method:req.method,path:req.url,body:Buffer.concat(chunks).length?JSON.parse(Buffer.concat(chunks)):null,async:req.headers['x-dashscope-async'],authPresent:!!req.headers.authorization});res.writeHead(response.status,{'content-type':'application/json',...(response.status===302?{location:'http://127.0.0.1:1/never'}:{})});res.end(JSON.stringify(response.body));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try {
  const c=createProviderClient({allowLoopback:true});const local={baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'synthetic-key'};
  for(const name of Object.keys(PROVIDERS)) {
   response.body=name==='ark-video'?{id:'task-1'}:name==='ali-video'?{output:{task_id:'task-1',task_status:'PENDING'}}:name==='ali-wan-image'?{output:{choices:[{message:{content:[{image:url}]}}]}}:{data:[{url}]};
   assert.equal((await c.create(name,input(name),local)).outcome,'ok');assert.equal(seen.at(-1).path,PROVIDERS[name].path);
  }
  response.body={id:'task-1',status:'succeeded',content:{video_url:url}};assert.equal((await c.query('ark-video','task-1',local)).result.state,'succeeded');
  response.body={output:{task_id:'task-1',task_status:'UNKNOWN'}};assert.equal((await c.query('ali-video','task-1',local)).result.state,'unknown');
  response={status:302,body:{}};assert.equal((await c.create('ark-video',input('ark-video'),local)).outcome,'submission_unknown');
  response={status:200,body:{padding:'x'.repeat(500)}};assert.equal((await c.create('ark-video',input('ark-video'),{...local,maxResponseBytes:20})).outcome,'submission_unknown');
  assert.equal(seen.length,9);
  console.log('LOCAL_HTTP_SYNTHETIC_CAPTURE '+JSON.stringify(seen));
 }finally{await new Promise(r=>server.close(r));}
});
