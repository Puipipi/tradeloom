# Artifact filesystem test

On independent main, the unmodified test was run with TEMP and TMP set for the Node child to the canonical empty directory C:/Users/23825/.codex/worktrees/backend-main-20261029/tradeloom/testing/backend-main-20261029/artifact-fs/temp. Its ancestors and itself were checked for reparse points. The parent owned marker remains outside the test-created directories.

Command: C:/Program Files/nodejs/node.exe --test packages/tradeloom-shell/tests/workflow-native-artifact-http.test.js. Exit 0; 13 passed, 0 failed. The tool captured combined output in testing/backend-main-20261029/artifact-fs/node-test-output.txt; separate stdout and stderr were not captured.

The test uses real synthetic files and fresh temporary directories, cleaned by the test. Backend, authorization and request/response are fixtures; no HTTP listener, real PostgreSQL, Host or Native execution is established. This does not complete O08 or O09. The previous attempt to modify the test cleanup guard was denied with PermissionError; the source remained unchanged and this run used the original test. The earlier 95 process-local tests were not rerun.
