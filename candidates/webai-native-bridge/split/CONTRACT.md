# WebAI split-process bridge candidate

This directory is an isolated Host/Main integration candidate. It does not modify or replace the earlier single-process bridge, SDK packages, shared shell source, Host startup, or installed profile. The earlier bridge keeps grants and native ToolRun state in Main and is not directly production-wirable across the existing Desktop/Host process boundary.

## Trust and composition

Host registers one exact route through the existing authenticated Fetch seam:

```js
ctx.connection.fetch.register({
  path: '/api/tradeloom.webai-native',
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: handler,
})
```

The SDK route has already admitted the request's Host/Origin and owner Peer. The handler then requires the Main-only `X-TradeLoom-Native-Bridge` header using timing-safe byte comparison. A missing key disables the endpoint and both native tools; it does not fall back to the Host cookie. The key is only an injected process value and request header. It is never placed in a message body, tool result, or preload API.

Host integration calls `createHostWebAiTransport({ ctx, nativeBridgeKey, authorizeNativeToolRun, listAuthorizedTargets, runtimeFiles, createFileTools, createToolEnvelope, toolManifest })`. The trusted `authorizeNativeToolRun({ exec, targetId })` callback must return the same live `exec` object, the selected target/provider/conversation identity, `isCurrent`, and (for file tasks) the native authorized root accessors and actual scoped DSH filesystem. Host registers `tradeloom_webai_targets` and `tradeloom_webai_ask` directly on its `ctx.tools`; it derives the request ID from `exec.callId`. Neither `authorizeNativeToolRun` nor `listAuthorizedTargets` is implemented or attached to the actual Cordis Host in this candidate; both are injected test seams. The fixture `ctx.tools.register` verifies the ToolDefinition shape, not production Host tool availability.

Main integration calls `createMainWebAiTransport({ nativeBridgeKey, hostFetch, publishProgress })`, where `hostFetch` is a private closure around the existing authenticated Host forwarder. The closure fixes method, path and header; renderer/preload callers cannot choose arbitrary URLs or headers. Main attaches the controller's actual `ownerWebContents`, provider `webContents`, and trusted provider adapter with `attachTarget(...)`. Main derives `windowId` from `String(providerWebContents.id)` and Host uses only that Main-registered value when creating the native file grant. The provider page receives no `ask`, grant, root, exec, or transport-key API. `transferOwner` changes only the observer object; it does not change provider target identity or generation.

The provider adapter must implement `inspect({ signal })` returning `{ conversationId, draftText, attachmentCount }`, `ask({ requestId, prompt, signal, conversationId, taskNonce, fileTask?, onProgress })`, `onConversationChange(listener)` returning an unsubscribe function, and for O07 `continueWithToolResult({ requestId, taskId, taskNonce, conversationId, result, signal })`. `inspect` must read the current provider DOM and return an empty draft and zero attachments before a send. Main checks the allowlisted origin both before work and after async inspection; navigation invalidates old work and a fresh trusted inspection is required to make the target ready. Missing conversation or incomplete inspection remains unavailable. Hiding/reparenting the same view does not detach it.

The transport belongs to the lifetime of the Main/controller service. Closing or transferring only the UI observer must not dispose it; observer transfer leaves provider work and Host target registration intact. When the controller service itself disposes, it best-effort removes only the targets it registered with Host and aborts its own pending `next` long-poll. Disposal does not pretend an abort-ignoring provider operation has physically settled; its WebContents tail remains held until the adapter promise actually returns.

## Wire messages

The only endpoint is `POST /api/tradeloom.webai-native`. Request bodies are strict JSON DTOs; unknown fields fail closed. `hello` establishes a random Host instance ID. Main then upserts targets, long-polls `next` for commands, and posts correlated events. A target with no confirmed conversation is unavailable. Target selection is explicit by `targetId`; neither side chooses the first available page.

Main-to-Host messages are `hello`, `target`, `remove-target`, `next`, and `event`. Host-to-Main commands are `ask`, `tool-result`, `cancel`, and `release`. Target upserts include the trusted provider window ID; target removal revokes the registration. Events and commands carry `hostInstanceId`, `jobId`, `targetId`, generation, request ID, and task nonce. Assistant observations retain the real source/role/new-message/completion/content fields and must match the live conversation, task nonce and request ID. Within a job, retransmitting the same message ID and canonical observation is acknowledged idempotently without resolving it twice; changing content under that ID returns `MESSAGE_ID_CONFLICT`. Neither case executes a second file operation or treats the replay as a final answer. The wire validator rejects executable objects and authority-bearing fields such as `exec`, filesystem handles, roots, grants, capabilities, signals, and WebContents. Arguments are exact-schema checked; prompts are limited to 64 KiB UTF-8 on both ends. After asynchronous file-task setup and immediately before dispatch, Host rechecks the live exec, target generation and authorization callback.

The Host instance ID is an epoch. After restart, an HTTP 409 makes Main re-handshake and re-register current targets; it never resends an old ask. A missing, late, or mismatched response fails or times out; it is not reported as success. `release.completed` means Host received a final answer; cancellation and error releases carry `false`. Main separately sends `settled` only after the adapter operation and any same-task continuation actually return. Host removes the job only after native execution has ended and this correlated physical-settled event arrives. Native cancellation sends `cancel`; the provider operation may continue if its adapter ignores abort. Main's per-WebContents physical tail remains held until the underlying adapter operation and any same-task continuation actually settle, even if the Host tool has already timed out.

## O07 stays in Host

