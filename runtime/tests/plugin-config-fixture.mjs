import z from '__PREFIX__/node_modules/@deepseek-ai/schemastery/lib/index.mjs';
export const name='wave10-config-fixture';
const branchDefault=[{secret:'SYNTHETIC_BRANCH_DEFAULT',visible:'visible-branch'}];
const ordinaryRows=z.array(z.object({secret:z.string().default('SYNTHETIC_BRANCH_DEFAULT'),visible:z.string().default('visible-branch')})).default(branchDefault).extra('examples',[branchDefault]).description('Ordinary rows').extra('group','network').extra('i18n',{zh:'行配置',en:'Rows'});
const secretRows=z.array(z.object({secret:z.string().role('secret'),visible:z.string()}));
export const Config=z.object({
  ordinary:z.string().default('ordinary-old').description('普通字段'),
  live:z.string().default('live-old').volatile().description('在线字段'),
  secret:z.string().role('secret'),
  unionSecret:z.union([z.transform(z.string().role('secret'),v=>v),z.string()]).default('SYNTHETIC_UNION'),
  constantSecret:z.const('SYNTHETIC_CONSTANT').role('secret'),
  composite:z.intersect([z.object({left:z.string().default('left')}),z.object({right:z.string().role('secret').default('SYNTHETIC_INTERSECT')})]).default({}),
  rows:z.union([ordinaryRows,secretRows]).default(branchDefault),
  dictRows:z.union([z.dict(z.string().default('SYNTHETIC_DICT_DEFAULT')),z.object({secret:z.string().role('secret')})]).default({secret:'SYNTHETIC_DICT_DEFAULT',visible:'visible-dict'}),
  count:z.number().default(7),
  nested:z.object({visible:z.string().default('nested'),secret:z.string().role('secret').default('SYNTHETIC_SCHEMA_SECRET')}).default({}),
  items:z.array(z.string()).default(['first','second']),
  fail:z.boolean().default(false),
});
export function apply(ctx,config){
  if(globalThis[Symbol.for('wave10.failRecovery')]&&!config.fail)throw new Error('fixture restore failure');
  const history=globalThis[Symbol.for('wave10.config.history')]??=[];
  history.push({event:'mount',ordinary:config.ordinary,live:config.live.get(),uid:ctx.fiber.uid});
  if(config.fail)throw new Error('wave10 requested fixture activation failure');
  ctx.effect(()=>()=>history.push({event:'dispose',uid:ctx.fiber.uid}));
}
