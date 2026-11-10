# Backend package export closure

This slice adopts six already-declared, missing package files from the read-only main source into the feature worktree. The copied files were byte-identical at adoption; no package manifest change was required.

| Package entry | File | Contract |
|---|---|---|
| `@tradeloom/dsh-business-shell/policy` | `policy.js` | Business-preset task/delegation attribution and budget gate. |
| `@tradeloom/dsh-business-shell/profile` | `profile-tool.js` | Agent-backed read of the owned demo profile through `createStateStore`. |
| `@tradeloom/dsh-business-shell/step-policy` | `step-policy.js` | Rejects business-preset turns after the existing 24-step limit. |
| `@tradeloom/dsh-business-shell/proxy` | `proxy.js` | Registers the four fixed same-origin business prefixes and calls the existing connection rejection check. |
| `@tradeloom/dsh-business-shell/workflow-tools` | `workflow-tools.js` | Existing local workflow catalog/tools/handler. This remains separate from the newer native workflow service and its tools. |
| Package asset | `skills/wf-planner/SKILL.md` | Workflow-tool guidance copied by `installPlannerSkill()` into the center workspace's `.dsh/skills/wf-planner/SKILL.md` when the center plugin is applied. |

The main package manifest already maps the five exports and lists all six files. The new package-self-import test checks both the live exports and `files` entries. The focused workflow-tools regression is copied from the source test with one fixture adjustment: direct tool tests provide an already-ready `nativeWorkflowReadiness`, matching this branch's required startup gate. It also proves those legacy local tools can coexist with the branch's `workflow-native-tools` registrations. Four legacy workflow-tools behavior cases were curated into a branch-owned test file; unrelated Host/client/canvas cases are kept in a `.source.txt` backup outside test discovery. One old assertion expected the raw document on disk; it was adapted to this branch's versioned envelope (`formatVersion`, `revision`, `deleted`, nested document, and null draft digest), while public save/confirm/run assertions stayed intact. The current unfiltered curated file passes 4/4 with zero skips; the initial 3-pass/1-fail and focused rerun remain historical evidence. See [the workflow behavior receipt](../../recovery/backend-export-closure-20261031/workflow-behavior/VALIDATION.md).

## Validation and boundaries

The main focused run passed 46 tests, failed 0, skipped 1, and exited 0. The skipped optional pinned DSH `WebServer` contract assertion was then run alone against the compiled rep12 package and passed 1/1 with no skips. Across the two runs all 47 distinct targeted cases passed with no failures. The additional assertion uses `WebServer.prototype.match` and starts no server; the proxy suite's other exercised listeners are test-owned Node servers bound only to `127.0.0.1` ephemeral ports. No Django or product server was started. The resolved SDK package is `@deepseek-ai/dsh-host-webserver` version `0.2.1-rc.3`, with `main: lib/index.js`; see [the isolated contract evidence](../../recovery/backend-export-closure-20261031/webserver-contract/VALIDATION.md).

The first copied-suite invocation is preserved but is not acceptance evidence: the three source-suite paths did not yet exist in this worktree, so that run executed only the four new closure tests. After copying the tests under branch-owned names and adapting the readiness fixture, the main run and the isolated WebServer contract follow-up are recorded in [validation](../../recovery/backend-export-closure-20261031/VALIDATION.md) and [the contract receipt](../../recovery/backend-export-closure-20261031/webserver-contract/VALIDATION.md).

This closes only the five backend subpaths and planner asset. The package root `.` still targets the missing `host.js`, and `./client` still targets client modules absent from this worktree. The earlier 46-case run did not invoke `installPlannerSkill()`; the later four-case regression did install the planner skill into a marker-owned isolated workspace. No Host/client wiring, package root usability, production server, GUI, real Django, user workspace, or product profile was exercised.
