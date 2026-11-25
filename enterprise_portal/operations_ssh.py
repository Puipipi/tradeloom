"""Bounded, read-only Windows sshd declaration inspection; never evaluates login."""
import ctypes
from ctypes import wintypes
import os
import re
import shlex

MAX_BYTES = 65536
MAX_LINES = 512
MAX_TOKENS = 128
NAMES = ("denyusers", "allowusers", "denygroups", "allowgroups")
FLAGS = ("passwordauthentication", "pubkeyauthentication")
LIMITATIONS = ["仅检查磁盘声明，不代表服务已加载或任何身份可以登录。",
               "不读取密钥、不解析账户或用户组、不修改服务或配置。",
               "仅检查四类允许/拒绝声明与密码、公钥认证开关；其余指令不读取目标、不执行。",
               "仅支持已核实默认服务命令和默认配置；Match、Include 不展开。"]
LIMITATIONS.append("固定组成员管理仅由 Windows 管理员在服务器本机运行 Manage-SshAccess.ps1；网页、个人端和助手无远程变更入口。")


def _windows_directory():
    buffer = ctypes.create_unicode_buffer(32768)
    if not ctypes.windll.kernel32.GetWindowsDirectoryW(buffer, len(buffer)):
        raise OSError()
    return buffer.value


def _default_path():
    # OS known folder API, not request parameters or environment variables.
    buffer = ctypes.create_unicode_buffer(32768)
    if ctypes.windll.shell32.SHGetFolderPathW(None, 35, None, 0, buffer) != 0:
        raise OSError()
    return os.path.join(buffer.value, "ssh", "sshd_config")


def _configuration_source(command):
    expected = os.path.normcase(os.path.join(_windows_directory(), "System32", "OpenSSH", "sshd.exe"))
    command = command.strip()
    if command.startswith('"'):
        end = command.find('"', 1)
        if end < 0:
            return "unknown"
        executable, arguments = command[1:end], command[end + 1:].strip()
    else:
        fields = command.split(None, 1)
        if not fields:
            return "unknown"
        executable, arguments = fields[0], fields[1] if len(fields) > 1 else ""
    # -f, -o and all other customized arguments are deliberately not interpreted.
    return "default" if not arguments and os.path.normcase(executable) == expected else "customized"


def query_service():
    result = {"query_state": "unsupported", "status": "unknown", "start_type": "unknown",
              "configuration_source": "unknown"}
    if os.name != "nt":
        return result
    scm = service = None
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    api.OpenSCManagerW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    api.OpenSCManagerW.restype = wintypes.HANDLE
    api.OpenServiceW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.DWORD]
    api.OpenServiceW.restype = wintypes.HANDLE
    api.CloseServiceHandle.argtypes = [wintypes.HANDLE]
    api.QueryServiceStatus.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    api.QueryServiceConfigW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]

    class Config(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("start", wintypes.DWORD), ("error", wintypes.DWORD),
                    ("binary", wintypes.LPWSTR), ("group", wintypes.LPWSTR), ("tag", wintypes.DWORD),
                    ("dependencies", wintypes.LPWSTR), ("account", wintypes.LPWSTR), ("display", wintypes.LPWSTR)]
    try:
        # SC_MANAGER_CONNECT; SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS only.
        scm = api.OpenSCManagerW(None, None, 1)
        if not scm:
            raise ctypes.WinError(ctypes.get_last_error())
        service = api.OpenServiceW(scm, "sshd", 1 | 4)
        if not service:
            raise ctypes.WinError(ctypes.get_last_error())
        status = (wintypes.DWORD * 7)()
        if not api.QueryServiceStatus(service, status):
            raise ctypes.WinError(ctypes.get_last_error())
        result["status"] = {1: "stopped", 4: "running"}.get(status[1], "pending")
        needed = wintypes.DWORD()
        buffer = ctypes.create_string_buffer(8192)
        if not api.QueryServiceConfigW(service, buffer, len(buffer), ctypes.byref(needed)):
            raise ctypes.WinError(ctypes.get_last_error())
        config = ctypes.cast(buffer, ctypes.POINTER(Config)).contents
        result.update(query_state="ok", start_type={2: "automatic", 3: "manual", 4: "disabled"}.get(config.start, "unknown"),
                      configuration_source=_configuration_source(config.binary or ""))
    except OSError as exc:
        result["query_state"] = {5: "denied", 1060: "not_installed"}.get(getattr(exc, "winerror", None), "unavailable")
    finally:
        if service:
            api.CloseServiceHandle(service)
        if scm:
            api.CloseServiceHandle(scm)
    return result


