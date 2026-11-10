# F13: target-session usage projection

This backend slice reads the pinned SDK's current projection snapshot for one explicitly bound live Agent. It does not estimate from message text, replay a second counter, or submit a message.

## Consumer contract

```js
import { createSessionUsageController } from '@tradeloom/dsh-business-shell/session-usage'

const usage = createSessionUsageController({ ctx })
const binding = usage.bindAgent(selectedAgent.id)
const snapshot = await usage.readUsage({ binding, signal })
// Rebind when the selected Agent changes. Dispose with the owning Host.
await usage.dispose()
```

The trusted composition must provide the live `ctx.agents` registry and the actual `sessionController.projections` service. `bindAgent` returns a frozen opaque preselection snapshot `{ agentId, sessionId, generation }`. `readUsage` accepts that handle and an optional `AbortSignal`; it does not accept a caller-selected session ID. A changed Agent/session, binding, or projection service rejects the read instead of delivering a late result to another target. Cancellation settles the caller promptly; a provider that ignores cancellation remains in-flight until its read settles, and `dispose()` joins it.

Successful results have one of these shapes:

```js
{ status: 'missing', target: { agentId, sessionId, generation } }
{ status: 'migration_required', target: { agentId, sessionId, generation }, unknownProjections }
{
  status: 'available', target: { agentId, sessionId, generation }, asOfSeq,
  projections: { sessionStats, tokenUsage, contextPressure, contextBreakdown, compactionStats? },
  unknownProjections: []
}
```

`available` includes only projection keys actually present and validated against the known projection contracts. Missing keys are listed in `unknownProjections`; an empty registered projection stays an empty projection and is not filled with invented values. Source zeroes are preserved. `missing` means the SDK returned `null`; it is different from a sequenced snapshot whose fields are unknown. `migration_required` hides cached migration hints and reports all projections as unknown because those hints are not current sequenced statistics.

Stable thrown codes are `session_usage_unavailable`, `session_usage_closed`, `session_usage_invalid_arguments`, `session_usage_agent_unavailable`, `session_usage_target_changed`, `session_usage_source_changed`, `session_usage_cancelled`, `session_usage_read_failed`, and `session_usage_projection_invalid`.

## Meaning and limits

`sessionStats` counts closed turns/steps and its documented model/tool/first-token/decode durations; failed and cancelled closed steps can count. It is not a count of successful user requests. `tokenUsage` is provider-reported usage folded by the SDK. `contextPressure` and `contextBreakdown` are SDK estimates of the prompt/current retained surface; they are approximate and are not billing, budget, or execution-gating authority. The `asOfSeq` cut belongs to that SDK projection response; the SDK represents an empty-log cursor as `-1`.

## Compaction lifecycle projection

The optional package subpath `@tradeloom/dsh-business-shell/session-compaction-stats` exports `registerSessionCompactionStatsProjection(ctx, { z })`. The Host supplies its existing Zod namespace; the registration fiber must declare/inject `sessionProjections` before calling the helper:

```js
const compactionStatsPlugin = {
  name: 'tradeloom-compaction-stats',
  inject: ['sessionProjections'],
  apply(ctx) { registerSessionCompactionStatsProjection(ctx, { z }) },
}
await hostContext.plugin(compactionStatsPlugin)
```

The call registers a normal SDK `ProjectionDefinition` in the calling Cordis fiber and returns its disposer. The namespaced SDK key is `tradeloomCompactionStats`; `session-usage` presents its value as `projections.compactionStats`. If the module is not mounted, the SDK value is absent, or the response is `migration_required`, `unknownProjections` includes `tradeloomCompactionStats` instead of showing invented zeroes.

The value is `{ attempts, summaryApplied, completed, failed, inflight }`. An attempt begins at a valid `compaction/start`. A produced `compaction/summary` is not counted as applied by itself: the counter advances only when the immediately following `user/message` is a `surfaceOp.replace`, exactly matches the summary's shadowed range, and its `sourceEventSeqs` references both the start and summary sequence. A matching `compaction/end` without an error increments `completed`; an end carrying an error increments `failed`; a start without an end remains in `inflight`. `summaryApplied` is recorded at the replacement event even if the later end is missing or fails. `compaction/prune` is a model-free replacement and is not counted as summary compaction.

The projection stores only open-attempt IDs, sequences, owner metadata, and ranges plus counters; it does not retain summary text, raw output, provider/model detail, or error messages. It is an SDK log-derived projection, not a separate history scan or ledger. These counters do not estimate saved tokens, cost, budget, limits, paused state, or whether compaction improved quality.

Consumers should render each result as one snapshot for its `{sessionId, generation, asOfSeq}` target cut. A later read produces a new cut; these values are not a live event stream. V13 cost/credits/limits/paused fields remain unknown unless a separate authoritative source is added.

Compression lifecycle counts are available only when the optional projection is mounted. Cost, account balance, limits, paused state, and remaining budget remain unknown because no authoritative source is provided here. An account wallet is not session cost. No raw messages, provider credentials, or migration cache values are returned.

## Evidence boundary

The pinned rep12 usage integration mounts the actual Cordis `SessionStore`, `SessionProjectionRegistry`, session-stats and token-meter plugins and invokes the actual `SessionController.projections` method against those stores. Its reducer-focused lifecycle evidence uses SDK-valid synthetic events appended through `Session.append`; that earlier test did not invoke the compaction producer and remains recorded as historical evidence.

An additional focused rep12 composition now invokes the real `BasicCompactionEngine.compactRegion` producer with a subclassed, fixed local `summarize()` hook. In the success case the producer itself emits start, summary, matching surface replacement, and end; the normal projection read through the actual `SessionController.projections` method reports one applied/completed attempt. In the failure case the same producer emits a failed end, does not replace the original surface, and the projection exposes only counters. This proves producer-to-projection composition, not model summarization: the summarizer is a deterministic fixture, and the test does not construct the full Remote/Host admission stack or use user-session data. Production Host mounting, Remote transport, UI, billing, external providers, and real model output remain unverified. Raw output is in [the actual-producer evidence](../../recovery-20261029/f13-session-compaction-stats-20261031/actual-producer-20261031/VALIDATION.md); the earlier usage-only evidence remains at [its historical N02-slug path](../../recovery-20261029/n02-session-usage-20261031/VALIDATION.md), and the focused reducer/checkpoint evidence remains in [the F13 compaction recovery](../../recovery-20261029/f13-session-compaction-stats-20261031/VALIDATION.md).
