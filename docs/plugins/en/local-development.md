# Reloading local plugin code

After editing the code DSH actually loads, open **Settings › Plugins › Installed › your plugin** and choose **Restart engine to reload**. The confirmation explains that **the local engine restarts and running tasks are interrupted**. This uses the app's existing full-engine restart, not HMR of an individual plugin.

The entry appears only on the local host, with a normally running engine and an installed, enabled third-party plugin from a local directory. Recognized sources are `file:`, `link:`, absolute paths and paths starting with `./`, `../` or `~/`; archives are not directory sources. Safe mode, read-only plugins, remote hosts and engines that are stopped, starting or stopping do not offer it.

Only one confirmation or reload may be pending at a time. After confirmation, the app checks the host, connection, local source, continued installation and enablement, and engine state again. Switching hosts, removing the plugin or disabling it during confirmation cancels the action and asks you to check again.

## Which changes take effect

- Restart starts a fresh DSH process reading the files it actually loads. If the entry point is built output such as `lib/index.js`, run your plugin's build first.
- Whether a local dependency links directly to its source depends on installation. If the package manager copied files, editing the original directory does not edit the loaded copy; update that copy or reinstall before restarting. The app does not sync or overwrite plugin directories.
- **Engine restart requested** confirms the restart call, not a successful plugin load. After reconnecting, inspect load/parse diagnostics in plugin details and engine logs when needed.
- Whether changes to `cordis.patch.yml` apply automatically depends on the host's HMR configuration. This entry leaves that configuration alone.

## What plugin-level HMR still needs

The current callable app and bridge interfaces contain no verified operation to invalidate one module's cache and recompose its plugin. This change adds no DSH protocol, does not edit `hmr.config.root`, and does not present disable/enable as a source reload.

A reload without restarting the engine first needs a supported HMR interface or configuration verified on the target DSH version: directory-to-module identity, source cache invalidation, cancellation of old fibers/subscriptions/async work, and explicit completion and failure signals. The app also needs a host-specific call path and testable failure recovery. An issue's observation of `config.root: []` is not proof that every host uses it.

A local path on SSH / DSH Remote belongs to that host. This entry does not restart remote DSH; use that host's existing development and restart workflow.
