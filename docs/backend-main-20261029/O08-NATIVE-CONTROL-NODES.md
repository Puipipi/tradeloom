# O08 Native input / output control nodes

This is an independent backend worktree change. It adds local `input` and `output` control-node execution to the existing native workflow service; it does not connect or certify the production Host, frontend canvas, Electron transport, or a complete O08 rollout.

## Supported definition

The native path accepts only `input`, `agent`, and `output` nodes, and requires at least one permitted agent node. `review` and `external` remain unsupported. Center-role agents, unavailable role presets, empty agent instructions, disallowed models, and existing authority checks retain their current rejection behavior. Permissions and model checks run only for `agent` nodes.

```json
{
  "version": 1,
  "id": "mixed-example",
  "title": "Input, work, result",
  "confirmed": true,
  "nodes": [
    { "id": "source", "kind": "input", "title": "Input", "instruction": "Exact local input." },
    { "id": "work", "kind": "agent", "agent": "product", "title": "Work", "instruction": "Process the supplied input." },
    { "id": "result", "kind": "output", "title": "Output", "instruction": "Ignored for output content." }
  ],
  "edges": [ { "from": "source", "to": "work" }, { "from": "work", "to": "result" } ]
}
```

`input` emits the normalized definition's exact `instruction`; an empty instruction emits the empty string. `output` joins verified direct-parent text in definition-node order with a newline. Agent output accepts the existing string form or arrays containing only text blocks; reasoning and tool blocks are rejected as local output input. Local controls do not invoke SDK tools, create sessions/children, or fabricate artifact declarations.

## Prepared and run DTOs

For the example, `prepare` reports `graph.nodeCount: 3`, the existing `graph.edgeCount` and `maxConcurrent: 1`, `roleIds: ["product"]`, and ordered graph nodes. Agent graph entries keep the prior `{id, roleId, agentPreset}` shape. A local graph entry is `{id, kind, executionMode:"local"}`. The legacy all-agent graph and single-agent fields remain readable.

Completed local run nodes project their `kind`, `executionSource: "workflow/local"`, output, `artifactState: "unknown"`, and a distinct local terminal receipt. Agent nodes retain their existing `subagent/end` terminal receipt and artifact-proof path. A local completion contributes to run execution completion only after its receipt is re-derived and checked; `succeeded` still means execution completed, not that the business result is correct.

The journal stores a local receipt tied to run/workflow/node, definition and binding revisions, `mode`, ordered verified upstream records, and derived output. Local nodes have `attempt: 0`, null request/tool/child/native-run identities, empty artifacts, and `artifactSource: "unknown"`. Their events use source `workflow/local`; local event request IDs remain null. Journal and UI projection both reject altered output, receipt, identity, local proof attached to an agent, or artifact claims on a local node.

If a local derivation cannot verify an upstream, it records a fixed local failure (currently `upstream_terminal_unverified`, `upstream_output_unavailable`, `local_receipt_invalid`, or `local_output_unavailable`) without a success output. Existing blocked-node propagation marks descendants skipped. An interrupted pending local node remains pending; explicit resume can continue it. Previously completed local receipts remain done and are not executed again during resume or journal recovery.

## Evidence

The targeted existing native service, UI, and artifact HTTP suites passed **124/124 with zero skips** after the terminal-run and explicit-resume guards. Raw command, stdout and exit are in [the final native suites record](../../recovery-20261029/o08-native-control-nodes-20261031/testing/raw/final-native-suites-after-resume-guard/).

A separate [rep4 SDK mixed-control scenario](../../recovery-20261029/o08-native-control-nodes-20261031/testing/raw/rep4-mixed-controls-final/) passed with exit 0. It exercised the existing UI handler, native service/journal, real rep4 Cordis Context, Commands, ToolRuntime, AgentLoop, Session, AgentPresetRegistry, Subagent manager, in-process spawn provider, official `tool-subagent`, and JSONL child persistence. The local deterministic ScriptAdapter completed one real child. The scenario observed a three-node input/agent/output graph, one SDK child start/end, one agent attempt, two local terminal events with attempt 0 and null SDK identities, and `prepare 200 → submit 202 → get 200`.

The same mixed-control flow also passed through the rep12 release's `tsx` loader against the fixed [rep12 SDK root](../../recovery-20261029/o08-native-control-nodes-20261031/testing/raw/rep12-mixed-controls-final-tsx-fileurl/): version `0.2.1-rc.3`, using its pinned compiled module paths. The run reported `installed rep12 SDK modules`, one child start/end, one agent attempt, two local terminal events with attempt 0 and null SDK identities, and `prepare 200 → submit 202 → get 200`. This is a distinct rep12 result; the earlier rep4 receipt remains separate.

Both SDK scenarios use fixture-provided center role state, workspace registry, connection admission, and settings; their run stores are in memory and the model adapter is local and deterministic. They are not production Host/bootstrap, GUI, frontend canvas, external model, PostgreSQL, or deployed runtime evidence. The explicit `resume` requirement after startup recovery and terminal-run guard are covered by the service tests; they do not add a production Host lifecycle claim.
