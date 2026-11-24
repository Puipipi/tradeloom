"""Bounded Windows-only identity probe. No issuer, Django, secrets or browser.

Creates random ephemeral named pipes in this process only. The child supplies a
fixed byte request; SID comes from the kernel token, never a request field.
"""
import ctypes as c
from ctypes import wintypes as w
import json
import os
import secrets
import subprocess
import sys

if os.name != "nt":
    raise SystemExit("Windows only")
k = c.WinDLL("kernel32", use_last_error=True)
a = c.WinDLL("advapi32", use_last_error=True)
HANDLE = w.HANDLE
INVALID = c.c_void_p(-1).value


class Overlapped(c.Structure):
    _fields_ = [("Internal", c.c_size_t), ("InternalHigh", c.c_size_t),
                ("Offset", w.DWORD), ("OffsetHigh", w.DWORD), ("hEvent", HANDLE)]


class SecurityAttributes(c.Structure):
    _fields_ = [("length", w.DWORD), ("descriptor", c.c_void_p), ("inherit", w.BOOL)]


def bind(dll, name, result, *args):
    f = getattr(dll, name)
    f.restype, f.argtypes = result, args
    return f


close = bind(k, "CloseHandle", w.BOOL, HANDLE)
event = bind(k, "CreateEventW", HANDLE, c.c_void_p, w.BOOL, w.BOOL, w.LPCWSTR)
wait = bind(k, "WaitForSingleObject", w.DWORD, HANDLE, w.DWORD)
cancel = bind(k, "CancelIoEx", w.BOOL, HANDLE, c.c_void_p)
create = bind(k, "CreateNamedPipeW", HANDLE, w.LPCWSTR, w.DWORD, w.DWORD,
              w.DWORD, w.DWORD, w.DWORD, w.DWORD, c.POINTER(SecurityAttributes))
connect = bind(k, "ConnectNamedPipe", w.BOOL, HANDLE, c.POINTER(Overlapped))
read = bind(k, "ReadFile", w.BOOL, HANDLE, c.c_void_p, w.DWORD,
            c.POINTER(w.DWORD), c.c_void_p)
write = bind(k, "WriteFile", w.BOOL, HANDLE, c.c_void_p, w.DWORD,
             c.POINTER(w.DWORD), c.c_void_p)
completed = bind(k, "GetOverlappedResult", w.BOOL, HANDLE,
                 c.POINTER(Overlapped), c.POINTER(w.DWORD), w.BOOL)
open_file = bind(k, "CreateFileW", HANDLE, w.LPCWSTR, w.DWORD, w.DWORD,
                 c.c_void_p, w.DWORD, w.DWORD, HANDLE)
get_process = bind(k, "GetCurrentProcess", HANDLE)
get_thread = bind(k, "GetCurrentThread", HANDLE)
open_process_token = bind(a, "OpenProcessToken", w.BOOL, HANDLE, w.DWORD, c.POINTER(HANDLE))
open_thread_token = bind(a, "OpenThreadToken", w.BOOL, HANDLE, w.DWORD, w.BOOL, c.POINTER(HANDLE))
token_info = bind(a, "GetTokenInformation", w.BOOL, HANDLE, c.c_int,
                  c.c_void_p, w.DWORD, c.POINTER(w.DWORD))
sid_string = bind(a, "ConvertSidToStringSidW", w.BOOL, c.c_void_p, c.POINTER(c.c_void_p))
descriptor = bind(a, "ConvertStringSecurityDescriptorToSecurityDescriptorW", w.BOOL,
                  w.LPCWSTR, w.DWORD, c.POINTER(c.c_void_p), c.POINTER(w.DWORD))
impersonate = bind(a, "ImpersonateNamedPipeClient", w.BOOL, HANDLE)
revert = bind(a, "RevertToSelf", w.BOOL)
free = bind(k, "LocalFree", c.c_void_p, c.c_void_p)
REQUEST = b"TL_LOCAL_ID_PROBE_V1\n"
# Specific client rights only: READ/WRITE_DATA, READ_ATTRIBUTES,
# READ_CONTROL, SYNCHRONIZE. No FILE_CREATE_PIPE_INSTANCE (0x4).
CLIENT_RIGHTS = 0x120083


def require(ok):
    if not ok:
        raise OSError(c.get_last_error(), "Native probe call failed")


def info(token, kind):
    size = w.DWORD()
    token_info(token, kind, None, 0, c.byref(size))
    buffer = c.create_string_buffer(size.value)
    require(token_info(token, kind, buffer, size, c.byref(size)))
    return buffer


def sid(pointer):
    value = c.c_void_p()
    require(sid_string(pointer, c.byref(value)))
    try:
        return c.wstring_at(value)
    finally:
        free(value)


def token_sid(token, kind=1):
    buffer = info(token, kind)
    return sid(c.c_void_p.from_buffer(buffer).value)


def own_sid():
    token = HANDLE()
    require(open_process_token(get_process(), 8, c.byref(token)))
    try:
        return token_sid(token)
    finally:
        close(token)


