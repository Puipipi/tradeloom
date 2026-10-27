# Patch 23 v2 fixture hardening evidence

- `ai-web-diagnostics-electron.fixture.cjs` now assigns a fresh UUID and uses it for its unique profile under the private candidate root and unique test result filename. It contains no recursive removal of userData or any other directory.
- `build-ai-web-diagnostics-fixture.cjs` runs Node `--check` on the fixture before transpiling, then uses `spawnSync(process.execPath, ['--check', file], {stdio:'ignore'})` on each generated CJS. Any syntax failure throws a generic label and prevents the caller from starting Electron.
- Before the one Electron run, the builder and fixture were manually syntax-checked; the builder then completed its automated checks and the generated files were also manually checked. The runner confirmed zero previous candidate Electron processes, launched hidden once, recorded 12 passing assertions, and confirmed zero remaining candidate processes. No failure/retry loop ran.
- Result files are versioned with v6 and UUID run ID. Prior v1 and v2 failure history remains preserved. The frozen 45E3 patch was copied before refreezing and is marked obsolete in `PATCH23-VERSIONS.md`.
- No native production source, main/ipc/preload, live16, upload code, or frontend changes were made.
