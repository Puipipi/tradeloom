# Controlled upload smoke v2

- Result run ID: c5505adbf7e143e29cb735f6eb36b. The unique filename token is c5505adbf7e143e29cb735f6eb36b69b; the launcher passed a shortened runId, recorded alongside both values in `acceptance-smoke-v2-run-record.json`. The raw JSON is unchanged and contains the matching source SHA-256.
- `acceptance.cjs` SHA-256 before launch: 39460E2C7011F2580EC5F1F5372F7D2C1AAA298CCDE0F0E4933E7C9B8540915C; Node syntax check exit 0.
- Electron fixture exit: 0. It ran hidden after confirming no private-candidate Electron processes; no process remained afterward. Stderr was empty.
- The page was controlled by the private Electron protocol handler at the fixture DeepSeek origin; no live-site login/profile/network was used.
- `manager.upload` returned `delivered=true` and `websiteConfirmed=false`. The page observed `input` count 1 and an actual `change` count 1. The file input contained one file: `public-upload.txt`, size 36, type `text/plain`.
- A real `FileReader.readAsText(file)` callback completed (`readState=resolved`) and only then assigned `window.fileResult`. Its text matched the original input file exactly; filename and `File.size` also matched. All 16 smoke checks passed.
- The legacy immediate-read failure is preserved in `acceptance-smoke-legacy-failure.json`. The updated fixture polls actual event/reader state for at most five seconds and records the timeout class plus selector/file facts.
- No production upload code or native source changed. Frozen patch23 SHA-256 remains `45E35CC6935E8E21E1DDC8FC13DC38C8987E6E476F25142AE1700890FEC6431B`.

Full result: `acceptance-smoke-v2-acceptance-smoke-v2-c5505adbf7e143e29cb735f6eb36b69b.json`; reconciliation: `acceptance-smoke-v2-run-record.json`.
