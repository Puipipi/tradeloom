# File digest

Tap Files or Images in the plugin panel. The system chooser allows up to 4 files, 8 MiB each and 16 MiB total. Content uploads through the current host connection; the callback reads actual bytes and shows their name, byte count and SHA-256. The example never sends a message, calls a model or retains file copies. Digests live for the data subscription; a fresh subscription starts empty.

Only NA v1.3 `files` is required. The view uses existing v1 components so F3 can apply independently; the accompanying F1/F2 examples demonstrate second-phase styles and forms. Old apps and unsupported connections show text without selection buttons. The Android adapter with local/direct SSH hosts can negotiate this capability; DSH Remote relay cannot.

Install on a host with the updated bridge:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-go-example-files
```

From the repository root:

```sh
node sdk/plugin-kit/bin/check.mjs examples/plugins/dsh-go-example-files
node --test examples/plugins/dsh-go-example-files/test/*.test.js
node --test runtime/tests/native-files.test.mjs
```

The last command runs real HTTP/WebSocket through production bridge routes and this example's handler, without requiring a DSH engine. System chooser UI and remote devices still need device verification; see the [author guide](../../../docs/plugins/en/files.md).

A handle is valid only within the awaited selection callback. Copy or persist bytes before it ends if later work needs them. `file.name` is not a path and MIME is not content validation. Read-only bridge delivery is not a sandbox for host Node plugins.
