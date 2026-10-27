# Host/child ask broker candidate

`host-bridge.ts` is an isolated candidate for the typed parent/child IPC boundary described in `BRIDGE-CONTRACT.md`. It is not imported by `host-process.ts`, `desktop-host/index.ts`, or the application entry points, so it has no runtime effect.

The parent factory is instantiated for one owned child channel and accepts only exact-shape `ai-web-ask` / `ai-web-ask-cancel` messages. It validates request IDs, fixed providers, prompt limits and result fields, correlates results per request, and aborts owned work on cancel, owner close, or child disconnect. The child client uses monotonically increasing IDs, ignores unknown response/control messages, sends cancellation, and rejects when the channel is unavailable. `childProcessChannel` is a thin adapter for a Node `ChildProcess` in the parent and `process` in the child; each side must bind its own channel instance.

No `ctx.tools` registration is included: the runtime tool schema/render API has not been verified for this candidate. The implementation does not add HTTP, URL, cookie, filesystem path, or script inputs. Site adapters remain separate.

## Verification

From the ICT checkout root:

```powershell
node --experimental-strip-types --test integrations/dsh/native-ai-web/host-bridge.test.mjs
node <runtime16>/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --typeRoots <runtime16>/node_modules/@types integrations/dsh/native-ai-web/host-bridge.ts integrations/dsh/native-ai-web/ask.ts
```

The fixture uses real Node child-process IPC to check concurrent result correlation, cancellation propagation, and pending-work cleanup on child exit. It does not emulate the Host runtime, register a native tool, connect a BrowserWindow, or prove website/model behavior.

## Runtime package boundary (read-only preparation)

Runtime16 has no existing shared desktop IPC protocol package that is a direct dependency of both apps. `@deepseek-ai/dsh-sdk-protocol` and `@deepseek-ai/dsh-hook-protocol` have different responsibilities and are not dependencies of these app packages. Importing `apps/desktop-host/src/*` from `apps/desktop/src/*` crosses both apps' `rootDir: "src"` boundaries and is not a valid shared-source strategy.

The narrowest candidate is to publish the shared wire DTO/validators as an explicit `@deepseek-ai/dsh-desktop-host/host-ipc-protocol` subpath from the existing private desktop-host package:

- Add one pure shared source module under `apps/desktop-host/src/host-ipc-protocol.ts`; child code imports it locally, while the desktop parent imports the package subpath.
- `apps/desktop-host/tsconfig.json` emits from `src` to `lib/types` (JS and declarations). Its `tsdown.config.ts` currently bundles `lib/types/index.js` and `cli.js` to `lib/index.js` and `lib/cli.js`; add the protocol entry there to produce `lib/host-ipc-protocol.js`. Then add an `exports["./host-ipc-protocol"]` entry and include `lib/host-ipc-protocol.js` plus `lib/types/host-ipc-protocol.d.ts` in `apps/desktop-host/package.json` `files`.
- Add `@deepseek-ai/dsh-desktop-host: workspace:*` as a desktop dev dependency for compile-time package resolution, plus a project reference from `apps/desktop/tsconfig.host.json` to `../desktop-host` so the declaration exists before desktop typechecking.
- `apps/desktop/tsconfig.host.json` and `apps/desktop-host/tsconfig.json` both set `rootDir: "src"`; the former emits declarations under `lib/types`, while the latter does so for child source. Root `build:lib:host` runs the host project build before desktop bundling. Desktop-host currently has no `exports` map and publishes only `lib/index.js` and `lib/cli.js`. The explicit subpath avoids app-source imports and hand-maintained protocol copies.

This is a proposal only. Runtime16 files were not edited. HostProcess discriminants, child plugin installation, and native tool registration remain separate authorized integration work.
