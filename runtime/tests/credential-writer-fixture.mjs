import {pathToFileURL} from 'node:url';
const p=process.env.DSH_PREFIX;
const {Context}=await import(pathToFileURL(`${p}/node_modules/@deepseek-ai/cordis/lib/index.js`));
const {LocalCredentialProvider}=await import(pathToFileURL(`${p}/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js`));
const ctx=new Context();const plugin=ctx.plugin(LocalCredentialProvider,{path:process.argv[2],watch:false});
await plugin.await();await ctx.credentials.set('SYNTHETIC_B','synthetic-b');await plugin.dispose();await ctx.fiber.dispose();