def io(pipe, operation, buffer, length):
    ov = Overlapped(hEvent=event(None, True, False, None))
    count = w.DWORD()
    try:
        if not operation(pipe, buffer, length, c.byref(count), c.byref(ov)):
            require(c.get_last_error() == 997)
            if wait(ov.hEvent, 3000) != 0:
                cancel(pipe, c.byref(ov))
                # Drain completion before freeing OVERLAPPED/buffer memory.
                completed(pipe, c.byref(ov), c.byref(count), True)
                raise TimeoutError("Bounded native I/O timeout")
            require(completed(pipe, c.byref(ov), c.byref(count), False))
        return count.value
    finally:
        close(ov.hEvent)


def child(name, anonymous):
    # SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION; never delegation.
    pipe = open_file(name, CLIENT_RIGHTS, 0, None, 3,
                     0x100000 | (0 if anonymous else 0x10000), None)
    if pipe == INVALID:
        return {"connected": False, "winerror": c.get_last_error()}
    try:
        count = w.DWORD()
        require(write(pipe, REQUEST, len(REQUEST), c.byref(count), None))
        buffer = c.create_string_buffer(128)
        require(read(pipe, buffer, len(buffer), c.byref(count), None))
        return {"connected": True, "response": buffer.raw[:count.value].decode("ascii")}
    finally:
        close(pipe)


def case(allowed_sid, anonymous=False, verified_response=None):
    name = r"\\.\pipe\TradeLoomIdentityProbe-" + secrets.token_hex(16)
    sd = c.c_void_p()
    require(descriptor(f"D:P(A;;0x{CLIENT_RIGHTS:x};;;{allowed_sid})", 1, c.byref(sd), None))
    sa = SecurityAttributes(c.sizeof(SecurityAttributes), sd, False)
    pipe = create(name, 3 | 0x80000 | 0x40000000, 4 | 2 | 8, 1, 128, 128, 3000, c.byref(sa))
    free(sd)
    require(pipe != INVALID)
    ov = Overlapped(hEvent=event(None, True, False, None))
    process = None
    result = {"first_instance": True, "reject_remote_flag": True,
              "client_create_instance_right": bool(CLIENT_RIGHTS & 4)}
    try:
        duplicate = create(name, 3 | 0x80000, 4 | 2 | 8, 1, 128, 128, 3000, None)
        if duplicate != INVALID:
            close(duplicate)
            raise AssertionError("Duplicate pipe accepted")
        result["duplicate_instance_denied"] = c.get_last_error() == 5
        connected = connect(pipe, c.byref(ov))
        require(connected or c.get_last_error() in (997, 535))
        process = subprocess.Popen([sys.executable, "-I", __file__, "--client", name,
                                    "anonymous" if anonymous else "identification"],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if not connected and wait(ov.hEvent, 3000) != 0:
            cancel(pipe, c.byref(ov))
            count = w.DWORD()
            completed(pipe, c.byref(ov), c.byref(count), True)
            result["client"] = json.loads(process.communicate(timeout=4)[0])
            result["accepted"] = False
            return result
        buffer = c.create_string_buffer(64)
        count = io(pipe, read, buffer, len(buffer))
        require(buffer.raw[:count] == REQUEST)
        accepted = False
        try:
            require(impersonate(pipe))
            token = HANDLE()
            if open_thread_token(get_thread(), 8, True, c.byref(token)):
                try:
                    token_type = w.DWORD.from_buffer(info(token, 8)).value
                    level = w.DWORD.from_buffer(info(token, 9)).value
                    integrity = int(token_sid(token, 25).rsplit("-", 1)[1])
                    accepted = (token_sid(token) == allowed_sid and token_type == 2
                                and level == 1 and integrity >= 0x2000)
                    result.update(kernel_sid_matches=token_sid(token) == allowed_sid,
                                  identification_only=level == 1, integrity_at_least_medium=integrity >= 0x2000)
                finally:
                    close(token)
            else:
                result["token_rejected_winerror"] = c.get_last_error()
        finally:
            if not revert():
                os._exit(3)  # Never continue in an unknown impersonation context.
        token = HANDLE()
        require(not open_thread_token(get_thread(), 8, True, c.byref(token)))
        result["reverted_no_thread_token"] = c.get_last_error() == 1008
        require(result["reverted_no_thread_token"])
        # A trusted test harness may supply an in-memory payload only after
        # identity validation AND successful RevertToSelf/no-thread-token check.
        # The standalone probe never invokes an application or issuer.
        response = verified_response() if accepted and verified_response else (b"probe-allowed" if accepted else b"probe-denied")
        if not isinstance(response, bytes) or len(response) > 128:
            raise ValueError("Probe response must be bounded bytes")
        io(pipe, write, response, len(response))
        result.update(accepted=accepted, client=json.loads(process.communicate(timeout=4)[0]))
        return result
    finally:
        cancel(pipe, None)
        close(ov.hEvent)
        close(pipe)
        if process and process.poll() is None:
            process.kill()
            process.communicate(timeout=3)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--client":
        print(json.dumps(child(sys.argv[2], sys.argv[3] == "anonymous")))
    else:
        identity = own_sid()
        results = {"same_sid": case(identity),
                   "excluded_sid": case("S-1-5-21-111-222-333-9999"),
                   "anonymous": case(identity, True)}
        assert results["same_sid"]["accepted"] and results["same_sid"]["reverted_no_thread_token"]
        assert not results["excluded_sid"]["accepted"] and not results["anonymous"]["accepted"]
        assert all(not v["client_create_instance_right"] and v["duplicate_instance_denied"] for v in results.values())
        print(json.dumps(results, indent=2))