def read_default_config():
    """Open only the OS-derived default file, reject reparse points and handle redirection."""
    import msvcrt
    path = _default_path()
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetFileAttributesW.argtypes = [wintypes.LPCWSTR]
    kernel.GetFileAttributesW.restype = wintypes.DWORD
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                  wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    for component in (os.path.dirname(os.path.dirname(path)), os.path.dirname(path), path):
        attrs = kernel.GetFileAttributesW(component)
        if attrs == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        if attrs & 0x400:
            raise ValueError("unsafe")
    handle = kernel.CreateFileW(path, 0x80000000, 1, None, 3, 0x00200000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        final = ctypes.create_unicode_buffer(32768)
        length = kernel.GetFinalPathNameByHandleW(handle, final, len(final), 0)
        if not length or length >= len(final) or os.path.normcase(final.value.removeprefix("\\\\?\\")) != os.path.normcase(path):
            raise ValueError("unsafe")
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None
        with os.fdopen(fd, "rb") as source:
            if os.fstat(source.fileno()).st_nlink != 1:
                raise ValueError("unsafe")
            raw = source.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("too_large")
        return raw
    finally:
        if handle is not None:
            kernel.CloseHandle(handle)


def empty_config(state="not_inspected"):
    return {"state": state, "partial": True, "reasons": [], "directive_counts": {name: 0 for name in NAMES},
            "auth_flags": {name: "unspecified" for name in FLAGS}}


def parse_config(raw, include_names=False):
    result = empty_config("read")
    names = {name: [] for name in NAMES}
    reasons = set()
    if len(raw) > MAX_BYTES:
        return empty_config("too_large")
    try:
        text = raw.decode("utf-8-sig", errors="strict")
    except UnicodeError:
        return empty_config("unavailable")
    lines = text.splitlines()
    if len(lines) > MAX_LINES:
        return empty_config("too_large")
    scoped = False
    seen_flags = set()
    for line in lines:
        if len(line) > 4096 or any(ord(c) < 32 and c != "\t" for c in line):
            reasons.add("malformed")
            continue
        try:
            lexer = shlex.shlex(line, posix=True)
            lexer.whitespace_split, lexer.escape = True, ""
            tokens = list(lexer)
        except ValueError:
            reasons.add("malformed")
            continue
        if not tokens:
            continue
        key, values = tokens[0].lower(), tokens[1:]
        # Unsupported '=' syntax must not hide a Match/Include boundary and
        # accidentally classify following scoped declarations as global.
        base = key.split("=", 1)[0]
        if "=" in key or (values and values[0].startswith("=")) or not re.fullmatch(r"[a-z][a-z0-9]*", key):
            reasons.add("malformed")
            if base == "match" or key.startswith("match"):
                scoped = True
                reasons.add("match_not_evaluated")
            if base == "include" or key.startswith("include"):
                reasons.add("include_not_followed")
            continue
        if key == "match":
            scoped = True
            reasons.add("match_not_evaluated")
            continue
        if key == "include":
            reasons.add("include_not_followed")
            continue
        if key.startswith("match"):
            scoped = True
            reasons.update(("malformed", "match_not_evaluated"))
            continue
        if key.startswith("include"):
            reasons.update(("malformed", "include_not_followed"))
            continue
        if scoped or key not in (*NAMES, *FLAGS):
            continue
        if not values or len(values) > MAX_TOKENS or any(len(v) > 256 or not v for v in values):
            reasons.add("malformed")
            if key in FLAGS:
                result["auth_flags"][key] = "unknown"
            continue
        if key in NAMES:
            if len(names[key]) + len(values) > MAX_TOKENS:
                reasons.add("too_many_declarations")
                continue
            names[key].extend(values)
        elif len(values) != 1 or values[0].lower() not in ("yes", "no"):
            reasons.add("malformed")
            result["auth_flags"][key] = "unknown"
        elif key not in seen_flags:
            result["auth_flags"][key] = values[0].lower()
            seen_flags.add(key)
        else:
            reasons.add("repeated_auth_flag")
    result.update(partial=bool(reasons), reasons=sorted(reasons), directive_counts={key: len(values) for key, values in names.items()})
    if include_names:
        result["declared_names"] = names
    return result


def inspect(include_names=False, can_view_names=False):
    service = query_service()
    config = empty_config()
    if service["query_state"] == "ok" and service["configuration_source"] == "default":
        try:
            config = parse_config(read_default_config(), include_names and can_view_names)
        except ValueError as exc:
            config = empty_config(str(exc) if str(exc) in ("unsafe", "too_large") else "unavailable")
        except OSError as exc:
            config = empty_config({2: "missing", 3: "missing", 5: "denied"}.get(getattr(exc, "winerror", None), "unavailable"))
    return {"read_only": True, "can_view_names": bool(can_view_names),
            "names_included": "declared_names" in config, "service": service, "config": config,
            "limitations": LIMITATIONS}