For `withFiles`, Host creates the per-execution runtime binding, grant, task nonce, and envelope using the existing `createWebAiFileTools`, `createWebAiToolEnvelope`, and `runtimeFiles.bind/execute/revoke` interfaces. Main receives only the task ID/nonce and the static `WEB_AI_TOOL_MANIFEST` object (version/kind/notice/tool names and argument names); grant objects, root paths, filesystem handles, and native `exec` stay in Host. Main returns a newly observed assistant message; Host validates it through the existing envelope, executes the file request under its native runtime, and sends the bounded result back to the same provider conversation. Only a plain final message rejected specifically as `INVALID_ENVELOPE` ends the file task; malformed or mismatched `tradeloom-file-task` content and repeated message IDs fail closed and cannot become a successful answer. Host revokes the task in its `finally` path.

## Verification

Run from the independent backend main checkout:

```powershell
$env:TRADELOOM_WEB_AI_SHELL_ROOT='C:/Users/23825/Desktop/ICT/tradeloom/packages/tradeloom-shell'
node --test candidates/webai-native-bridge/split/split.test.mjs
```

The focused suite exercises the actual Fetch route handler with synthetic headers and `Request` objects, serializes JSON between independent Host/Main modules, exercises navigation/inspection/origin guards and the HTTP 409 epoch path, and composes the real shared `WEB_AI_TOOL_MANIFEST`, filetools, and envelope factories across read, new-file write, result continuation and revoke. Its ToolRuntime authorization, filesystem, and runtimeFiles are controlled fixtures. It does not prove actual SDK Host registration, Main-to-Host forwarder wiring, real DSH ToolRuntime/LocalFileSystem execution, provider DOM observation, login, GUI behavior, external model behavior, or a packaged runtime deployment. The provider adapter and Host ToolRuntime context in tests are fixtures. No original SDK/shared production file or profile is changed by this candidate.

## Optional Host native ask/list consumer

`host-native.mjs` adds a Host-only deferred installer. It waits through Cordis `ctx.inject` for `connection`, `tools`, `agents`, `sessions`, and `workingDirectory`, then requires an injected `getNativeBridgeKey`, an injected `loadRuntimeSdk()` returning the installed SDK's `{ ToolRuntime, scopeOf }`, and an explicit `authorizeTarget({ action: 'list' | 'ask', caller, target })` callback. Missing key/runtime/policy or a tool-name collision leaves the feature unavailable and does not register its route or tools. It invokes the existing `createHostWebAiTransport` with the real Host context and no file runtime dependencies; `withFiles:true` returns `FILE_TOOLS_UNAVAILABLE` before an ask command is sent.

`createNativeWebAiAuthorization` observes the real `tools/execute` waterfall with an around handler that preserves and returns the SDK's actual `next()` result. It authorizes only the exact `exec` object while that native tool's execution is live, with the expected ask/list tool name, active AgentRegistry and SessionStore object identities, exact agent scope, scoped `agent.ctx.get('fs')`, and scoped `workingDirectory`. It awaits `workingDirectory.ensure(agent, signal)`, then checks that the current session cwd equals the exact path returned by `ensure()` and rechecks the same agent/session/filesystem/workdir identities. Cordis 4.0.5 publicly exports `symbols.original` (`@deepseek-ai/cordis/lib/index.js`); the adapter uses its `Symbol.for('cordis.original')` marker to compare provider-service identity while retaining the scoped proxy for calls.

The target policy receives `caller` with the actual live `exec`, agent, session, scoped filesystem and working directory, plus a workspace-membership snapshot from the real optional `workspaceRegistry` when present. `workspaceRegistry.list()` returns Workspace entities whose public identifier is `id` (not `workspaceId`); the adapter derives `caller.workspaceMembership.workspaceId` from that `id`, with `path` and `sessionIds` membership. Missing membership is `null`; the adapter invents no workspace ID and does not require cwd to equal a workspace root. Each target snapshot is accepted only when available and has explicit target ID, generation, provider, window and conversation identity. After every asynchronous authorization step, the adapter rechecks caller cwd/membership and compares those target identity fields; an equivalent replacement DTO remains valid. Listing calls policy action `list` per target; ask calls action `ask` again for the explicitly supplied target ID. A list result never grants ask authority. Missing target policy is unavailable, and no policy defaults to all targets or agents.

The injected target policy is still a production integration seam: this candidate does not define which real agent may access which Main-owned page, and the current target DTO has no native-session/workspace binding. Therefore production workspace isolation is not claimed. The policy integration must make its own explicit decision from the supplied live caller and target facts before enabling the feature. `withFiles:true` is rejected by the native authorizer as `FILES_POLICY_UNAVAILABLE` before target policy or Host job creation; this helper does not instantiate file runtime capabilities.

The focused real-SDK check is:

```powershell
$env:TRADELOOM_DSH_RUNTIME_ROOT = Join-Path $env:LOCALAPPDATA 'Temp/tlr4p/targets/win-x64/dsh'
node --test candidates/webai-native-bridge/split/host-native.test.mjs
```

It loads the same rep4 compiled DSH SDK module classes, drives `createHostWebAiTransport` through an actual AgentLoop/ToolRuntime tool call, and uses a synthetic transport target registry, synthetic native bridge key, test-only target policy and deterministic local script model. It verifies missing key/policy/dependencies leave no tools or route, exact live-exec use and expiration, list/ask policy separation, target/cwd/workspace-membership changes during asynchronous authorization (with a `WorkspaceRegistry` entity shaped as `{ id, path, sessionIds }`), and explicit `withFiles` rejection before policy/job/command creation. It does not verify production policy, actual Host bootstrap installation, real workspace isolation, Main controller/DOM observation, GUI, or an external model. No SDK/shared/profile source is modified.

This batch ran `node --test candidates/webai-native-bridge/split/host-native.test.mjs` with 4 passing tests and 0 failures. `node --check` for both new modules and `git diff --check` also returned exit 0.
