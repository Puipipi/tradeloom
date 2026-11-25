"""Fixed read-only helper for the server-local PowerShell tool."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from enterprise_portal.ssh_group_policy import inspect_policy

try:
    print(json.dumps(inspect_policy()))
except Exception:
    print(json.dumps({"eligible": False, "reason": "probe_unavailable"}))
    raise SystemExit(1)
