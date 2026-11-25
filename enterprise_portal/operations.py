"""Allowlisted operations shared by the owner and explicitly authorised technicians."""
import os

from django.db import connection

from .operations_store import CredentialStore, StoreUnavailable, SLOTS

COMMANDS = ("health", "capabilities", "credentials", "permissions", "websites", "website_notice", "cloudflare_status", "ssh_policy")


def can_operate(user):
    if not user.is_authenticated or not user.is_active:
        return False
    from .policy import capability_policy
    return capability_policy(user)["server_ops"]


can_use_server_operations = can_operate


def vault():
    return CredentialStore(os.environ.get("TRADELOOM_OPERATIONS_VAULT_DIR"))


def capabilities():
    try:
        store = vault()
        credentials = store.metadata()
        storage = "ready"
    except (StoreUnavailable, OSError):
        storage, credentials = "unavailable", {s: {"configured": False} for s in SLOTS}
    return {"assistant": "allowlisted_commands", "commands": COMMANDS,
            "credential_storage": storage, "credentials": credentials,
            "cloudflare": {"status": "configured" if all(credentials[s]["configured"] for s in ("cloudflare_api_token", "cloudflare_zone_id")) else "not_configured",
                           "single_zone": True, "single_url_purge": True}, "websites": {"status": "enterprise_portal", "targets": [
                {"id": "enterprise_portal", "path": "/enterprise/", "operation": "website_notice"}]},
            "ssh": "read_only_policy", "local_authentication": "django_session_required",
            "model": "configured" if credentials["deepseek_api_key"]["configured"] else "not_configured",
            "model_provider": "deepseek", "model_name": "deepseek-flash", "database_type": connection.vendor}


def execute(command, user):
    if not can_operate(user):
        raise PermissionError("Operations permission required")
    if command not in COMMANDS:
        raise ValueError("Unsupported assistant command")
    if command == "ssh_policy":
        from . import operations_ssh
        # Classifier output never authorizes name disclosure; results are not sent to the model.
        return operations_ssh.inspect()
    if command == "cloudflare_status":
        from . import operations_cloudflare as cloudflare
        try:
            return cloudflare.inspect(vault())
        except (StoreUnavailable, OSError, cloudflare.ProviderUnavailable):
            return {"status": "unavailable", "domain": None, "zone_status": None, "can_purge": False,
                    "detail": "Cloudflare 站点核验暂不可用。"}
    if command == "website_notice":
        from .website_notice import current
        return {"notice": current()}
    if command == "health":
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                healthy = cursor.fetchone()[0] == 1
        except Exception:
            healthy = False
        return {"service": "running", "database": "ok" if healthy else "unavailable"}
    if command == "permissions":
        from .policy import is_enterprise_owner
        return {"operations": True, "credential_lifecycle": is_enterprise_owner(user), "credential_readback": False,
                "ssh": False, "ssh_policy_read": True, "arbitrary_network": False, "shell": False}
    status = capabilities()
    return status if command == "capabilities" else {command: status[command]}
