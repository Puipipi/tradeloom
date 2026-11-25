# TradeLoom upstream sync

`sync-upstream.mjs --check` reads the `dsh-Go` `main` SHA and reports whether
the current Go source worktree has local edits. It does not change the branch.

`sync-upstream.mjs --candidate` makes a separate clone outside the source tree,
fetches upstream `main`, and merges it on a candidate branch. The source tree is
never rewritten. A candidate with conflicts stays available for review; remove
the candidate directory to discard it. The command refuses dirty source trees
so uncommitted TradeLoom work is not silently included or lost.

```sh
node tooling/tradeloom/sync-upstream.mjs --check --repo .
node tooling/tradeloom/sync-upstream.mjs --candidate --repo . --dest /absolute/path/to/dsh-go-candidate
node --test tooling/tradeloom/tests/sync-upstream.test.mjs
```

The tool is source maintenance only. It does not build, sign, install, publish,
or update a phone. The app's official DSH Go release updater is disabled in
TradeLoom builds until a separate signed release feed exists.
