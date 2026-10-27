import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
export async function assertStartReady({occupied,lock,bundle,read=readFile}) {
 if(await occupied()) throw Error('端口 3090 已占用；拒绝重复启动，请先使用明确停止入口。')
 const hash=x=>createHash('sha256').update(x).digest('hex')
 if(hash(await read(lock))!=='848409e5579e83d3760e07b0975f5a2dae3d4b09b4b856eedd0a64a383b2c94c')throw Error('DESKTOP24_LOCK_DRIFT')
 const pkg=JSON.parse(await read(path.join(bundle,'package.json'),'utf8'));if(pkg.files.length!==50)throw Error('BUNDLE_FILE_COUNT')
 const h=createHash('sha256');for(const f of ['package.json',...pkg.files].sort()){h.update(f.replaceAll('\\','/')).update('\0').update(await read(path.join(bundle,f)))}
 if(h.digest('hex')!=='8f7311e7343bccf43ee4b4ca557b6df467859e0b079e9e1604242ec00d89b48a')throw Error('DESKTOP24_BUNDLE_DRIFT')
}
