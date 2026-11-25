"""Private Windows runtime/PG installation fixture; does not use live services.

Runtime paths are supplied by the operator. Raw grant and synthetic passwords
are never printed; this script creates and removes its own private temp root.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


parser = argparse.ArgumentParser()
parser.add_argument("--python-root", required=True)
parser.add_argument("--packages", required=True)
parser.add_argument("--postgres-bin", required=True)
args = parser.parse_args()
app = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix="tl-console-pg-"))
pgbin = Path(args.postgres_bin)
pgdata = root / "pgdata"
runtime = root / "runtime"
secrets_dir = root / "secrets"
secrets_dir.mkdir()
port, http_port = free_port(), free_port()
password = secrets.token_hex(32)
secret = secrets.token_hex(48)
pwfile = secrets_dir / "pg-password"
pwfile.write_text(password)
env = os.environ.copy()
env.update({"PYTHONPATH": str(app) + os.pathsep + args.packages,
            "DJANGO_SETTINGS_MODULE": "config.enterprise_settings",
            "TRADELOOM_ENTERPRISE_DATA_ROOT": str(root),
            "TRADELOOM_ENTERPRISE_SECRET_KEY": secret,
            "TRADELOOM_ENTERPRISE_HTTPS": "0", "TRADELOOM_ENTERPRISE_ALLOWED_HOSTS": "127.0.0.1,localhost",
            "TRADELOOM_DB_NAME": "postgres", "TRADELOOM_DB_USER": "postgres",
            "TRADELOOM_DB_PASSWORD": password, "TRADELOOM_DB_HOST": "127.0.0.1", "TRADELOOM_DB_PORT": str(port)})
server = None
pg_started = False
log = None


def run(argv, **kwargs):
    # pg_ctl's detached postgres must not inherit PIPE handles: communicate()
    # would wait for the server lifetime even after pg_ctl itself exits.
    result = subprocess.run([str(item) for item in argv], env=env, cwd=app, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW, **kwargs)
    if result.returncode:
        # Do not echo arbitrary DB/OS command lines or secret-bearing output.
        raise RuntimeError(f"Fixture command failed ({Path(argv[0]).name}, exit {result.returncode})")
    return result


try:
    run(["icacls.exe", root, "/inheritance:r", "/grant:r", os.environ["USERDOMAIN"] + "\\" + os.environ["USERNAME"] + ":(OI)(CI)F"])
    shutil.copytree(args.python_root, runtime / "python")
    # A test-owned junction avoids copying the immutable package library.
    env["TL_CONSOLE_TEST_PACKAGES_SOURCE"] = str(Path(args.packages))
    env["TL_CONSOLE_TEST_PACKAGES_LINK"] = str(runtime / "python-packages")
    run(["powershell.exe", "-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:TL_CONSOLE_TEST_PACKAGES_LINK -Target $env:TL_CONSOLE_TEST_PACKAGES_SOURCE | Out-Null"])
    python = runtime / "python" / "python.exe"
    run([pgbin / "initdb.exe", "-D", pgdata, "-U", "postgres", f"--pwfile={pwfile}",
         "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", "--encoding=UTF8", "--no-locale"])
    run([pgbin / "pg_ctl.exe", "-D", pgdata, "-l", root / "postgres.log", "-o", f"-h 127.0.0.1 -p {port}", "-w", "start"])
    pg_started = True
    config = {"app_root": str(app), "runtime_root": str(runtime), "http_port": http_port,
              "postgres_port": port, "https_enabled": False}
    (root / "server-config.json").write_text(json.dumps(config))
    (secrets_dir / "service-secrets.json").write_text(json.dumps({"django_secret_key": secret,
         "database_password": password, "database_user": "postgres", "database_name": "postgres"}))
    run([python, "-B", app / "manage.py", "migrate", "--noinput"])
    # Permission normally comes from the coordinated ops migration.
    run([python, "-B", app / "manage.py", "shell", "-c", "from django.contrib.contenttypes.models import ContentType; from django.contrib.auth.models import Permission; c=ContentType.objects.get(app_label='enterprise_portal',model='enterpriseentry'); Permission.objects.get_or_create(content_type=c,codename='use_server_operations',defaults={'name':'Synthetic operations'})"])
    log = (root / "server.log").open("wb")
    server = subprocess.Popen([str(python), "-B", str(app / "manage.py"), "runserver", f"127.0.0.1:{http_port}", "--noreload", "--insecure"], env=env, cwd=app,
                              stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
    (root / "django.pid").write_text(str(server.pid))
    for _ in range(100):
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", http_port)) == 0:
                break
        if server.poll() is not None:
            raise RuntimeError("Private fixture web server exited")
        time.sleep(.1)
    # Real PowerShell validates ACL, process executable/args/SID, listener owner.
    run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", app / "scripts" / "Enable-LocalServerConsole.ps1", "-DataRoot", root])
    os.environ.update(env)
    import django
    django.setup()
    from django.db import connections
    from enterprise_portal import local_console as lc
    token, _ = lc.issue()

    def consume():
        try:
            lc.consume(token)
            return "accepted"
        except lc.LocalConsoleUnavailable:
            return "rejected"
        finally:
            connections.close_all()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = sorted(pool.map(lambda _: consume(), range(2)))
    if outcomes != ["accepted", "rejected"]:
        raise RuntimeError("Concurrent redemption did not enforce exactly-once")
    # Same-user DPAPI opens the registered issuer; inspect only safe flags.
    value, _ = lc.issuer()
    user = lc.technician(value)
    if user.has_usable_password() or user.is_staff or user.is_superuser:
        raise RuntimeError("Unexpected technician privilege")
    connections.close_all()
    # HTTPS opt-in is rejected without changing saved configuration.
    config["https_enabled"] = True
    (root / "server-config.json").write_text(json.dumps(config))
    rejected = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(app / "scripts" / "Enable-LocalServerConsole.ps1"), "-DataRoot", str(root)], env=env, cwd=app, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    if rejected.returncode == 0:
        raise RuntimeError("HTTPS installation was accepted")
    print("PASS: real private PostgreSQL + Windows same-account DPAPI/PowerShell scope; concurrent grant accepted=1 rejected=1; HTTPS opt-in rejected.")
finally:
    if server is not None:
        server.terminate()
        server.wait(timeout=20)
    if log:
        log.close()
    if pg_started:
        run([pgbin / "pg_ctl.exe", "-D", pgdata, "-m", "fast", "-w", "stop"])
    # Remove only this random, verified private fixture root. Remove junction
    # itself first; never recursively traverse the shared package destination.
    if root.parent.resolve() == Path(tempfile.gettempdir()).resolve() and root.name.startswith("tl-console-pg-"):
        junction = runtime / "python-packages"
        if junction.exists():
            os.rmdir(junction)
        shutil.rmtree(root)
