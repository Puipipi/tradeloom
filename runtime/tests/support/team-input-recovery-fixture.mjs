// Real Team / subagent / AgentLoop / JSONL services. Only public scheduling seams
// are held; no Session events, persisted JSONL, or private roster state are seeded.
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to an isolated patched runtime');
const prefix = resolve(process.env.DSH_PREFIX);
const load = name => import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { SessionStore } = await load('dsh-session');
const { SessionProjectionRegistry } = await load('dsh-session-projection');
const { AgentRegistry } = await load('dsh-agent');
const { AgentLoop } = await load('dsh-agent-loop');
const { LlmRuntime, createUserMessage } = await load('dsh-llm');
const { SystemPrompt } = await load('dsh-system-prompt');
const { ToolsService } = await load('dsh-tools');
const NativeExecutor = await load('dsh-tool-executor-native');
const { LocalFileSystem } = await load('dsh-fs-local');
const { WorkingDirectoryService } = await load('dsh-working-directory');
const Jsonl = await load('dsh-session-persistence-jsonl');
const { SubagentRuntime } = await load('dsh-subagent');
const Spawn = await load('dsh-subagent-spawn-in-process');
const Fork = await load('dsh-subagent-fork-in-process');
const { TeamService } = await load('dsh-experimental-agent-team');

