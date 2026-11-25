import { randomUUID } from 'node:crypto';
import { CompanionError, integer } from './schema.js';
import { RECALL_MAX_ITEMS, RECALL_SELECTOR, RECALL_SECTION, RECALL_TEXT_UTF16 } from './recall-selector.js';
import { createRecallMarkers } from './recall-markers.js';
import { canonicalUuid, recallError, recallInvalid, validateBind, validateRevoke } from './recall-schema.js';

export const MAX_RECALL_BINDINGS = 1024;
export const MAX_RECALL_OPERATIONS = 2048;
const safeReason = (value, fallback) => typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value) ? value : fallback;
const unavailable = () => recallError(503, 'adapter-unavailable', 'Automatic recall is unavailable for this engine route');
const retired = () => recallError(409, 'retired', 'Automatic recall binding is retired; use a new clean session');
const capacity = () => recallError(503, 'capacity', 'Recall epoch capacity reached; existing bindings remain revocable');
const tagFailure = () => recallError(503, 'tag-unavailable', 'Companion recall session marker is unavailable');
const factId = (value) => integer(value) || typeof value === 'string' && value.length > 0 && value.length <= 256;

export function createRecallCoordinator({ store, adapter, markers = createRecallMarkers(),
  ids = randomUUID, maxBindings = MAX_RECALL_BINDINGS, maxOperations = MAX_RECALL_OPERATIONS, promptContext } = {}) {
  const bridgeEpoch = ids();
  if (!canonicalUuid(bridgeEpoch) || !integer(maxBindings) || maxBindings < 1
    || !integer(maxOperations) || maxOperations < 2) throw unavailable();
  let engine;
  let closed = false;
  let epoch = 0;
  let activeBinding;
  let tail = Promise.resolve();
  const bindings = new Map();
  const operations = new Map();
  const prepared = new WeakMap();
  const permits = new WeakMap();
  const adapterReady = Promise.resolve(adapter).then((value) => {
    if (closed || value?.version !== 1 || !['capability', 'resolveTarget', 'isCurrent', 'isClean', 'markBound', 'stop']
      .every((key) => typeof value[key] === 'function')) return;
    engine = value;
  }).catch(() => {});

  const queue = (work) => {
    const result = tail.then(work);
    tail = result.then(() => {}, () => {});
    return result;
  };
  const now = () => {
    try {
      const at = store.now();
      if (!integer(at)) throw new Error();
      return at;
    }
    catch { throw recallError(503, 'store-unavailable', 'Companion recall store is unavailable'); }
  };
  const target = (binding) => ({ agent: binding.agent, scope: binding.scope });
  const route = (value) => {
    if (closed || !engine) return { supported: false, reason: 'adapter-unavailable' };
    try {
      const capability = engine.capability(value);
      return capability?.supported === true ? { supported: true, reason: null }
        : { supported: false, reason: safeReason(capability?.reason, 'adapter-unavailable') };
    } catch { return { supported: false, reason: 'adapter-unavailable' }; }
  };
  const wire = (binding) => {
    let serverNow;
    try { serverNow = now(); }
    catch (error) { retireNow(binding, 'store-unavailable'); throw error; }
    if (binding.expiresAt !== null && serverNow >= binding.expiresAt) retireNow(binding, 'expired');
    return { v: 1, bindingId: binding.bindingId, bridgeEpoch,
      recallEpoch: binding.recallEpoch, storeId: binding.storeId, memoryRevision: binding.memoryRevision,
      sessionId: binding.sessionId, status: binding.status, selectorVersion: RECALL_SELECTOR,
      reason: binding.reason, serverNow };
  };
  function retireNow(binding, reason) {
    if (!binding || binding.status !== 'ready') return;
    const oldTarget = target(binding);
    // Keep C800 query sidecars disabled after revoke, expiry or target change.
    // Only memory is retired; the profile/event provider stays mounted.
    promptContext?.retireMemory(oldTarget.agent);
    binding.status = 'retired';
    binding.reason = safeReason(reason, 'unavailable');
    if (epoch < Number.MAX_SAFE_INTEGER) binding.recallEpoch = ++epoch;
    clearTimeout(binding.timer);
    binding.timer = undefined;
    binding.turn = undefined;
    binding.prepared = undefined;
    binding.agent = binding.scope = binding.session = undefined;
    if (activeBinding === binding) activeBinding = undefined;
    // Neither cancellation nor driver drain is awaited by the admission/write
    // queue. A stop that itself awaits an old driver cannot create a gate cycle.
    const stop = engine?.stop;
    if (stop) void Promise.resolve().then(() => stop.call(engine, {
      ...oldTarget, bindingId: binding.bindingId, reason: binding.reason,
    })).catch(() => {});
  }
  function retireAll(reason) { retireNow(activeBinding, reason); }
  function tag(binding) {
    try {
      const marker = markers.readSync(binding.sessionId);
      if (!marker || marker.storeId !== binding.storeId) throw tagFailure();
    } catch {
      retireNow(binding, 'tag-unavailable');
      throw tagFailure();
    }
  }
  function current(binding) {
    if (closed || binding.status !== 'ready') throw retired();
    if (epoch === Number.MAX_SAFE_INTEGER) { retireNow(binding, 'epoch-exhausted'); throw capacity(); }
    const actual = target(binding);
    let valid;
    try { valid = actual.scope === actual.agent && actual.agent?.session === binding.session
      && actual.agent?.id === binding.sessionId && binding.session?.id === binding.sessionId
      && engine?.isCurrent(actual) === true; }
    catch { valid = false; }
    if (!valid) { retireNow(binding, 'agent-changed'); throw retired(); }
    if (!route(actual).supported) { retireNow(binding, 'adapter-unavailable'); throw unavailable(); }
    tag(binding);
    let at;
    try { at = now(); }
    catch (error) { retireNow(binding, 'store-unavailable'); throw error; }
    if (binding.expiresAt !== null && at >= binding.expiresAt) {
      retireNow(binding, 'expired');
      throw retired();
    }
    return at;
  }
  function expiryTimer(binding) {
    clearTimeout(binding.timer);
    if (binding.status !== 'ready' || binding.expiresAt === null) return;
    let delay;
    try { delay = Math.max(0, binding.expiresAt - now()); }
    catch { retireNow(binding, 'store-unavailable'); return; }
    binding.timer = setTimeout(() => {
      try { current(binding); expiryTimer(binding); } catch {}
    }, Math.min(delay, 2147483647));
    binding.timer.unref?.();
  }
  async function readStore(binding) {
    let context;
    try { context = await store.getRecallContext(); }
    catch {
      retireNow(binding, 'store-unavailable');
      throw recallError(503, 'store-unavailable', 'Companion recall store is unavailable');
    }
    if (!canonicalUuid(context?.storeId) || !integer(context.memoryRevision)
      || context.selectorVersion !== RECALL_SELECTOR || typeof context.text !== 'string'
      || !(context.expiresAt === null || integer(context.expiresAt))) {
      retireNow(binding, 'store-unavailable');
      throw recallError(503, 'store-unavailable', 'Companion recall store is unavailable');
    }
    if (binding) {
      current(binding); // Includes changes/disposal while the read was pending.
      if (context.storeId !== binding.storeId || context.memoryRevision !== binding.memoryRevision) {
        retireNow(binding, context.storeId !== binding.storeId ? 'store-changed' : 'memory-changed');
        throw retired();
      }
    }
    return context;
  }
  async function refresh(binding) {
    if (!binding || binding.status !== 'ready') return;
    try { current(binding); await readStore(binding); }
    catch { /* The failing owner already permanently retired this binding. */ }
  }
  function lookupOperation(input, kind) {
    const fingerprint = JSON.stringify({ kind, ...input });
    const old = operations.get(input.operationId);
    if (old && old.fingerprint !== fingerprint) throw recallError(409, 'operation-conflict', 'Recall operation identity was reused for another request');
    return { old, fingerprint };
  }
  async function replay(record) {
    if (record.failure) throw new CompanionError(record.failure.status,
      record.failure.code.slice('companion/'.length), record.failure.message);
    const binding = bindings.get(record.bindingId);
    if (!binding) throw unavailable();
    await refresh(binding);
    return wire(binding);
  }
  async function remember(input, fingerprint, work) {
    const record = { fingerprint };
    operations.set(input.operationId, record);
    try {
      const binding = await work();
      record.bindingId = binding.bindingId;
      return wire(binding);
    } catch (error) {
      const failure = error instanceof CompanionError ? error : unavailable();
      record.failure = { status: failure.status, code: failure.code, message: failure.message };
      throw failure;
    }
  }
  function version(context, input) {
    if (context.storeId !== input.storeId) throw recallError(409, 'store-changed', 'Companion store identity changed');
    if (context.memoryRevision !== input.expectedMemoryRevision) throw recallError(409, 'memory-conflict', 'Companion memory revision changed');
  }
  function live(actual, session) {
    if (closed || !actual || actual.scope !== actual.agent || !actual.agent
      || session !== undefined && actual.agent.session !== session || engine?.isCurrent(actual) !== true) throw unavailable();
    if (!route(actual).supported) throw unavailable();
  }
  function clean(actual, session) {
    live(actual, session);
    if (engine.isClean(actual) !== true) throw recallError(409, 'session-not-clean', 'Use a new clean session for automatic recall');
  }
  function bindingFor(actual) {
    const binding = activeBinding;
    if (!binding || binding.agent !== actual.agent) return undefined;
    if (binding.scope !== actual.scope || actual.scope !== actual.agent) throw retired();
    return binding;
  }
  function guardSession({ sessionId, agent, operation, recallHistory = false }) {
    const binding = activeBinding?.sessionId === sessionId ? activeBinding : undefined;
    let marker;
    try { marker = markers.readSync(sessionId); }
    catch { retireNow(binding, 'tag-unavailable'); throw tagFailure(); }
    const known = [...bindings.values()].some((binding) => binding.sessionId === sessionId);
    const protectedSession = marker !== null || recallHistory || known;
    if (!protectedSession) return;
    if (operation === 'fork' || !binding || binding.agent !== agent) throw retired();
    current(binding);
  }

  return {
    bridgeEpoch,
    async capability() {
      await adapterReady;
      const binding = activeBinding;
      if (binding) await queue(() => refresh(binding));
      const support = route();
      const writable = support.supported && await markers.available();
      const latestSupport = route();
      const available = writable && latestSupport.supported;
      return { v: 1, supported: available, reason: available ? null : latestSupport.reason ?? 'tag-unavailable',
        selectorVersion: RECALL_SELECTOR, maxItems: RECALL_MAX_ITEMS, textUtf16Budget: RECALL_TEXT_UTF16,
        busy: activeBinding?.status === 'ready', activeBindingId: activeBinding?.bindingId ?? null };
    },
    bind(value) {
      const input = validateBind(value);
      return queue(async () => {
        const { old, fingerprint } = lookupOperation(input, 'bind');
        if (old) return replay(old);
        if (bindings.size >= maxBindings || operations.size >= maxOperations - 1 || epoch >= Number.MAX_SAFE_INTEGER - 1) throw capacity();
        return remember(input, fingerprint, async () => {
          await adapterReady;
          if (!route().supported) throw unavailable();
          if (!await markers.available()) throw tagFailure();
          if (activeBinding) await refresh(activeBinding);
          if (activeBinding) throw recallError(409, 'binding-busy', 'This store already has an active recall binding');
          const context = await readStore();
          version(context, input);
          let actual;
          try { actual = await engine.resolveTarget(input.sessionId); }
          catch { throw unavailable(); }
          clean(actual);
          if (actual.agent.id !== input.sessionId || actual.agent.session?.id !== input.sessionId
            || [...bindings.values()].some((binding) => binding.sessionId === input.sessionId)) {
            throw recallError(409, 'session-not-clean', 'Use a new clean session for automatic recall');
          }
          const session = actual.agent.session;
          if (markers.readSync(input.sessionId) !== null) throw recallError(409, 'session-not-clean', 'Use a new clean session for automatic recall');
          // This is inside the binding queue, after target/clean/store checks
          // and before either persistent marker or ready can become visible.
          // It fences pending query awaits as well as already claimed memory.
          promptContext?.disableMemory(actual.agent);
          clean(actual, session);
          await markers.write(input.sessionId, input.storeId);
          version(await readStore(), input);
          clean(actual, session);
          // No await between this final identity/clean proof, log marker and bind.
          const marked = engine.markBound({ ...actual, sessionId: input.sessionId, storeId: input.storeId });
          if (marked && typeof marked.then === 'function') {
            void Promise.resolve(marked).catch(() => {});
            throw unavailable();
          }
          // Session append listeners can synchronously dispose/switch an Agent.
          // The marker makes the log non-clean, so repeat only live/certification
          // and marker checks before the no-await RAM commit.
          live(actual, session);
          if (markers.readSync(input.sessionId)?.storeId !== input.storeId) throw tagFailure();
          const bindingId = ids();
          if (!canonicalUuid(bindingId) || bindings.has(bindingId)) throw unavailable();
          const binding = { bindingId, recallEpoch: ++epoch, storeId: input.storeId,
            memoryRevision: input.expectedMemoryRevision, sessionId: input.sessionId,
            consumerId: input.consumerId, status: 'ready', reason: null,
            agent: actual.agent, scope: actual.scope, session,
            expiresAt: null, turn: undefined, timer: undefined };
          bindings.set(bindingId, binding); activeBinding = binding;
          return binding;
        });
      });
    },
    status(bindingId) {
      if (!canonicalUuid(bindingId)) throw recallInvalid();
      return queue(async () => {
        const binding = bindings.get(bindingId);
        if (!binding) throw recallError(404, 'binding-not-found', 'Recall binding was not found in this bridge epoch');
        await refresh(binding);
        return wire(binding);
      });
    },
    revoke(value) {
      const input = validateRevoke(value);
      return queue(async () => {
        const { old, fingerprint } = lookupOperation(input, 'revoke');
        if (old) return replay(old);
        const binding = bindings.get(input.bindingId);
        if (!binding) throw recallError(404, 'binding-not-found', 'Recall binding was not found in this bridge epoch');
        const reserved = activeBinding && binding !== activeBinding ? 1 : 0;
        if (operations.size >= maxOperations - reserved) throw capacity();
        return remember(input, fingerprint, async () => { retireNow(binding, 'user-off'); return binding; });
      });
    },
    mutateMemory(method, input) {
      if (!['upsertMemory', 'deleteMemory', 'clearMemories'].includes(method)) throw recallInvalid();
      let detached, invalidClone = false;
      try { detached = structuredClone(input); } catch { invalidClone = true; }
      return queue(() => {
        promptContext?.invalidateMemories();
        retireAll('memory-changed');
        if (invalidClone) throw recallInvalid();
        return store[method](detached);
      });
    },
    prepare(input) {
      return queue(async () => {
        const { agent, scope, turnId, stepId, signal } = input;
        guardSession({ sessionId: agent?.id, agent, operation: 'prepare' });
        const binding = bindingFor({ agent, scope });
        if (!binding) return undefined;
        if (!factId(turnId) || !factId(stepId) || scope !== agent || signal?.aborted) throw retired();
        current(binding);
        if (!binding.turn || binding.turn.turnId !== turnId) {
          const context = await readStore(binding);
          if (signal?.aborted) throw retired();
          if (context.expiresAt !== null) binding.expiresAt = binding.expiresAt === null
            ? context.expiresAt : Math.min(binding.expiresAt, context.expiresAt);
          binding.turn = { turnId, text: context.text };
          current(binding);
          expiryTimer(binding);
        }
        const stamp = Object.freeze({ bindingId: binding.bindingId, bridgeEpoch, recallEpoch: binding.recallEpoch,
          storeId: binding.storeId, memoryRevision: binding.memoryRevision, sessionId: binding.sessionId,
          turnId, stepId, expiresAt: binding.expiresAt });
        binding.prepared = stamp;
        prepared.set(stamp, { binding, agent, scope, turnId, stepId, attempts: new Set() });
        return { section: binding.turn.text === '' ? undefined : {
          name: RECALL_SECTION, text: binding.turn.text, interpolate: false,
        }, stamp };
      });
    },
    admit(input) {
      return queue(async () => {
        const { agent, scope, stamp, turnId, stepId, attemptId } = input;
        const record = stamp && prepared.get(stamp);
        if (!record || record.agent !== agent || record.scope !== scope || record.turnId !== turnId
          || record.stepId !== stepId || !factId(attemptId) || record.attempts.has(attemptId)) throw retired();
        const binding = record.binding;
        current(binding);
        if (stamp.recallEpoch !== binding.recallEpoch || binding.prepared !== stamp) throw retired();
        await readStore(binding);
        current(binding);
        if (record.attempts.size >= 128) { retireNow(binding, 'attempt-capacity'); throw capacity(); }
        record.attempts.add(attemptId);
        const permit = Object.freeze({ ...stamp, attemptId, expiresAt: binding.expiresAt });
        permits.set(permit, { binding, agent, scope, stamp });
        return permit;
      });
    },
    guardTool({ agent, scope, permit }) {
      guardSession({ sessionId: agent?.id, agent, operation: 'tool' });
      const binding = bindingFor({ agent, scope });
      if (!binding) return;
      const record = permit && permits.get(permit);
      if (!record || record.binding !== binding || record.agent !== agent || record.scope !== scope
        || record.stamp !== binding.prepared || permit.recallEpoch !== binding.recallEpoch) throw retired();
      current(binding);
    },
    guardSession,
    // A new Agent or bridge must not reopen the query lane of a session that
    // has an automatic-recall marker. This is a memory policy, not admission.
    allowsQueryContext(agent) {
      if (closed || !agent || agent.session?.id !== agent.id) return false;
      try {
        return markers.readSync(agent.id) === null &&
          ![...bindings.values()].some(binding => binding.sessionId === agent.id);
      } catch { return false; }
    },
    retireAgent(agent, reason = 'agent-changed') {
      if (activeBinding?.agent === agent) retireNow(activeBinding, reason);
    },
    retireAll,
    dispose() { closed = true; retireAll('bridge-disposed'); },
  };
}
