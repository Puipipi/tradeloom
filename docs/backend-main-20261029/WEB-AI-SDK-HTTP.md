# WebAI SDK HTTP carrier acceptance

This isolated acceptance composes the rep4 installed SDK modules from one `node_modules` root. It starts the real Cordis `dsh-host-webserver`, `dsh-client-connection`, and `dsh-credentials-local`, mounts the candidate optional WebAI Host consumer in that Context, and connects the real candidate `split/main.mjs` transport to the same loopback HTTP listener through a private cookie/header wrapper.

The runner makes a unique `mkdtemp` root under the OS temporary directory. The SDK `LocalCredentialProvider` receives an explicit absolute `private/.credentials.yaml` path with `watch:false`; its sibling `workspace/` is the only SandboxPolicy, filesystem, and working-directory root. `dsh-client-connection`'s real `authenticatedUrl(origin + '/connect?interactions=none')` and `BrowserAuth` issue a cookie using the credential record generated in this new file. The cookie and a fresh synthetic native bridge key exist only in memory and are never written to output. The runner neither loads a saved DSH profile nor prints URLs, headers, cookie values, credentials, or raw errors. Its `finally` disposes the optional transport and Context, confirms a fresh loopback request cannot reach the listener, and removes only its checked `tl-webai-sdk-http-*` temp root before printing a passing result.

## Run

From the independent main checkout in PowerShell:

```powershell
$env:TRADELOOM_DSH_RUNTIME_ROOT = Join-Path $env:LOCALAPPDATA 'Temp/tlr4p/targets/win-x64/dsh'
node testing/webai_sdk_http_acceptance.mjs
```

For only the real SDK carrier/authentication preflight:

```powershell
node testing/webai_sdk_http_acceptance.mjs --carrier-only
```

The `--carrier-only` mode still starts and disposes the real Context and loopback listener, and creates/removes its unique temporary credentials/workspace root.

## Actual checks

- A real SDK `authenticatedUrl()` `/connect` exchange returns 302 and an in-memory cookie.
- The protected candidate route returns 401 without that cookie, 401 with a missing or wrong native bridge header despite a valid cookie, and 403 for an invalid Origin or invalid Host.
- A valid cookie plus the per-run native header returns 200 for `hello`. The candidate Main transport then sends the matching host epoch, attaches one target using EventEmitter WebContents fixtures, and lets Main derive the target generation and `windowId` from the inspected conversation and provider object before registering it over the real HTTP route. The runner captures the actual HTTP response status for the `target` request and asserts it is 200; the report emits that captured status rather than a literal.
- The real SDK AgentLoop and ToolRuntime execute the candidate list and ask tools. Outer `tool/result` receipts are checked for success, exact tool-call IDs, returned target identity, and the complete page-fixture answer/request ID. Main's bounded `pollOnce()` loop receives the ask command; its trusted fixture adapter returns one complete, correlated observation over the HTTP carrier.
- The test waits for Main to receive the Host `release`, post its own `settled` event, and for both Main and Host job maps to reach zero. It does not manually synthesize an acknowledgement or settled event.
- `withFiles:true` produces an SDK tool error `FILES_POLICY_UNAVAILABLE`; it creates no Host job and dispatches no page request.
- Teardown follows Main dispose and poll cancellation, then Host consumer dispose and Context dispose. A `node:net` connection to the exact owned loopback port must fail with `ECONNREFUSED`, and a filesystem `stat` of the removed unique temp root must fail with `ENOENT`, before a success result is emitted.

## Evidence and limits

The complete run on 2026-10-30 returned exit 0 with the safe status tuple: cookie exchange 302; no cookie 401; wrong and missing native header 401; bad Origin and Host 403; authenticated `hello` 200; SDK list and ask receipts successful; `withFiles` returned `FILES_POLICY_UNAVAILABLE`; one Main-adapter fixture ask; one Host release consumed; one Main-generated settled event acknowledged; both transport job maps empty; listener refused a new socket with `ECONNREFUSED`; temporary root was absent with `ENOENT`. The carrier-only run also returned exit 0 with the same authentication statuses and confirmed cleanup.

These are real SDK WebServer, Connection, BrowserAuth, LocalCredentialProvider, Cordis, ToolRuntime, AgentLoop, and HTTP socket checks inside one Node test Context; SDK `connection.apply(ctx, config)` is invoked after its real credential and WebServer services are loaded. The candidate Main transport code is also real and exercises its attach, inspect, ask, polling, release, settled, and disposal paths. Its owner/provider WebContents are EventEmitter fixtures, and its page adapter, target policy, target list, and deterministic local ScriptAdapter are controlled fixtures. This is not an Electron Main/Host two-process test and does not use actual WebContents, a provider webpage or DOM, a production Host bootstrap, an external model, user profile, or business data. The target policy grants only the unique test agent and one explicit fixture target. File operations are deliberately not enabled or tested here; they remain unavailable pending separate safe policy/runtime acceptance. This does not establish production target authorization or workspace isolation.
