// Synthetic producer fixtures. Generated callbacks are an explicit producer
// action; ordinary configuration input does not automatically become source.
export const INPUT='SYNTH_CB_R1_INPUT_';
export const SOURCE='SYNTH_CB_R1_SOURCE_';
export const PUBLIC='SYNTH_CB_R1_PUBLIC_';
export const ERROR='SYNTH_CB_R1_ERROR_VALIDATION';
export const POST='SYNTH_CB_R1_POST_REJECTED';

export function makeCases(z){
 const cases=[];
 const add=(name,schema,raw,hidden,publicMarkers=[],secretPaths=[])=>cases.push({name,schema,raw,hidden,publicMarkers,secretPaths});
 const generated=marker=>new Function('value',`if (value === null) throw Error(${JSON.stringify(marker)}); return value;`);
 const value=name=>INPUT+name;
 const source=name=>SOURCE+name;
 const secret=()=>z.string().role('secret');
 add('direct',z.transform(z.string(),value=>{
  if(value==='')throw Error('SYNTH_CB_R1_SOURCE_DIRECT_INLINE');
  return value;
 }).role('secret').description('Secret boundary').extra('group','credentials'),value('DIRECT'),[source('DIRECT_INLINE'),value('DIRECT')],[],[[]]);
 add('ancestor',z.object({token:z.transform(z.string(),generated(source('ANCESTOR')))}).role('secret'),{token:value('ANCESTOR')},[source('ANCESTOR'),value('ANCESTOR')],[],[[]]);
 const ordinaryPartial=PUBLIC+'PARTIAL_CHILD';
 add('partial_parent',z.transform(z.object({token:secret(),visible:z.transform(z.string(),generated(ordinaryPartial))}),generated(source('PARTIAL_PARENT'))),{token:value('PARTIAL'),visible:'visible'},[source('PARTIAL_PARENT'),value('PARTIAL')],[ordinaryPartial],[['token']]);
 for(const kind of ['union','intersect'])for(const reverse of [false,true]){
  const name=kind+'_'+(reverse?'secret_first':'callback_first'),marker=source(name.toUpperCase());
  const callback=z.transform(z.object({token:z.string(),visible:z.string()}),generated(marker));
  const hidden=z.object({token:secret(),visible:z.string()});
  add(name,z[kind](reverse?[hidden,callback]:[callback,hidden]),{token:value(name),visible:'visible'},[marker,value(name)],[],[['token']]);
 }
 for(const reverse of [false,true]){
  const name='shared_'+(reverse?'ordinary_first':'secret_first'),marker=source(name.toUpperCase());
  const shared=z.transform(z.string(),generated(marker)),hidden=z.object({token:shared}).role('secret');
  const fields=reverse?{ordinary:shared,hidden}:{hidden,ordinary:shared};
  add(name,z.object(fields),{ordinary:'shared public value',hidden:{token:value(name)}},[marker,value(name)],[],[['hidden']]);
 }
 const opaque=z.any();
 opaque.callback={producerPayload:source('OPAQUE_ANY')};
 add('opaque_any',z.transform(opaque,generated(source('OPAQUE_BOUNDARY'))).role('secret'),{token:value('OPAQUE')},[source('OPAQUE_ANY'),source('OPAQUE_BOUNDARY'),value('OPAQUE')],[],[[]]);
 const boundary=z.any().role('secret').description('Opaque boundary title').extra('i18n',{zh:'秘密槽'});
 boundary.callback={producerPayload:source('BOUNDARY_ANY')};
 add('boundary_any',boundary,value('BOUNDARY_ANY'),[source('BOUNDARY_ANY'),value('BOUNDARY_ANY')],[],[[]]);
 add('dynamic',z.transform(z.string(),generated(source('DYNAMIC_VALUE_IN_SOURCE'))).role('secret'),value('DYNAMIC'),[source('DYNAMIC_VALUE_IN_SOURCE'),value('DYNAMIC')],[],[[]]);
 const customObject=value=>value;
 customObject.toJSON=()=>({text:source('CUSTOM_OBJECT'),nested:[source('CUSTOM_OBJECT_NESTED')]});
 add('custom_object',z.transform(z.string(),customObject).role('secret'),value('CUSTOM_OBJECT'),[source('CUSTOM_OBJECT'),source('CUSTOM_OBJECT_NESTED'),value('CUSTOM_OBJECT')],[],[[]]);
 const customString=value=>value;
 customString.toJSON=()=>source('CUSTOM_STRING_RUNTIME_PAYLOAD');
 add('custom_string',z.transform(z.string(),customString).role('secret'),value('CUSTOM_STRING'),[source('CUSTOM_STRING_RUNTIME_PAYLOAD'),value('CUSTOM_STRING')],[],[[]]);
 const expected=value('CLOSURE');
 add('closure',z.transform(z.string(),value=>{if(value!==expected)throw Error('closure mismatch');return value;}).role('secret'),expected,[expected],[],[[]]);
 const ordinary=PUBLIC+'ORDINARY_CALLBACK';
 add('ordinary',z.transform(z.string(),generated(ordinary)),'public value',[],[ordinary]);
 const publicCustom=PUBLIC+'CUSTOM_OBJECT';
 const ordinaryCustom=value=>value;ordinaryCustom.toJSON=()=>({text:publicCustom,nested:['public metadata']});
 add('ordinary_custom',z.transform(z.string(),ordinaryCustom),'public value',[],[publicCustom]);
 return cases;
}

export function makeHostSchema(z){
 const cases=makeCases(z);
 // The ordinary validation callback captures this error string; it does not
 // embed its value in source. This separates error response from source tests.
 const validationError=ERROR;
 const count=z.transform(z.number().default(1),value=>{
  if(value===13)throw Error(validationError);
  return value;
 });
 const Config=z.object({count,...Object.fromEntries(cases.map(c=>[c.name,c.schema]))});
 const raw={count:1,...Object.fromEntries(cases.map(c=>[c.name,c.raw]))};
 return {cases,Config,raw};
}
