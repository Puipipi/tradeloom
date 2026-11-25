import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize} from '../bridge/dsh-go-bridge/lib/native/effects.js';
import {normalize as sdkNormalize} from '../../sdk/plugin-kit/lib/bridge/effects.js';

for(const [label,check] of [['runtime',normalize],['sdk',sdkNormalize]]) {
  test(`${label}: native commands cannot change or query permission presets`,()=>{
    for(const opts of [{panels:new Set()},{panels:new Set(),static:true}]) {
      for(const args of [undefined,'read-only','workspace-write','danger-full-access','auto']) {
        for(const form of [{type:'command',name:'permission',args},{command:{name:'permission',args}}]) {
          const r=check(form,opts);
          assert.deepEqual(r.effects,[],`${label} must keep permission changes in the user's permission controls`);
          assert.ok(r.issues.some(x=>x.code==='bad-effect'));
        }
      }
    }
  });
  test(`${label}: ordinary explicit command and insert remain available`,()=>{
    const r=check([{command:{name:'compact',args:'summary'}},{insert:'/permission read-only'}],{panels:new Set()});
    assert.equal(r.effects[0].name,'compact');assert.equal(r.effects[1].type,'insert');assert.equal(r.issues.length,0);
  });
}
