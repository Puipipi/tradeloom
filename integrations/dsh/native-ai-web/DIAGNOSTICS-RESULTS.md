# 只读站点诊断 helper 验证记录

## TypeScript

使用 runtime 16 自带 TypeScript 6.0.3：

```powershell
$rt='C:\Users\23825\Desktop\ICT\workspace\runtime\tradeloom-harness\releases\0.2.1-rc.3-tradeloom-desktop-16'
& 'C:\Program Files\nodejs\node.exe' "$rt\node_modules\typescript\bin\tsc" --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --typeRoots "$rt\node_modules\@types" integrations/dsh/native-ai-web/diagnostics.ts
Write-Output "strict_noemit_exit=$LASTEXITCODE"
```

Observed: no diagnostics; exit 0. No runtime source was changed.

## Controlled Electron DOM

```powershell
node --test integrations/dsh/native-ai-web/diagnostics.electron.test.mjs
```

Observed: 1 Electron integration test passed. It uses the installed Electron 44
binary and an isolated test `userData` directory. Electron's local protocol
handler serves a controlled page at the exact `https://www.doubao.com` origin;
it does not contact the live site. The fixture puts canaries in body text,
textarea/input values, `aria-label`, cookie, and message/turn identity values.
It verifies that the projected result contains none of them, confirms the test
cookie exists, and covers mismatched provider origin, a navigation during the
probe, and an owner-destroyed window.

The result does not verify production website DOM, login behavior, or selector
stability. DeepSeek and Doubao real-window diagnosis still requires the future
main-owned manager/menu wiring, plus current DOM evidence.

## Output/privacy properties

- Probe source is fixed per allowlisted provider and runs in a fixed isolated
  world through `executeJavaScriptInIsolatedWorld`.
- Native preflight and postflight compare the exact WebContents URL, HTTPS
  origin, main-frame process/routing identity, and main-frame URL. The page
  probe also checks its document/window identity and URL did not change while
  collecting metadata.
- Composer candidates are limited to fixed structural composer boundaries and
  the already-observed Doubao test IDs. Buttons are read only under a composer
  root; no sidebar/history controls are returned.
- Message identity output contains fixed attribute names and presence booleans
  only; if the fixed metadata scan reaches its node bound, absent attributes
  are reported as `unknown`. The helper never reads message text, body text,
  input values, cookies, storage, prompts, or attachment names.
- Draft and generation state always remain `unknown`; no live site marker has
  been verified for either state.

## Future read-only connection suggestion

Prefer a fixed **“Export content-free site diagnostics”** command in the
existing native web window's **Web** menu. It should call
`DesktopAiWebWindows.diagnostics({ provider })` in the Electron main process,
backed by `diagnoseNativeAiWebPage` and that provider's already-owned
BrowserWindow. The command must never open, focus, hide, or show a window; the
frontend controls which window is foreground before the user invokes it.

Write only the bounded `NativeAiWebDiagnosticResult` to a fixed app-owned
diagnostics directory, with an app-generated filename and no arbitrary path
argument. Report the resulting file path through the existing native menu
action feedback. The eventual manager method accepts only the fixed provider
enum and returns safe error codes. Do not add an HTTP route, arbitrary
script/selector input, DevTools/CDP, or window activation side effect. This is
a proposal only; no menu, manager, file export, or product API connection was
written here.
