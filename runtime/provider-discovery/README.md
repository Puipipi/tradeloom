# Draft provider request headers

`source.patch` changes the pinned official `dsh-v0.2.2-rc.1` source, commit
`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`. The runtime patch is generated from
those inputs, including the Host, standalone Remote and browser Remote assembly.
Existing runtime patches are retained when applying the generated source delta.

Discovery accepts optional `{name, value}[]` headers. Omission uses the stored
profile, `[]` clears it for one request, and a nonempty list replaces it. The
array preserves the upstream generator's tool JSON Schema support. Settings
continue to store an ordinary map. `new Headers(tupleArray)` constructs the
actual HTTP headers; protocol authentication, version, accept and attribution
precedence remain upstream-owned.

Clients with an explicit override call `llm/discoverModelsWithHeaders`, a thin
delegate to the existing discovery method. Older Hosts reject this method.
Unedited drafts call the original method without a headers field. There is no
retry that removes headers.

## Reproduce

Use an isolated checkout under a work directory. Install build tools in that
parent directory with `npm install --ignore-scripts --save-exact`:
`@deepseek-ai/dsh-typert-generator@0.2.2-rc.1`, `typescript@6.0.3`,
`tsdown@0.22.2`, `rolldown@1.1.1`, and `lightningcss@1.33.0`.
Use Node 24.22.1. Apply `source.patch` to the pinned checkout. Make its
`node_modules` resolve the canonical rc1 npm install (for example with a local
symlink); missing build tools resolve in the parent work directory.

Prepare a private canonical `runtime/locks/dsh-0.2.2-rc.1` npm prefix with every
preceding runtime patch applied, excluding `provider-discovery-headers.diff`.
Run, from this repository:

```sh
python3 -I runtime/provider-discovery/generate.py \
  --source /path/to/work/source --tools /path/to/work \
  --prefix /path/to/preceding-patched-prefix
```

The generator first rebuilds the original source and checks its bytes against
the npm preimage pins, then builds the changed source. It records the delta with
the official patch tool in a temporary prefix; the input prefix is read only.
The original/changed source swap is confined to the isolated checkout and restored
in `finally`. No upstream version or package dependency is upgraded.

Run `runtime/tests/provider-discovery-headers.test.mjs` with `DSH_PREFIX` pointing
to the resulting patched prefix. It uses actual generated codecs, the browser
assembly, the registered pi-ai adapter and loopback HTTP/SSE; values are synthetic.
