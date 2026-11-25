// Actual Host observer and loopback-only preloader; no replacement services.
import assert from 'node:assert/strict';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const connect = net.Socket.prototype.connect;
const blockedConnections = [];
net.Socket.prototype.connect = function (...args) {
  const [options] = net._normalizeArgs(args);
  if (options.path === undefined) {
    const host = options.host ?? 'localhost';
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
      blockedConnections.push(host);
      throw new Error('resolver test forbids non-loopback connection');
    }
  }
  return Reflect.apply(connect, this, args);
};
syncBuiltinESMExports();

export const name = 'file-upload-resolver-observer';
export const inject = ['fileUploads'];
export function apply(ctx) {
  const steps = [];
  let disposeA, disposeB, disposeC;
  const unusedResolver = () => assert.fail('registration regression must not resolve an Agent');
  try {
    assert.equal(ctx.get('sessionController'), undefined, 'normal profile disables the controller');
    disposeA = ctx.fileUploads.registerAgentResolver(unusedResolver);
    steps.push('registered-A');
    assert.throws(() => ctx.fileUploads.registerAgentResolver(unusedResolver), /Agent resolver is already registered/);
    steps.push('duplicate-A-rejected');
    disposeA();
    steps.push('disposed-A');
    assert.doesNotThrow(() => {
      disposeB = ctx.fileUploads.registerAgentResolver(() => unusedResolver());
    }, 'after the public disposer returns, another resolver must be registerable');
    steps.push('registered-B');
    disposeA();
    assert.throws(() => ctx.fileUploads.registerAgentResolver(unusedResolver), /Agent resolver is already registered/);
    steps.push('old-A-cannot-clear-B');
    disposeB();
    disposeC = ctx.fileUploads.registerAgentResolver(unusedResolver);
    steps.push('registered-C-after-disposed-B');
    disposeC();
    assert.deepEqual(blockedConnections, []);
    process.send?.({ kind: 'resolver-result', steps, passed: true });
  } catch (error) {
    process.send?.({ kind: 'resolver-result', steps, passed: false,
      error: { name: error.name, message: error.message, stack: error.stack }, blockedConnections });
  } finally {
    disposeC?.();
    disposeB?.();
    disposeA?.();
  }
}
