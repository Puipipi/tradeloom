# Load status and diagnostics

The enabled switch in **Settings › Plugins › Installed › a plugin** records a configuration choice. It does not prove that a component is running. When the host inventory reports failure, loading, waiting, no running instance or a missing entry, the details sheet adds **Load status**. If some components are running, it shows **Partly active** and the running count.

The app joins each bundle row to the Loader inventory by its exact `entryId`. Package and module names are not used to guess ownership: two plugins can import the same module. Missing entry ids, absent inventory entries and duplicate ids remain **Not reported**, without claiming success or inventing a cause. This is the global Loader state; preset-specific conditions and runtime states remain in the preset groups of **Plugin inventory**.

A disabled bundle gets no extra diagnostics section. An explicitly disabled component with no other issue is not an error. When all components are running with clean metadata, the details layout stays unchanged. Loading, disconnection or failure of the inventory request does not establish that the plugin failed; use Plugin inventory to inspect that request's error and retry.

## Three kinds of evidence

| Evidence | Where | What it establishes |
|---|---|---|
| Loader state | Load status | Which global component is running, failed, waiting or unreported |
| Metadata errors | Metadata diagnostics under a component | The host's actual metadata problem, not a runtime exception stack |
| Native UI parse and runtime issues | Native UI | Manifest, view and action issues with their JSON paths, using the existing issues page |

If the host API did not return runtime error details, the app says so. For the local engine, **Engine logs** opens the existing log sheet. For SSH / DSH Remote, inspect logs on that host. Local logs never stand in for a remote error, and `pending` is not treated as evidence of a particular missing dependency.

Plugin management changes and host-ready events invalidate the existing inventory. **Refresh** in the diagnostics section also reads it again. This section adds no polling and cannot promise to observe every transient phase without a corresponding notification.
