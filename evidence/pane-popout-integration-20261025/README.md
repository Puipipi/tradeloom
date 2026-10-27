# Isolated pane popout integration fixture

This fixture is prepared for a later, explicitly scheduled run. It has not been launched.

## Scope

- Uses the desktop-13-installed Electron 44.7 executable and TypeScript compiler only.
- Transpiles the maintained `web-document.ts` helpers from the isolated native patch scratch into this evidence directory at runtime.
- Registers only the local `dsh-app` scheme. No TCP listener, Host, Django, PostgreSQL, login, model, or business API is started or contacted.
- Sets Electron `userData` to this fixture's own `userData` directory.
- Creates a hidden opener and a hidden popup child. The fixture checks separate native handles, independently changeable bounds, the blank-document route, main-frame navigation denial, secondary-popup denial, and child closure with its opener.
- Does not use a copied chat/session card and does not claim Dockview portal, editor, attachment File-object, or business-iframe message integration. Those are later renderer-level checks after business_mapping's actual portal/editor implementation is stable.

## Prepared command (not run)

```powershell
& 'C:\Users\23825\Desktop\ICT\workspace\runtime\tradeloom-harness\releases\0.2.1-rc.3-tradeloom-desktop-13\apps\desktop\node_modules\electron\dist\electron.exe' 'C:\Users\23825\Desktop\ICT\tradeloom\evidence\pane-popout-integration-20261025'
```

The fixture writes only `result.json` and a generated helper under this directory. No global environment variables or security settings are changed. A run should be authorized and scheduled separately; this preparation did not start Electron or Chrome.
