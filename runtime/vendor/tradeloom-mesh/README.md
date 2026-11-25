# TradeLoom read-only Mesh source and package

The upstream repository and exact commit are in `lock.json`. Apply
`upstream-changes.patch` to that commit. It contains the read-only Host, Relay
directory metadata and single-entry bundle recipe. The original repository and
the individual dependency lockfile remain the source of unchanged code.

Install from the upstream lockfile and compile protocol, WebRTC, crypto and
client-core in dependency order. Compile the Remote plugin using its tsc
configuration, then compile `@dsh-mesh/mesh`. Run the following from the source
checkout to generate the verified module:

```sh
pnpm --filter '@dsh-mesh/plugin' exec tsdown --config tsdown.tradeloom.config.ts
```

The output is `packages/mesh-plugin/bundle-tradeloom/index.mjs`. The runtime
reads the checked-in archive as data, verifies the entry and source-patch
digests, and copies only the module and its license files. It does not run the
package manager or read an external URL for this input. No package or runtime
is published by this repository change.

The source fork and module are MIT. The upstream and bundled dependency
licenses are stored in the archive. The parent Flutter application continues
to carry its AGPL-3.0-or-later license.
