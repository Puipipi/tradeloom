import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStreamStager } from '../../src/stream-staging.js';

// Only this subprocess receives RLIMIT_FSIZE; the parent and host are unaffected.
process.on('SIGXFSZ', () => {});
const bytes = Buffer.alloc(Number(process.argv[2]), 65);
const directory = await mkdtemp(join(tmpdir(), 'media-staging-storage-'));
const original = join(directory, 'existing.txt');
const sockets = new Set();
let requests = 0;
const server = createServer((_request, response) => {
  requests++;
  response.writeHead(200, { 'content-length': bytes.length });
  response.end(bytes);
});
server.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
try {
  await writeFile(original, 'preserve existing');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let receipt;
  let errorCode;
  try {
    receipt = await createStreamStager({ allowLoopback: true })(
      `http://127.0.0.1:${server.address().port}/own-video`,
      { directory, maxBytes: 16384 },
    );
  } catch (error) {
    errorCode = error.code;
  }
  assert.equal(await readFile(original, 'utf8'), 'preserve existing');
  if (receipt) {
    assert.deepEqual(await readFile(receipt.path), bytes);
    assert.equal(receipt.bytes, bytes.length);
    assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
    await rm(receipt.path);
  }
  assert.deepEqual(await readdir(directory), ['existing.txt']);
  console.log(JSON.stringify({ requests, errorCode, receipt: Boolean(receipt),
    existingPreserved: true, temporaryFilesRemoved: true }));
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(done => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
