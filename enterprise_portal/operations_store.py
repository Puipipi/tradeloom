"""Server-only, current-service-account DPAPI vault. No secret read API."""
from __future__ import annotations

import ctypes
import os
import re
from pathlib import Path
import subprocess
import tempfile

SLOTS = ("cloudflare_api_token", "cloudflare_zone_id", "cloudflare_oauth_client_secret", "deepseek_api_key")


class StoreUnavailable(Exception):
    pass


def _secure_directory(path: Path) -> None:
    if os.name != "nt" or not path.is_absolute():
        raise StoreUnavailable("Windows DPAPI requires an absolute server directory")
    # Fixed program; the path is passed as data, never interpolated into code.
    script = r'''
$ErrorActionPreference = 'Stop'
$p = $env:TRADELOOM_VAULT_CHECK_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if (![System.IO.Directory]::Exists($p)) {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
  [System.IO.Directory]::CreateDirectory($p, $acl) | Out-Null
}
$item = [System.IO.DirectoryInfo]::new($p)
if (!$item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid vault directory' }
$acl = [System.IO.Directory]::GetAccessControl($p)
if (!$acl.AreAccessRulesProtected) { throw 'Vault ACL must disable inheritance' }
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Invalid vault owner' }
foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { throw 'Vault ACL permits other identities' }
}
'''
    try:
        subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
                        "-NoProfile", "-NonInteractive", "-Command", script],
                       env={**os.environ, "TRADELOOM_VAULT_CHECK_PATH": str(path)},
                       check=True, capture_output=True, timeout=20, creationflags=0x08000000)
    except (OSError, subprocess.SubprocessError, KeyError) as exc:
        raise StoreUnavailable("Vault protection verification failed") from exc


def _protect(secret: str) -> bytes:
    class Blob(ctypes.Structure):
        _fields_ = [("size", ctypes.c_uint32), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    raw = secret.encode("utf-8")
    buf = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    source, result = Blob(len(raw), buf), Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    crypt.CryptProtectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_wchar_p, ctypes.c_void_p,
                                      ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(Blob)]
    crypt.CryptProtectData.restype = ctypes.c_int
    if not crypt.CryptProtectData(ctypes.byref(source), "TradeLoom operations", None, None, None, 1, ctypes.byref(result)):
        raise StoreUnavailable("DPAPI protection failed")
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        kernel = ctypes.WinDLL("kernel32")
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree(ctypes.cast(result.data, ctypes.c_void_p))


class CredentialStore:
    def __init__(self, root):
        if not root:
            raise StoreUnavailable("Server vault directory is not configured")
        self.root = Path(root)
        _secure_directory(self.root)

    def _path(self, slot):
        if slot not in (*SLOTS, "smtp_configuration"):
            raise ValueError("Unknown credential slot")
        path = self.root / (slot + ".dpapi")
        if path.is_symlink() or (path.exists() and getattr(path.stat(), "st_file_attributes", 0) & 0x400):
            raise StoreUnavailable("Invalid credential file")
        return path

    def metadata(self):
        return {slot: {"configured": self._path(slot).is_file()} for slot in SLOTS}

    def _read_for_provider(self, slot):
        """Internal use only. Never exposed by an HTTP view or diagnostics."""
        return self._unprotect(self._path(slot).read_bytes())

    @staticmethod
    def _unprotect(raw):
        if not raw or len(raw) > 65536:
            raise StoreUnavailable("Invalid protected credential")
        class Blob(ctypes.Structure):
            _fields_ = [("size", ctypes.c_uint32), ("data", ctypes.POINTER(ctypes.c_ubyte))]
        buf = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
        source, result = Blob(len(raw), buf), Blob()
        crypt = ctypes.WinDLL("crypt32", use_last_error=True)
        crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                                            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(Blob)]
        crypt.CryptUnprotectData.restype = ctypes.c_int
        if not crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
            raise StoreUnavailable("DPAPI decryption failed")
        try:
            return ctypes.string_at(result.data, result.size).decode("utf-8")
        finally:
            kernel = ctypes.WinDLL("kernel32")
            kernel.LocalFree.argtypes = [ctypes.c_void_p]
            kernel.LocalFree(ctypes.cast(result.data, ctypes.c_void_p))

    def set(self, slot, secret, *, verify=False):
        path = self._path(slot)
        if slot == "cloudflare_zone_id" and (not isinstance(secret, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", secret)):
            raise ValueError("Zone ID must contain exactly 32 hexadecimal characters")
        if not isinstance(secret, str) or not 1 <= len(secret.encode("utf-8")) <= 16384:
            raise ValueError("Secret must contain 1 to 16384 UTF-8 bytes")
        protected = _protect(secret)
        if verify and self._unprotect(protected) != secret:
            raise StoreUnavailable("Protected credential verification failed")
        fd, temporary = tempfile.mkstemp(prefix=".vault-", dir=self.root)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(protected)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def delete(self, slot):
        self._path(slot).unlink(missing_ok=True)
