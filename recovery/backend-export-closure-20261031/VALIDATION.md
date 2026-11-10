# Backend package export closure validation

The main targeted command exited 0: **46 passed, 0 failed, 1 skipped**. The one skip was the optional source-test assertion against the pinned DSH `WebServer`; `TRADELOOM_DSH_WEBSERVER_LIBRARY` was unset. That case was later run alone against the rep12 compiled WebServer and passed 1/1 with zero skips. Across the two runs all 47 distinct cases passed with no failures; see the [WebServer contract follow-up](webserver-contract/VALIDATION.md). All five package self-imports and the planner asset/manifest checks ran in the main command.

The regression files copied from the main source were:

- `backend-budget-epochs.test.js` from `tests/budget-epochs.test.js` (source SHA in `SOURCE-SHA256.txt`).
- `backend-business-proxy.test.js` from `tests/business-proxy.test.js`; its exercised HTTP listeners bind only to local `127.0.0.1` ephemeral ports and are closed by the test hooks.
- `backend-workflow-tools-coexistence.test.js` from `tests/workflow-native-tools.test.js`; its fixture supplies a ready state for this branch's existing startup-recovery gate. It confirms the local workflow tool registration coexists with the branch's native workflow tools.

The new `backend-export-closure.test.js` validates five live package subpath imports, the manifest `exports` and `files` entries, injected profile reading/Agent requirement, business step-limit behavior, and the packaged planner asset. Module `node --check` commands also passed.

The four legacy workflow-tools behavior cases from main are now the only tests in the curated `backend-workflow-service.test.js`; unrelated Host/client/canvas cases from the copied source are preserved in a `.source.txt` backup outside test discovery. The initial 3-pass/1-fail run and focused assertion rerun are historical evidence. The current unfiltered file invocation passes 4/4 with zero skips; an intermediate curation run that lacked helpers is retained but not counted. See [workflow behavior validation](workflow-behavior/VALIDATION.md). The public workflow handler assertions remain in place.

An earlier invocation produced a 4/4 result but referenced three source tests not present in this worktree; Node ran only the new closure test. That output is retained as `final.stdout.txt` and is **not** counted as suite evidence. The valid final run is `final3.*`.

The earlier 46-case run did not exercise `installPlannerSkill()`; the later four-case workflow behavior regression installed the planner skill into a marker-owned isolated workspace. No product Host/client, Django listener, GUI, model, user workspace, or user profile was exercised. The package root and client subpaths remain unresolved in this worktree.

Reproduction command and environment scope for the main run are in [COMMAND.txt](COMMAND.txt). Its exact result is [final3.stdout.txt](final3.stdout.txt), stderr is empty, and [final3.exit.txt](final3.exit.txt) contains `0`. The additional WebServer-only command/output/exit are preserved in the linked follow-up directory.
