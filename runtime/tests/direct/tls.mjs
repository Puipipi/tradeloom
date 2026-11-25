// Real HTTPS verification with a temporary self-signed fixture certificate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import cp from 'node:child_process';
import { promisify } from 'node:util';

const root = process.env.DSH_GO_DIRECT_ROOTFS;
assert(root, 'use the generated direct node wrapper');
const base = fs.mkdtempSync(`${root}/tmp/direct-tls-`);
const guest = base.slice(root.length);
const run = promisify(cp.execFile);
let server;
try {
  await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', `${base}/key.pem`, '-out', `${base}/cert.pem`], { cwd: base, timeout: 10_000 });
  server = https.createServer({ key: fs.readFileSync(`${base}/key.pem`), cert: fs.readFileSync(`${base}/cert.pem`) },
    (_req, res) => res.end('direct-tls-fixture'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const program = `const https=require('node:https'),tls=require('node:tls');
    https.get('https://127.0.0.1:${port}/',res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>console.log(JSON.stringify({status:res.statusCode,body,builtinRoots:tls.rootCertificates.length})));})
    .on('error',e=>{console.error(e.code);process.exitCode=19;});`;
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  let rejected;
  try { await run(process.execPath, ['-e', program], { cwd: base, env, timeout: 10_000 }); }
  catch (error) { rejected = { code: error.code, stderr: error.stderr.trim() }; }
  assert.deepEqual(rejected, { code: 19, stderr: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  const accepted = JSON.parse((await run(process.execPath, ['-e', program], {
    cwd: base, env: { ...env, NODE_EXTRA_CA_CERTS: `${guest}/cert.pem` }, timeout: 10_000,
  })).stdout);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body, 'direct-tls-fixture');
  assert(accepted.builtinRoots > 100);
  console.log(JSON.stringify({ node: process.version, untrusted: rejected, extraCAWithGuestPath: accepted,
    meaning: 'verification stays enabled; the explicit extra CA is mapped before child Node starts; no public-network TLS claim' }, null, 2));
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(base, { recursive: true, force: true });
}
