# F11 MCP runtime status and explicit control

This backend slice projects an already-running MCP client connection for one explicitly bound SDK Agent. It does not load MCP configuration or create a connection. The current package exports `@tradeloom/dsh-business-shell/mcp-runtime`.

## Host composition

The Host must compose the registry with the same Cordis root and the SDK `ScopedLayers` and `NamedEntries` implementations. The candidate `mcp-client` patch under the recovery record optionally injects `mcpRuntime` and registers its existing connection handle. Registration belongs to the injected Cordis fiber (`inner`), so removing the service retracts the old registration and permits a later registry to attach to the same live handle. `registry.close()` closes the projection, not the MCP connection; normal plugin lifecycle still owns connection disposal.

```js
import { createMcpRuntimeRegistry, createMcpRuntimeController } from '@tradeloom/dsh-business-shell/mcp-runtime'

const registry = createMcpRuntimeRegistry({ ctx, ScopedLayers, NamedEntries })
ctx.effect(() => () => registry.close(), 'mcp-runtime-registry')
const controller = createMcpRuntimeController({
  ctx,
  readSavedConfiguration: (agent, serverName) => trustedConfigurationReader(agent, serverName),
  authorizeControl: request => trustedControlPolicy(request),
})
const binding = controller.bindAgent(agentId)
const observation = controller.read({ binding, serverName: 'docs' })
// A control must use the currently observed instance identity.
await controller.control({ binding, serverName: 'docs', instanceId: observation.runtime.instanceId, action: 'restart' })
ctx.effect(() => () => controller.dispose(), 'mcp-runtime-controller')
```

The producer must register the registry before loading `mcp-client`; Cordis also supports late service injection. On teardown, dispose the controller and await `registry.close()`. The injected `mcp-client` registration is removed with its injection fiber. Do not dispose an MCP handle through the registry: the MCP plugin remains its lifecycle owner.

## Read contract

`bindAgent(agentId)` returns `{agentId, sessionId, generation}` for the actual current `ctx.agents.get(agentId)` object. `read({binding, serverName})` validates that exact Agent and session again and consults only the SDK scope registry. `available` responses include `target`, `serverName`, `savedConfiguration`, `scopeTools`, and a safe runtime projection. `not_registered` means the registry exists but has no handle in that scope; `unavailable` means the registry is missing/closed. Runtime phases are limited to `connecting`, `connected`, `reconnecting`, `disconnected`, `reconnect_exhausted`, `closing`, `disabled`, `closed`, and `closure_unconfirmed` (otherwise `unknown`).

`connected` is true only when the SDK handle reports the connected phase and enabled state. The MCP plugin can keep old ToolRuntime entries registered while disconnected; therefore `connected: false` may coexist with a nonzero `scopeTools.registeredToolCount`. Tool registration only proves visibility, not that a tool call will succeed or be authorized.

Saved configuration is `unknown` unless the trusted optional reader returns `{status:'saved', enabled:boolean}` or `{status:'not_configured'}`. The runtime module does not infer saved configuration from a loaded handle and never projects command, URL, headers, environment, or other raw configuration. The existing managed agent-configuration controller remains the owner of saved settings and snapshots.

`list({binding})` enumerates effective server handles from the actual SDK `ScopedLayers.merge(agent, ...)`, so global entries and an Agent's same-name override appear once. Each result separates the session binding (`session.status`), optional saved catalog (`savedConfiguration`), and loaded handles (`runtimeRegistry` and each row's `runtime`). The optional `readSavedConfigurationCatalog(agent)` is a trusted synchronous reader returning `{status:'known', servers:[{serverName, enabled:boolean|null}]}`, `{status:'not_configured'}`, or unknown/failed data. A known catalog is complete and is unioned with live handles. A catalog-only row has `runtime:null` and `scopeTools.status:'not_registered'` if the registry was enumerable. Without a complete catalog, saved state remains `unknown`; live handles do not prove the saved catalog is complete.

Each live handle may report its exact owned public tool names as `scopeTools.tools:[{publicName,visible:boolean|null}]`. The SDK candidate associates each name with the exact `ToolDefinition` registered by that connection (using its disposer identity), then compares it with `ToolRuntime.get(publicName, agent)`. A same-name foreign scoped definition therefore yields `visible:false`. Unknown lookup support yields `visible:null`. `visible:true` means presentation visibility only; it does not prove execution policy authorization or successful invocation. The view contains no description, schema, arguments, or credentials. Listing is local: it does not call MCP `tools/list`, ping, reconnect, or probe the provider.

`read({binding, serverName})` uses the same saved-catalog projection as `list`. If only the legacy per-server reader is supplied, it remains a best-effort row projection; it does not create a complete saved catalog.

## Control contract

Only `restart`, `enable`, and `disable` are accepted. A caller must pass the observed `instanceId`; a stale instance is rejected. The controller requires an injected trusted `authorizeControl` callback to return literal `true`, then rechecks the Agent/session, registry identity, and exact handle before invoking the SDK lifecycle method. Missing authorization is forbidden. The callback receives `{action, serverName, target, instanceId}`; this callback is not a model/tool permission grant.

The SDK candidate serializes lifecycle actions and fails closed when prior transport closure cannot be confirmed. It will not start another transport in `closure_unconfirmed`. Registry close notifies subscribers without allowing a listener exception to block Cordis service removal. Controller subscriptions are released on rebind or dispose.

## Evidence and limits

The original lifecycle baseline had 8/8 controller tests and 4/4 SDK composition tests. The current grouping addendum passes 10/10 controller tests, 5 SDK composition tests, and 33/33 existing focused rep12 MCP-client regressions against the owned four-file SDK overlay; overlay `tsc --noEmit` and the owned tsdown build also exit 0. The SDK cases cover effective global/Agent grouping, a saved-only row, exact ToolRuntime definition ownership under a same-public-name foreign shadow, no extra list-triggered network calls, disconnect with a still-visible tool, resync without stale names, late injection, close/unprovide/remount, unload, and controlled closure behavior. SDK peer imports remain external in the owned bundle.

The `mcp-client` edits are a recovery candidate, not applied to or rebuilt into the pinned SDK. No production Host bootstrap, real saved-configuration authority, real control authorizer, remote MCP server, UI, or GUI was mounted. This does not complete F11 or the broader task set.

Raw commands and output are linked in [validation](../../recovery-20261029/f11-mcp-runtime-20261031/VALIDATION.md).
