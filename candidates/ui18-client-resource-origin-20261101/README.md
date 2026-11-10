# UI18 client resource origin diagnostic candidate

This is a temporary diagnostic patch for one compiled member in the installed UI18 archive. It does not modify the installed archive, start the Host, or write to the diagnostic receipt directory during development.

## Pinned target

- Installed archive: `C:/Users/23825/Desktop/TLUI-18-20261101/app/resources/app.asar`
- ASAR member: `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`
- Extracted with the already-installed `@electron/asar` 4.3.1 from the UI wiring tools; no dependency was installed.
- Before: 17,907 bytes, SHA-256 `7d8d98304c2b66492b715fcdd357f30e247c92ee1aee435883bb568fbd3eaa21`.
- Candidate after: 21,078 bytes, SHA-256 `8341045a11cabac8b653f5b8f92f59ab596510079fecd2352a39ba03a1b00ac7`.
- The extracted member is byte-pinned under `before/index.js`; the standalone replacement is `after/index.js`; `ui18-client-resource-origin.patch` uses portable `a/index.js` / `b/index.js` paths.

The insertion is in the compiled Host's `main()` immediately after it computes the existing web origin and before it sends the normal `ready` IPC message. It schedules one diagnostic promise without awaiting it. The normal ready message does not wait for bundle reads or receipt writing; all diagnostic failures are contained and are not logged.

## Fixed observation

The diagnostic observes only these client-module IDs, in fixed order:

1. `@deepseek-ai/dsh-client-ui-settings-general`
2. `@deepseek-ai/dsh-client-ui-theme`
3. `@deepseek-ai/dsh-client-ui-layout`

For each ID it checks `ctx.clientModules.graph()` and `clientPath(id)`. A client path is emitted only if it is a local absolute drive path and contains no Windows-invalid path characters; URL, UNC, and arbitrary values are omitted with a fixed error code. A revision is emitted only if it is a bounded hexadecimal digest or decimal string. If a graph entry exists, it calls the existing in-process `ctx.clientModules.fetchBundle(new Request(new URL(entry.url, origin)))`, reads response bytes in memory, and records only byte count and SHA-256 on status 200. This uses the client's bundle resource API; it is not an HTTP request or HTTP acceptance test.

The fixed receipt destination is `C:/Users/23825/AppData/Local/Temp/tradeloom-launch-diag-20261031/ui18-controller-runtime-diagnostic-20261101/ui18-client-resource-origin.json`. The directory was verified before authoring. The patch does not create the parent directory; a missing directory or write error is swallowed so the existing ready flow remains unchanged.

The receipt allowlist is limited to top-level `processId`, `observedAt`, and `items`; item fields are `id`, validated `clientPath`, validated `rev`, `status`, `responseBytes`, `responseSha256`, and fixed `errorCode`. It never serializes entry URLs, origin, headers, response body, exception messages, or stacks. Errors are fixed codes such as `client_modules_unavailable`, `entry_missing`, `client_path_invalid`, `bundle_reference_invalid`, `bundle_fetch_failed`, `bundle_http_non_200`, `bundle_read_failed`, and `entry_inspection_failed`.

## Verification and deployment boundary

The focused fixture extracts the diagnostic function from the actual patched compiled member and substitutes only `clientModules` and filesystem writing. It checks success hashing, missing entry, unsafe path/revision omission, non-200, API/fetch/body/write failures, secret exclusion, and that the host schedules the promise before `ready` without awaiting it. It does not execute the Host, access the fixed receipt directory, make a network request, or prove installed UI18 runtime behavior.

The resource graph API is documented in the pinned candidate SDK source at `packages/client/modules/src/index.ts:679-700`; the source Host composition is `apps/desktop-host/src/index.ts:178-192`. The actual installed archive member—not the source TypeScript—was used as the patch base.

The frontend owner must assemble and review the diagnostic build. Apply only this member replacement to a copy of the pinned archive and verify the pinned before hash first. Do not rebuild the archive from a newer source tree or deploy this diagnostic permanently. After the receipt is collected, remove the temporary instrumentation by restoring the original member (the exact `before/index.js` bytes). This candidate is not deployed and is not a host/runtime acceptance result.
