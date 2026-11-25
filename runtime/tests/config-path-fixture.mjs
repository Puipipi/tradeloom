import z from '__PREFIX__/node_modules/@deepseek-ai/schemastery/lib/index.mjs';
export const name='wave10-config-fixture';
export const Config=z.object({
  ordinary:z.string().default('ordinary-old').description('普通字段'),
  live:z.string().default('live-old').volatile().description('在线字段'),
  secret:z.string().role('secret'),
  fail:z.boolean().default(false),
});
export function apply(ctx,config){
  const history=globalThis[Symbol.for('wave10.config.history')]??=[];
  history.push({event:'mount',ordinary:config.ordinary,live:config.live.get(),uid:ctx.fiber.uid});
  if(config.fail)throw new Error('wave10 requested fixture activation failure');
  ctx.effect(()=>()=>history.push({event:'dispose',uid:ctx.fiber.uid}));
}
