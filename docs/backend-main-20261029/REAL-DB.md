# Real database attempt

The command was executed in PowerShell from the independent main worktree:

```
& 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/payloads/pg17/pgsql/bin/pg_ctl.exe' start -D 'C:/Users/23825/Documents/Codex/2026-10-27/tradeloom-native-artifact-pg/data' -l 'C:/Users/23825/.codex/worktrees/backend-main-20261029/tradeloom/testing/backend-main-20261029/real-db/postgres.log' -o '-h 127.0.0.1 -p 55436' -w -t 45
```

The exact tool output is in `testing/backend-main-20261029/real-db/start-output.txt`. pg_ctl exit was 1; the outer PowerShell command exited 0. The requested postgres.log was not created. The pre-existing postmaster.pid listed PID 47844 and the data directory and port above; that PID was not running, so this file is not evidence of a live server. Before and after the attempt, no listener or TCP connection on 55436 and no postgres.exe process were observed. There was consequently no live PostgreSQL image or StartTime to report. The previously configured image was `C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/payloads/pg17/pgsql/bin/postgres.exe`.

No database connection, new database, or real DB test was performed. Access denied is the observed failure; its cause is unconfirmed. The new real-db directory contains the owned marker and output record.


## 2026-10-29 resume diagnostic

- Recovery point: `C:/Users/23825/.codex/worktrees/backend-main-20261029/recovery-20261029/snapshot-023326-607556`; staged binary patch is readable by `git apply --numstat` (135 paths), and all 9 untracked files were copied.
- QA marker matched. `postgres -D data -C data_directory` returned 0 and `pg_ctl status` returned 3 (no server). Before startup there was no postgres process or port 55436 connection.
- One `pg_ctl start` attempt at 2026-10-28 18:34:36.851–18:34:37.120 UTC returned exit 1 with `Access is denied`; the requested log was not created. Afterwards no postgres process or 55436 connection was observed. No PID file was removed.
- Both executables reported PostgreSQL 17.11 with exit 0. A unique temporary write probe in the requested log directory succeeded and was removed.
- ACL inspection shows explicit `HAPPY\\23825` FullControl on QA root and inherited FullControl on data, executable path and log directory; executable path also grants CodexSandboxUsers ReadAndExecute. Current identity is `HAPPY\\23825`; Administrators is deny-only, not enabled. These observations do not establish the rights of a PostgreSQL child token or identify the denial point.
- Defender events 1123/1124/5007 and PostgreSQL-related Application events: no matching events in 18:34–18:36 UTC. Cause remains unlocated.

- Foreground official `postgres.exe` diagnostic at 2026-10-28 18:36:55.956–18:37:06.949 UTC returned postgres exit 1: `FATAL: could not remove old lock file "postmaster.pid": Permission denied`. PostgreSQL advised manual removal. Preflight confirmed marker, old PID 47844 absent, no postgres process, and no connection on 55436. The lock file was not removed; no ACL/token changes were made.

- After rechecking marker, data path, recorded PID 47844 and port 55436, and no running PostgreSQL or port connection, the old owned lock was moved without overwrite to `data/postmaster.pid.stale-20261029-023758305`. A single foreground restart at 2026-10-28 18:37:58.321–18:37:58.450 UTC returned PostgreSQL exit 1: `FATAL: could not create lock file "postmaster.pid": Permission denied`. No ACL or token changes were made.

- Shell FileMode.CreateNew in QA/data succeeded and its unique probe was removed; foreground postgres could not create its lock. This indicates a difference in effective access on those operations, without establishing the underlying cause.

- A new, independent Temp cluster attempt at `C:/Users/23825/AppData/Local/Temp/tradeloom-pg-qa-b44a3d6939ffb8fa` failed at initialization: `initdb` exit 1, `could not create directory .../data: Permission denied`. Its locale warning noted GBK is unsuitable for server encoding and selected UTF8; this warning is not established as the cause. No server or database was created. The two generated temporary credential files were removed after confirming the owned marker and paths; no credential values were recorded.

- With the owned Temp root, an already-created empty ordinary `data` directory and `workspace` directory, official `initdb -U artifact_test -A scram-sha-256 --encoding=UTF8 --locale=C` returned exit 1: `fixing permissions on existing directory ... initdb: error: could not change permissions of directory .../data: Permission denied`. The per-attempt temporary password and pgpass files were removed. No server was started; no permission or token changes were made externally.
