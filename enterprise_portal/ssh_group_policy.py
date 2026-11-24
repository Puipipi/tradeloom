"""Local OS tool probe only; contains no Django, remote route or account lookup."""
import hashlib
import json
import re

from . import operations_ssh

GROUP = "tradeloom-ssh-users"


def inspect_policy():
    service = operations_ssh.query_service()
    result = {"eligible": False, "group": GROUP, "service": service, "reason": "default_policy_required"}
    if service["query_state"] != "ok" or service["configuration_source"] != "default":
        return result
    try:
        raw = operations_ssh.read_default_config()
        parsed = operations_ssh.parse_config(raw, include_names=True)
    except (OSError, ValueError):
        return {**result, "reason": "default_config_unavailable"}
    if parsed["state"] != "read" or parsed["partial"]:
        return {**result, "reason": "partial_policy_manual_review"}
    names = parsed["declared_names"]
    allowed = names["allowgroups"]
    if (allowed.count(GROUP) != 1 or any(not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", name) for name in allowed)
            or any(names[key] for key in ("allowusers", "denyusers", "denygroups"))):
        return {**result, "reason": "literal_allowgroup_required"}
    fingerprint = hashlib.sha256(raw + json.dumps(service, sort_keys=True).encode()).hexdigest()
    return {**result, "eligible": True, "reason": "literal_group_declared_not_login_proof", "fingerprint": fingerprint}
