// Production createLookup with controlled interface observations and a
// network-free Resolver peer. No actual interfaces or DNS traffic are used.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {createLookup} from '../direct/dns.mjs';

const A = {address: '192.0.2.7', family: 4};
const AAAA = {address: '2001:db8::7', family: 6};
const MAPPED = {address: '::ffff:192.0.2.7', family: 6};
const EXTERNAL4 = {eth0: [{address: A.address, family: 'IPv4', internal: false}]};
const EXTERNAL6 = {eth0: [{address: AAAA.address, family: 'IPv6', internal: false}]};
const LOOPBACK = {lo: [
  {address: '127.0.0.1', family: 'IPv4', internal: true},
  {address: '::1', family: 'IPv6', internal: true},
]};
const queryFamilies = calls => calls.map(call => call.family);

function callbackLookup(adapter, hostname, options) {
  return new Promise((resolve, reject) => {
    adapter.lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve(Array.isArray(address) ? address : {address, family});
    });
  });
}

const promiseLookup = (adapter, hostname, options) => adapter.promiseLookup(hostname, options);

async function withFixture(interfaces, body) {
  const originalInterfaces = os.networkInterfaces;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-dns-addrconfig-'));
  const calls = [];
  let interfaceReads = 0;
  let adapter;
  class PeerResolver {
    setServers(servers) { assert.deepEqual(servers, ['192.0.2.53']); }
    resolve4(hostname, callback) { this.reply(4, hostname, callback); }
    resolve6(hostname, callback) { this.reply(6, hostname, callback); }
    reply(family, hostname, callback) {
      calls.push({hostname, family});
      const code = hostname === 'missing.test' ? 'ENOTFOUND'
        : hostname === 'temporary.test' ? 'ESERVFAIL'
          : hostname === 'v4only.test' && family === 6 ? 'ENODATA' : null;
      queueMicrotask(() => {
        if (code) callback(Object.assign(new Error('controlled resolver reply'), {code}));
        else callback(null, [family === 4 ? A.address : AAAA.address]);
      });
    }
  }
  try {
    os.networkInterfaces = () => {
      interfaceReads++;
      return interfaces();
    };
    syncBuiltinESMExports();
    const resolvConf = path.join(dir, 'resolv.conf');
    const hostsFile = path.join(dir, 'hosts');
    fs.writeFileSync(resolvConf, 'nameserver 192.0.2.53\n');
    fs.writeFileSync(hostsFile, '192.0.2.9 fixture.local\n2001:db8::9 fixture.local\n');
    adapter = createLookup({resolvConf, hostsFile, Resolver: PeerResolver, watch: false});
    await body({adapter, calls, interfaceReads: () => interfaceReads});
  } finally {
    try {
      adapter?.close();
    } finally {
      os.networkInterfaces = originalInterfaces;
      syncBuiltinESMExports();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }
}

test('empty interface observations query through both APIs without widening explicit families', async () => {
  await withFixture(() => ({}), async ({adapter, calls}) => {
    for (const read of [callbackLookup, promiseLookup]) {
      for (const [family, expectedQueries, expectedAnswers] of [
        [0, [4, 6], [A, AAAA]], [4, [4], [A]], [6, [6], [AAAA]],
      ]) {
        calls.length = 0;
        const answers = await read(adapter, 'dual.test', {
          family, hints: dns.ADDRCONFIG, all: true, order: 'verbatim',
        });
        assert.deepEqual(answers, expectedAnswers);
        assert.deepEqual(queryFamilies(calls), expectedQueries);
      }
    }
  });
});

test('nonempty single-family and loopback observations keep the original ADDRCONFIG filtering', async () => {
  let interfaces = EXTERNAL4;
  await withFixture(() => interfaces, async ({adapter, calls}) => {
    for (const [observed, available, unavailable, answer] of [
      [EXTERNAL4, 4, 6, A], [EXTERNAL6, 6, 4, AAAA],
    ]) {
      interfaces = observed;
      calls.length = 0;
      assert.deepEqual(await adapter.promiseLookup('dual.test', {
        hints: dns.ADDRCONFIG, all: true,
      }), [answer]);
      assert.deepEqual(queryFamilies(calls), [available]);
      calls.length = 0;
      await assert.rejects(adapter.promiseLookup('dual.test', {
        family: unavailable, hints: dns.ADDRCONFIG,
      }), {code: 'ENOTFOUND'});
      assert.deepEqual(calls, []);
    }
    interfaces = LOOPBACK;
    calls.length = 0;
    await assert.rejects(adapter.promiseLookup('dual.test', {
      hints: dns.ADDRCONFIG,
    }), {code: 'ENOTFOUND'});
    assert.deepEqual(calls, []);
  });
});

test('empty observations retain V4MAPPED and ALL behavior after actual peer replies', async () => {
  await withFixture(() => ({}), async ({adapter, calls}) => {
    for (const [hostname, extraHint, expected] of [
      ['dual.test', 0, [AAAA]],
      ['dual.test', dns.ALL, [AAAA, MAPPED]],
      ['v4only.test', 0, [MAPPED]],
    ]) {
      calls.length = 0;
      assert.deepEqual(await adapter.promiseLookup(hostname, {
        family: 6, hints: dns.ADDRCONFIG | dns.V4MAPPED | extraHint,
        all: true, order: 'verbatim',
      }), expected);
      assert.deepEqual(queryFamilies(calls), [6, 4]);
    }
  });
});

test('hosts entries remain local and respect empty or explicit single-family observations', async () => {
  let interfaces = {};
  await withFixture(() => interfaces, async ({adapter, calls}) => {
    assert.deepEqual(await adapter.promiseLookup('fixture.local', {
      hints: dns.ADDRCONFIG, all: true, order: 'verbatim',
    }), [
      {address: '192.0.2.9', family: 4},
      {address: '2001:db8::9', family: 6},
    ]);
    assert.deepEqual(calls, []);
    interfaces = EXTERNAL6;
    assert.deepEqual(await callbackLookup(adapter, 'fixture.local', {
      hints: dns.ADDRCONFIG, all: true,
    }), [{address: '2001:db8::9', family: 6}]);
    assert.deepEqual(calls, []);
  });
});

test('enumeration exceptions retain requested families and no-hint calls do not enumerate', async () => {
  await withFixture(() => {
    throw Object.assign(new Error('controlled enumeration denial'), {code: 'EACCES'});
  }, async ({adapter, calls, interfaceReads}) => {
    for (const [family, expected] of [[4, A], [6, AAAA]]) {
      calls.length = 0;
      assert.deepEqual(await adapter.promiseLookup('dual.test', {
        family, hints: dns.ADDRCONFIG, all: true,
      }), [expected]);
      assert.deepEqual(queryFamilies(calls), [family]);
    }
    const readsBefore = interfaceReads();
    calls.length = 0;
    assert.deepEqual(await callbackLookup(adapter, 'dual.test', {
      all: true, order: 'verbatim',
    }), [A, AAAA]);
    assert.deepEqual(queryFamilies(calls), [4, 6]);
    assert.equal(interfaceReads(), readsBefore);
  });
});

test('resolver missing-name and transient replies remain ENOTFOUND and EAI_AGAIN after queries', async () => {
  await withFixture(() => ({}), async ({adapter, calls}) => {
    for (const [hostname, code] of [
      ['missing.test', 'ENOTFOUND'], ['temporary.test', 'EAI_AGAIN'],
    ]) {
      calls.length = 0;
      await assert.rejects(adapter.promiseLookup(hostname, {
        hints: dns.ADDRCONFIG,
      }), {code, syscall: 'getaddrinfo', hostname});
      assert.deepEqual(queryFamilies(calls), [4, 6]);
    }
  });
});
