"""Exercise the product launcher on a private, never activated Windows desktop."""
import argparse
import ctypes as c
from ctypes import wintypes as w
import os
from pathlib import Path
import struct
import subprocess
import uuid

p = argparse.ArgumentParser()
p.add_argument('--launcher', required=True)
p.add_argument('--theme', choices=['Light', 'Dark', 'HighContrast'])
p.add_argument('--output-root')
a = p.parse_args()
assert os.name == 'nt'
user = c.WinDLL('user32', use_last_error=True)
kernel = c.WinDLL('kernel32', use_last_error=True)

class Startup(c.Structure):
    _fields_ = [('cb', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR),
                ('title', w.LPWSTR), ('x', w.DWORD), ('y', w.DWORD),
                ('xs', w.DWORD), ('ys', w.DWORD), ('xc', w.DWORD), ('yc', w.DWORD),
                ('fill', w.DWORD), ('flags', w.DWORD), ('show', w.WORD),
                ('reserved_size', w.WORD), ('reserved_bytes', c.c_void_p),
                ('stdin', w.HANDLE), ('stdout', w.HANDLE), ('stderr', w.HANDLE)]
class Process(c.Structure):
    _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE), ('pid', w.DWORD), ('tid', w.DWORD)]
class BasicLimits(c.Structure):
    _fields_ = [('process_time', c.c_int64), ('job_time', c.c_int64), ('flags', w.DWORD),
                ('min_working', c.c_size_t), ('max_working', c.c_size_t), ('active', w.DWORD),
                ('affinity', c.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
class Limits(c.Structure):
    _fields_ = [('basic', BasicLimits), ('io', c.c_uint64 * 6),
                ('process_memory', c.c_size_t), ('job_memory', c.c_size_t),
                ('peak_process', c.c_size_t), ('peak_job', c.c_size_t)]

user.CreateDesktopW.argtypes = [w.LPCWSTR, w.LPCWSTR, c.c_void_p, w.DWORD, w.DWORD, c.c_void_p]
user.CreateDesktopW.restype = w.HANDLE
user.CloseDesktop.argtypes = [w.HANDLE]
kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
kernel.CreateJobObjectW.restype = w.HANDLE
kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
kernel.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL,
                                w.DWORD, c.c_void_p, w.LPCWSTR, c.POINTER(Startup), c.POINTER(Process)]
kernel.ResumeThread.argtypes = [w.HANDLE]
kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
kernel.GetExitCodeProcess.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
kernel.CloseHandle.argtypes = [w.HANDLE]

desktop_name = 'TradeLoomVisibilityQA-' + uuid.uuid4().hex
desktop = user.CreateDesktopW(desktop_name, None, None, 0, 0x10000000, None)
assert desktop, c.WinError(c.get_last_error())
job = kernel.CreateJobObjectW(None, None)
info = Process()
try:
    limits = Limits(); limits.basic.flags = 0x2000  # Kill only this QA process tree on close.
    assert kernel.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits))
    startup = Startup(); startup.cb = c.sizeof(startup); startup.desktop = desktop_name
    launcher = Path(a.launcher).resolve()
    if a.theme:
        assert a.output_root, 'Visual probe requires an isolated output root'
        output = Path(a.output_root).resolve() / a.theme
        output.mkdir(parents=True, exist_ok=False)
        args = [os.environ['WINDIR'] + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                '-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'RemoteSigned',
                '-File', str(launcher.parent / 'scripts/ServerWindow.ps1'), '-Probe',
                '-VisualProbeTheme', a.theme, '-VisualProbeDirectory', str(output)]
    else:
        args = [os.environ['WINDIR'] + '\\System32\\cscript.exe', '//nologo', str(launcher), '-VisibilityProbe']
    command = c.create_unicode_buffer(subprocess.list2cmdline(args))
    assert kernel.CreateProcessW(None, command, None, None, False, 0x14, None,
                                 str(launcher.parent), c.byref(startup), c.byref(info)), c.WinError(c.get_last_error())
    assert kernel.AssignProcessToJobObject(job, info.process), c.WinError(c.get_last_error())
    kernel.ResumeThread(info.thread)
    assert kernel.WaitForSingleObject(info.process, 20000) == 0, 'Private desktop probe timed out'
    result = w.DWORD(); assert kernel.GetExitCodeProcess(info.process, c.byref(result))
    print('launcher_exit=' + str(result.value), flush=True)
    assert result.value == 0, {2: 'Product form hidden', 3: 'Console visible', 4: 'Visibility not sampled'}.get(result.value, 'Launcher failed')
    if a.theme:
        for name, size in [('server', (650, 540)), ('management', (624, 260)),
                           ('email', (540, 530)), ('smtp', (540, 530)), ('smtp-guide', (540, 530)),
                           ('smtp-locked', (540, 530))]:
            raw = (output / (name + '.png')).read_bytes()
            assert raw[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', raw[16:24]) == size
        print('PASS: ' + a.theme + ' synthetic main/management/email/SMTP and guide snapshots; private desktop never activated')
    else:
        print('PASS: own product form visible, own console hidden; private desktop never activated')
finally:
    if info.thread: kernel.CloseHandle(info.thread)
    if info.process: kernel.CloseHandle(info.process)
    if job: kernel.CloseHandle(job)
    user.CloseDesktop(desktop)
