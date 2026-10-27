import difflib, pathlib
candidate = pathlib.Path(r'C:\Users\23825\AppData\Local\TradeLoom\dev-tools\ai-web-host-20261025')
baseline = pathlib.Path(r'C:\Users\23825\Desktop\ICT\tradeloom\evidence\patch23\browser-guests-v22.ts')
files = [
 ('apps/desktop/src/browser-guests.ts', baseline, candidate/'apps/desktop/src/browser-guests.ts'),
 ('apps/desktop/src/ai-web-diagnostics.ts', None, candidate/'apps/desktop/src/ai-web-diagnostics.ts'),
 ('apps/desktop/tests/ai-web-diagnostics-electron.fixture.cjs', None, candidate/'apps/desktop/tests/ai-web-diagnostics-electron.fixture.cjs'),
 ('apps/desktop/tests/build-ai-web-diagnostics-fixture.cjs', None, candidate/'apps/desktop/tests/build-ai-web-diagnostics-fixture.cjs'),
]
parts=[]
for name, old_path, new_path in files:
    old = old_path.read_text(encoding='utf-8').splitlines(keepends=True) if old_path else []
    new = new_path.read_text(encoding='utf-8').splitlines(keepends=True)
    parts.append(f'diff --git a/{name} b/{name}\n')
    if old_path is None: parts.append('new file mode 100644\n')
    parts.extend(difflib.unified_diff(old, new, fromfile=f'a/{name}' if old_path else '/dev/null', tofile=f'b/{name}', n=3))
out = pathlib.Path(r'C:\Users\23825\Desktop\ICT\tradeloom\integrations\dsh\patches\desktop-ai-web-readonly-diagnostics.patch')
out.write_text(''.join(parts), encoding='utf-8', newline='\n')