const WAIT_MS = 10_000;
const message = text => createUserMessage({
  source: { kind: 'user' }, content: [{ type: 'text', text }],
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = values => values.map(value => value.id);
const summary = error => String(error?.stack ?? error);
function errorDetails(error, seen = new Set()) {
  if (error === null || typeof error !== 'object') return { value: String(error) };
  if (seen.has(error)) return { cycle: true };
  seen.add(error);
  return {
    name: error.name, message: error.message, code: error.code, stack: error.stack,
    ...(error.cause === undefined ? {} : { cause: errorDetails(error.cause, seen) }),
    ...(Array.isArray(error.errors) ? { errors: error.errors.map(value => errorDetails(value, seen)) } : {}),
  };
}
class FixtureError extends Error {
  constructor(text) { super('TEAM_RECOVERY_FIXTURE: ' + text); }
}
function deferred() {
  const gate = Promise.withResolvers();
  gate.promise.catch(() => {});
  return gate;
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new FixtureError('timeout at ' + label)), WAIT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

// Each call owns one producer runtime and one independent cold runtime.
// No globally installed adapter can execute a model: entering prepareCall is a
// fixture failure. The registered real prompt/tools/filesystem services still run.
export async function coldTeamCase(t, mode) {
  const failures = [];
  const trace = { case: t.name, mode, modelCalls: 0, heldFlushes: 0, background: [], cleanup: [], fixtureFailures: failures };
  const runtimes = [];
  const releases = [];
  const holds = [];
  const tracked = [];
  const fatal = deferred();
  let root, producer, child, initial, leadId, capture = false, closing = false;
  let flushSpy;
  const modeReady = deferred(), flushEntered = deferred(), flushReturn = deferred();
  const childStepReturn = deferred(), maintenanceReturn = deferred();
  const parentStepEntered = deferred(), parentStepReturn = deferred();
  holds.push(modeReady, flushReturn, childStepReturn, maintenanceReturn, parentStepReturn);

  function fail(label, error) {
    const record = { label, error: errorDetails(error) };
    failures.push(record);
    fatal.reject(new FixtureError(label + ': ' + summary(error)));
  }
  function require(condition, label) {
    if (!condition) throw new FixtureError(label);
  }
  function observe(label, fn) {
    // agentEvents and Session observers contain listener failures. Preserve them
    // independently so a swallowed observer error cannot look like a target red.
    return (...args) => {
      try { return fn(...args); } catch (error) { fail(label, error); }
    };
  }
  function track(promise, label, expectedAbort) {
    const observed = promise.then(value => {
      trace.background.push({ label, status: 'fulfilled', value });
      return { ok: true, value };
    }, error => {
      const reason = expectedAbort?.();
      const isExpectedAbort = reason !== undefined && error === reason;
      trace.background.push({ label, status: 'rejected', expectedAbort: isExpectedAbort, error: errorDetails(error) });
      // Only the exact Error supplied by this fixture to abort() is expected.
      // In particular, Team failure-record or disposal AggregateErrors fail.
      if (!isExpectedAbort) fail(label, error);
      return { ok: false, expectedAbort: isExpectedAbort, error: errorDetails(error) };
    });
    tracked.push({ label, observed });
    return observed;
  }
  async function wait(promise, label) {
    return bounded(Promise.race([promise, fatal.promise]), label);
  }
  async function attempt(label, action) {
    try {
      await bounded(Promise.resolve().then(action), label);
      trace.cleanup.push({ label, status: 'fulfilled' });
    } catch (error) {
      trace.cleanup.push({ label, status: 'rejected', error: errorDetails(error) });
      fail(label, error);
    }
  }

  async function closeRuntime(runtime) {
    if (runtime.closed) return;
    runtime.closed = true;
    for (const handle of runtime.handles.reverse())
      await attempt('Agent dispose ' + handle.agent.id, () => handle.dispose());
    for (const fork of runtime.forks.reverse())
      await attempt('plugin dispose', () => fork.dispose());
    await attempt('Context dispose', () => runtime.ctx.fiber.dispose());
    for (const spy of runtime.spies.reverse())
      await attempt('restore owned service mock', () => spy.mock.restore());
  }
  async function closeProducer() {
    if (!producer || producer.closed) return;
    closing = true;
    capture = false;
    producer.abort.abort(new FixtureError('producer teardown after frozen byte cut'));
    // Stop actual agents before releasing preparation/maintenance waiters.
    for (const agent of producer.ctx.agents.list())
      await attempt('cancel for disposal ' + agent.id, () => agent.cancel({ kind: 'disposed' }));
    for (const gate of holds) gate.resolve();
    for (const pending of tracked)
      await attempt('join ' + pending.label, () => pending.observed);
    await closeRuntime(producer);
    if (flushSpy) {
      await attempt('restore own flush spy', () => flushSpy.mock.restore());
      flushSpy = undefined;
    }
  }
  t.after(async () => {
    try {
      await closeProducer();
      for (const runtime of [...runtimes].reverse()) await closeRuntime(runtime);
    } catch (error) { fail('outer cleanup', error); }
    finally {
      for (const gate of holds) gate.resolve();
      for (const release of releases.reverse()) await attempt('observer release', release);
      if (flushSpy) await attempt('restore own flush spy', () => flushSpy.mock.restore());
      if (root) await attempt('remove own fixture directory', () => rm(root, { recursive: true, force: true }));
      t.diagnostic('TEAM_INPUT_RECOVERY_TRACE ' + JSON.stringify(trace));
    }
    if (failures.length) throw new FixtureError('fixtureFailures is not empty');
  });

  async function openRuntime(storage) {
    const ctx = new Context();
    const runtime = { ctx, storage, forks: [], handles: [], spies: [], closed: false, abort: new AbortController() };
    runtimes.push(runtime);
    async function mount(plugin, config) {
      const fork = ctx.plugin(plugin, config);
      runtime.forks.push(fork);
      await wait(fork.await(), 'plugin ready');
    }
    await mount(SessionProjectionRegistry);
    await mount(SessionStore);
    await mount(AgentRegistry);
    releases.push(ctx.on('agent/error', observe('agent/error observer', ({ agent, error }) => {
      // Normal cancellation does not emit agent/error; recovery/append failures do.
      fail('unexpected Agent error ' + agent.id, error);
    })));
    await mount(SystemPrompt);
    await mount(LlmRuntime);
    await mount(ToolsService);
    await mount(NativeExecutor);
    await mount(LocalFileSystem, { cwd: join(root, 'work') });
    await mount(WorkingDirectoryService, { defaultDirectory: join(root, 'work') });
    await mount(Jsonl, { root: storage, compression: 'none', listConcurrency: 1 });
    await mount(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    await mount(SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 2 });
    await mount(Spawn, { providerName: 'spawn' });
    await mount(Fork, { providerName: 'fork' });
    await mount(TeamService);
    runtime.spies.push(t.mock.method(ctx.llm, 'prepareCall', () => {
      trace.modelCalls++;
      const error = new FixtureError('unexpected model call');
      fail('model boundary', error);
      throw error;
    }));
    return runtime;
  }

  try {
    root = await mkdtemp(join(tmpdir(), 'dsh-team-input-recovery-'));
    await mkdir(join(root, 'work'));
    producer = await openRuntime(join(root, 'producer'));
    const ctx = producer.ctx;
    leadId = randomUUID();
    const handle = await wait(ctx.agentLoop.createAgent(ctx, {
      sessionId: leadId,
      agentOptions: { provider: 'fixture', model: 'fixture' },
    }), 'create real Lead');
    producer.handles.push(handle);
    const lead = handle.agent;
    let parentP0, parentP1;
    const claimed = [], childPreSteps = [];
    trace.claimedNotifications = claimed;
    trace.childPreSteps = childPreSteps;
    const rawFlush = SessionStore.prototype.flush;
    flushSpy = t.mock.method(SessionStore.prototype, 'flush', async function(session) {
      let result;
      try { result = await rawFlush.call(this, session); }
      catch (error) {
        // Subagent final flush is best-effort and may otherwise only warn.
        fail('public Session flush ' + session.id, error);
        throw error;
      }
      if (capture && child?.session === session) {
        trace.heldFlushes++;
        flushEntered.resolve();
        // All child flush callers are held, including natural-settlement flush.
        // The real flush has completed; the public call's return is delayed.
        await flushReturn.promise;
      }
      return result;
    });
    capture = true;

    releases.push(ctx.on('agent/inbox/claimed', observe('claimed observer', ({ agent, message: input }) => {
      if (capture && agent === child) claimed.push(input.id);
    })));
    releases.push(ctx.on('agent/inbox/inserted', observe('inserted control', ({ agent, message: input }) => {
      if (!capture || closing || agent.session.header.parentSession !== leadId || input.source.kind !== 'user') return;
      require(initial === undefined, 'only one child-owned initial user insertion');
      child = agent;
      initial = input;
      trace.childId = agent.id;
      trace.initialId = input.id;
      if (mode === 'pending') {
        const job = agent.runMaintenance(async () => {
          trace.maintenanceEntered = true;
          modeReady.resolve();
          await maintenanceReturn.promise;
        });
        track(job, 'public maintenance');
      } else if (mode === 'canceled') {
        require(agent.inbox.remove(input.id) === true, 'public remove cancels existing queued input');
        trace.removedInitial = true;
      }
    })));
    releases.push(ctx.on('session/event', observe('session observer', (session, event) => {
      if (!capture || session !== child?.session) return;
      if (mode === 'blocked' && event.type === 'turn/end' && event.data.reason?.kind === 'blocked') {
        trace.blockedTurn = event.data.turn;
        modeReady.resolve();
      }
    })));
    releases.push(ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      if (agent === lead && mode === 'fork-canceled' && parentP0 &&
          messages.some(input => input.id === parentP0.id)) {
        parentStepEntered.resolve();
        await parentStepReturn.promise;
        signal.throwIfAborted();
        // Public filtering: Agent itself settles P0 and writes completed.
        return { kind: 'enter', messages: [] };
      }
      if (agent !== child) return { kind: 'reject' };
      childPreSteps.push(ids(messages));
      if (mode === 'blocked') return { kind: 'reject' };
      if (mode === 'fork-canceled') {
        require(messages.some(input => input.id === parentP1.id), 'fork claims inherited P1');
        require(!messages.some(input => input.id === initial.id), 'fork leaves q pending on first claim');
        require(agent.inbox.remove(initial.id) === true, 'public remove cancels child-owned q');
        trace.removedInitial = true;
      }
      modeReady.resolve();
      await childStepReturn.promise;
      // Only teardown releases this preparation pause; no model is needed.
      signal.throwIfAborted();
      return { kind: 'reject' };
    }));

    if (mode === 'fork-canceled') {
      parentP0 = message('Parent P0: filtered at a legitimate pre-step extension');
      parentP1 = message('Parent P1: queued while P0 still owns the turn');
      lead.followup(parentP0);
      await wait(parentStepEntered.promise, 'parent P0 pre-step');
      lead.followup(parentP1);
      parentStepReturn.resolve();
      await wait(lead.whenIdle(), 'parent filtered turn completed');
      require(lead.inbox.nextTurn.length === 1 && lead.inbox.nextTurn[0].id === parentP1.id,
        'real parent P1 remains pending after completed P0');
      const lastEnd = lead.session.snapshotEvents().findLast(event => event.type === 'turn/end');
      require(lastEnd?.data.reason?.kind === 'completed', 'real completed fork boundary');
      trace.parent = { p0: parentP0.id, p1: parentP1.id, lastEndSeq: lastEnd.seq, pending: ids(lead.inbox.nextTurn) };
    }
    const spawn = ctx.agentTeams.spawnTeammate(lead, {
      name: 'worker', description: 'Real recovery fixture teammate',
      provider: mode === 'fork-canceled' ? 'fork' : 'spawn',
      context: mode === 'fork-canceled' ? 'fork' : 'fresh',
      prompt: [{ type: 'text', text: 'Initial child-owned user prompt q' }],
      signal: producer.abort.signal,
    });
    track(spawn, 'Team spawn', () => producer.abort.signal.aborted ? producer.abort.signal.reason : undefined);
    await wait(Promise.all([modeReady.promise, flushEntered.promise]), 'real child mode and completed flush');
    require(child && initial && trace.heldFlushes > 0, 'child input and real held flush exist');

    // This explicit second checkpoint uses the original public implementation.
    // It freezes events generated after the first real flush in the blocked case.
    require(await wait(rawFlush.call(ctx.sessions, child.session), 'flush exact child cut'),
      'child has a real persistence flush listener');
    require(await wait(rawFlush.call(ctx.sessions, lead.session), 'flush provisioning Lead'),
      'Lead has a real persistence flush listener');
    const leadEvents = lead.session.snapshotEvents();
    const childEvents = child.session.snapshotEvents();
    const own = childEvents.slice(child.session.inheritedEventCount);
    const membership = leadEvents.filter(event => event.type === 'team/member' &&
      event.data.member.id === child.id);
    require(membership.length === 1 && membership[0].data.member.phase === 'provisioning',
      'capture precedes every Team active/failed publication');
    require(ctx.agentTeams.listMembers(lead).find(row => row.id === child.id)?.status === 'provisioning',
      'live public roster is provisioning at the cut');
    require(child.session.header.parentSession === leadId, 'actual direct child header');
    require(own.some(event => event.type === 'subagent/descriptor' &&
      event.data.mode === 'continuable' && event.data.provider === (mode === 'fork-canceled' ? 'fork' : 'spawn')),
      'actual subagent continuable descriptor');
    require(!own.some(event => event.type === 'user/message' && event.data.id === initial.id),
      'initial input has not reached model-visible history');
    const initialInsertions = own.filter(event => event.type === 'agent/inbox/spliced' &&
      event.data.inserted.some(input => input.id === initial.id));
    require(initialInsertions.length === 1, 'initial input has exactly one real child-owned insertion');
    if (mode === 'pending') {
      require(trace.maintenanceEntered === true && childPreSteps.length === 0 && !claimed.includes(initial.id),
        'maintenance really holds before any initial claim');
      require(child.inbox.nextTurn.some(input => input.id === initial.id), 'initial input remains publicly pending');
    } else if (mode === 'claim') {
      require(claimed.includes(initial.id) && childPreSteps.some(batch => batch.includes(initial.id)),
        'real claim reached actual pre-step');
      require(!child.inbox.nextTurn.some(input => input.id === initial.id) &&
        !child.inbox.nextStep.some(input => input.id === initial.id), 'claimed initial input is not pending');
      require(!own.some(event => event.type === 'agent/inbox/spliced' &&
        event.data.settledIds?.includes(initial.id)), 'claimed initial input has not been filtered');
      require(!own.some(event => event.type === 'turn/end'), 'claim cut precedes actual terminal cleanup');
    } else if (mode === 'canceled') {
      require(trace.removedInitial === true && !claimed.includes(initial.id), 'public removal precedes initial claim');
      require(own.some(event => event.type === 'agent/inbox/spliced' &&
        event.data.outcome === 'canceled' && event.data.removedCount === 1), 'real canceled splice was persisted');
    } else if (mode === 'blocked') {
      require(claimed.includes(initial.id) && childPreSteps.some(batch => batch.includes(initial.id)),
        'reject control claimed the real initial input');
      require(own.some(event => event.type === 'agent/inbox/spliced' &&
        event.data.settledIds?.includes(initial.id)), 'Agent produced settlement from public reject decision');
      require(own.some(event => event.type === 'turn/end' &&
        event.data.reason?.kind === 'blocked'), 'Agent produced blocked terminal event');
    } else if (mode === 'fork-canceled') {
      const cut = child.session.inheritedEventCount;
      require(cut === trace.parent.lastEndSeq + 1 && cut > 0, 'real fork copies exactly the completed parent prefix');
      require(JSON.stringify(childEvents.slice(0, cut)) === JSON.stringify(leadEvents.slice(0, cut)),
        'inherited prefix is actual parent data, not a constructed log');
      require(initialInsertions[0].data.start === 1, 'child-owned q followed inherited pending P1');
      require(claimed.includes(parentP1.id) && !claimed.includes(initial.id), 'first child claim consumed only inherited P1');
      require(trace.removedInitial === true && !child.inbox.nextTurn.some(input => input.id === initial.id),
        'public queue removal consumed child-owned q');
      require(!own.some(event => event.type === 'agent/inbox/spliced' &&
        event.data.inserted.some(input => input.id === parentP1.id)), 'inherited P1 has not been reinserted as child-owned input');
      require(!own.some(event => event.type === 'turn/end'), 'fork cut precedes finally/recover or terminal cleanup');
    } else throw new FixtureError('unknown mode ' + mode);
    require(trace.modelCalls === 0 && failures.length === 0, 'setup has no model or contained-listener failure');

    async function readStored(runtime, id) {
      const reader = await runtime.ctx.sessionPersistence.open(id, 'read');
      try {
        const { events } = await reader.read();
        return { header: reader.header, inheritedEventCount: reader.inheritedEventCount, events };
      } finally { await reader.close(); }
    }
    const durableLead = await wait(readStored(producer, leadId), 'read real Lead bytes through JSONL');
    const durableChild = await wait(readStored(producer, child.id), 'read real child bytes through JSONL');
    require(JSON.stringify(durableLead.events) === JSON.stringify(leadEvents), 'Lead durable cut equals live cut');
    require(JSON.stringify(durableChild.events) === JSON.stringify(childEvents), 'child durable cut equals live cut');
    require(durableChild.inheritedEventCount === child.session.inheritedEventCount, 'durable inherited boundary matches');
    const paths = [];
    for (const id of [leadId, child.id]) {
      const source = await wait(ctx.sessionPersistence.resolveCurrentLog(id), 'resolve real current log');
      require(typeof source === 'string', 'current JSONL file exists');
      const name = relative(producer.storage, source);
      require(name !== '' && !isAbsolute(name) && name !== '..' && !name.startsWith('../'),
        'current log belongs to this fixture storage');
      paths.push({ id, source, name, bytes: await readFile(source) });
    }
    const recoveryStorage = join(root, 'cold');
    // Copy only this fixture's tiny native storage root, including its actual
    // encoding marker/lock files. New inodes carry no producer kernel leases.
    // No event, header, codec row, inherited cut or checkpoint is rewritten.
    await cp(producer.storage, recoveryStorage, { recursive: true, errorOnExist: true, force: false });
    trace.files = [];
    for (const file of paths) {
      const copied = await readFile(join(recoveryStorage, file.name));
      const after = await readFile(file.source);
      require(file.bytes.equals(copied) && file.bytes.equals(after), 'source and frozen log bytes remain exact');
      trace.files.push({ id: file.id, path: file.name, bytes: copied.length, sha256: sha256(copied) });
    }
    trace.claimedNotifications = [...claimed];
    trace.childPreSteps = childPreSteps.map(batch => [...batch]);
    trace.cut = {
      leadSeq: leadEvents.length, childSeq: childEvents.length,
      inheritedEventCount: durableChild.inheritedEventCount,
      pendingNextTurn: ids(child.inbox.nextTurn), pendingNextStep: ids(child.inbox.nextStep),
      events: own.filter(event => ['agent/inbox/spliced', 'turn/start', 'turn/end', 'user/message'].includes(event.type)),
    };

    // Graceful teardown happens only to the original files AFTER the raw cut.
    // It cannot edit the copied recovery logs. This is a cold-prefix experiment,
    // not a claim that this test kills an OS process or measures fsync/power loss.
    await closeProducer();
    require(failures.length === 0, 'producer cleanup succeeded before cold recovery');
    closing = false;
    const cold = await openRuntime(recoveryStorage);
    const recovered = deferred();
    releases.push(cold.ctx.on('session/event', observe('cold Team publication', (session, event) => {
      if (session.id === leadId && event.type === 'team/member' &&
          event.data.member.id === child.id && event.data.member.phase !== 'provisioning') {
        recovered.resolve(event);
      }
    })));
    releases.push(cold.ctx.on('agent/pre-step', async () => {
      fail('cold runtime', new FixtureError('cold classification must not start a model turn'));
      return { kind: 'reject' };
    }));
    require(cold.ctx.agents.get(child.id) === undefined, 'child is not live before Lead resume');
    const restored = await wait(cold.ctx.agentLoop.resume(cold.ctx, {
      resumeSessionId: leadId,
      agentOptions: { provider: 'fixture', model: 'fixture' },
    }), 'cold Lead resume');
    cold.handles.push(restored);
    const publication = await wait(recovered.promise, 'actual cold Team terminal publication');
    await wait(cold.ctx.sessions.flush(restored.agent.session), 'flush cold Team result');
    require(cold.ctx.agents.get(child.id) === undefined, 'classification did not resume child first');
    const row = cold.ctx.agentTeams.listMembers(restored.agent).find(value => value.id === child.id);
    require(row !== undefined, 'actual public Team row exists');
    const frozenChild = paths.find(file => file.id === child.id);
    require(frozenChild.bytes.equals(await readFile(join(recoveryStorage, frozenChild.name))),
      'cold classification did not change the child log');
    require(trace.modelCalls === 0 && failures.length === 0, 'cold consumer had no fixture failure');
    const outcome = { phase: publication.data.member.phase, status: row.status };
    trace.outcome = outcome;
    return outcome;
  } catch (error) {
    fail('fixture body', error);
    throw error instanceof FixtureError ? error : new FixtureError(summary(error));
  }
}
