import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const prefix=process.env.FIXTURE_DSH_PREFIX;
const {runCli}=await import(pathToFileURL(join(prefix,'node_modules/@deepseek-ai/dsh/lib/bin.js')));
process.argv=[process.execPath,join(prefix,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--no-open','--port',process.env.FIXTURE_HOST_PORT];
await runCli({packageManager:{command:process.execPath,args:[process.env.FIXTURE_PM_SCRIPT],
 env:{FIXTURE_CONTROL_ROOT:process.env.FIXTURE_CONTROL_ROOT,FIXTURE_MODE:process.env.FIXTURE_MODE,FIXTURE_GENERATION:process.env.FIXTURE_GENERATION}}});
