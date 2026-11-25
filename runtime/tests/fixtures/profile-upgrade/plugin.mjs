import z from '__PREFIX__/node_modules/@deepseek-ai/schemastery/lib/index.mjs';
export const name = 'profile-upgrade-fixture';
export const Config = z.object({
  ordinary: z.string().default('initial'),
  live: z.string().default('initial-live').volatile(),
});
export function apply() {}
