# Native web AI controller TypeScript check

Toolchain: TypeScript 6.0.3 bundled with the read-only runtime-16 checkout.

```powershell
$rt='C:\Users\23825\Desktop\ICT\workspace\runtime\tradeloom-harness\releases\0.2.1-rc.3-tradeloom-desktop-16'
& 'C:\Program Files\nodejs\node.exe' "$rt\node_modules\typescript\bin\tsc" --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --typeRoots "$rt\node_modules\@types" 'C:\Users\23825\Desktop\ICT\tradeloom\integrations\dsh\native-ai-web\ask.ts'
Write-Output "strict_noemit_exit=$LASTEXITCODE"
```

Observed result: no diagnostics; `strict_noemit_exit=0`. An earlier invocation
without `--typeRoots` exited 2 because the working checkout cannot resolve the
runtime's `@types/node`; pointing typeRoots at runtime 16 resolved it. No files
were emitted or changed in runtime 16.
