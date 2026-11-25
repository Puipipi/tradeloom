# Hosts, install, fallbacks

dsh-go connects to three kinds of host: the on-device engine, SSH hosts and relay hosts. Tool cards travel in the conversation log and show everywhere; the other slots go through the dsh-go bridge (`dsh-go-bridge`) and need it on the host.

| | Tool cards | Capsules · menu · strip · panels | Web plugins (web islands) |
|---|---|---|---|
| On-device engine | ✅ | ✅ the bridge ships with the app's runtime | ✅ |
| SSH host | ✅ | Phase 2 (the bridge cannot be installed on SSH hosts yet) | ✅ |
| Relay host | ✅ (with the log) | ❌ the relay does not pass `/dsh-go/*` | ❌ |

## Installing a local plugin

A plugin is an npm package directory. No publishing: install it into the profile by absolute path.

```sh
dsh plugin --profile web add /absolute/path/to/my-plugin
```

| Host | Where | Profile |
|---|---|---|
| On-device engine | The app's Terminal (a shell in the on-device environment) | `web` (the app starts the engine with it) |
| Remote host | The host's own shell | The profile that host's `dsh` uses, usually `web` |

- Takes effect at once, no restart (measured on DSH 0.2.1-rc.2: `add` while `dsh web` runs, the app has the new manifest within seconds).
- What gets installed is **a link to the directory**: keep the directory.
- Changed the `dshGo` manifest: the bridge re-reads `package.json` by modification time.
- Changed code under `lib/`: restart the engine (on-device: the app's Engine page; dev machine: restart `dsh web`). Removing and re-adding does not reload code already loaded.
- Uninstall: `dsh plugin --profile web remove <package name>`.
- Declare the DSH versions you support in `engines.dsh` (e.g. `>=0.2.1-rc.2 <0.3.0-0`); DSH refuses incompatible installs and says why.

### Getting the folder into the on-device environment

The on-device engine runs in the app's own Linux environment (`/root` is home). Use `/root/.dsh/dsh-go/plugins/<name>/`: it is kept when the engine is reset; if the plugin profile was not kept, `add` it again after the reset.

| Way | How |
|---|---|
| Let the agent write it | Say what you want ("a button above the composer that translates the clipboard into English"). The app's bundled `dsh-go-plugin` skill has it write, check and install the plugin |
| From the terminal | `git clone` or `curl` into `/root/.dsh/dsh-go/plugins/` |
| Phone storage | Copy the folder into the phone's Download; after turning on "Access phone files" in Settings it is `/sdcard/Download/` in the environment; `cp -r` it into `/root/.dsh/dsh-go/plugins/`. During development: `adb push folder /sdcard/Download/` |

## Fallbacks

| Case | The app shows |
|---|---|
| No bridge on the host (SSH, relay) | Tool cards only; the rest is treated as a web plugin (web island or "Open in web") |
| `minApp` newer than the app | No native part; a hint to update the app |
| Unsupported `v` | Same |
| One wrong entry | Only that entry is dropped; plugin details shows "Native UI · N issues" |
| 5 violations in a row | Degraded to the web version for this run; back after an engine restart or re-enabling the plugin |
| No handler registered | That entry is greyed out (`ready: false`) |
| A component the app does not know | A grey placeholder for that component; the rest draws |
| DSH web UI | The official generic tool card; the other slots do not appear |

## One plugin, both UIs

The `dshGo` manifest and `ctx.dshGo` only matter to the app; the DSH web UI ignores them. So a plugin can carry a web half (`dsh.client`) and a `dshGo` manifest at once: web UI on the web, native UI in the app.
