"""Tests for tooling/apk_delta.py, on small zips made here.

    python3 -m unittest discover -s tooling -p 'test_*.py'
"""

import hashlib
import os
import pathlib
import random
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import apk_delta
from apk_delta import COPY, DATA, END, MAGIC, DeltaError

STORED, DEFLATED = zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED


def noise(n, seed):
    return random.Random(seed).randbytes(n)


TEXT = b"".join(b"line %d of a dex file\n" % i for i in range(4000))


class ApkDeltaTest(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)

    def zip(self, name, files, comment=b""):
        path = self.dir / name
        with zipfile.ZipFile(path, "w") as z:
            for entry, data, method in files:
                z.writestr(zipfile.ZipInfo(entry, date_time=(2026, 11, 1, 0, 0, 0)), data, compress_type=method)
            z.comment = comment
        return path

    def copied(self, base, new):
        """{entry of new: the offset in base it's copied from}."""
        at = {offset: name for name, _, _, _, offset in apk_delta.entries(new)}
        pos, out = 0, {}
        for op, offset, length in apk_delta.plan(base, new):
            if op == COPY:
                out[at[pos]] = offset
            pos += length
        return out

    def base_offsets(self, base):
        return {name: offset for name, _, _, _, offset in apk_delta.entries(base)}

    def round_trip(self, base, new):
        patch, out = self.dir / "p.dshdelta", self.dir / "out.apk"
        apk_delta.make(base, new, patch)
        apk_delta.apply(base, patch, out)
        self.assertEqual(out.read_bytes(), new.read_bytes())
        return patch

    def test_an_unchanged_entry_is_copied(self):
        files = [("lib/arm64-v8a/libflutter.so", noise(50_000, 1), DEFLATED), ("assets/rootfs.tar.xz", noise(80_000, 2), STORED)]
        base = self.zip("base.apk", files)
        new = self.zip("new.apk", files, comment=b"signed differently")
        self.assertEqual(self.copied(base, new), self.base_offsets(base))
        patch = self.round_trip(base, new)
        self.assertLess(patch.stat().st_size, 2_000)

    def test_a_changed_entry_is_data(self):
        base = self.zip("base.apk", [("lib/libapp.so", noise(60_000, 1), STORED), ("classes.dex", TEXT, DEFLATED)])
        new = self.zip("new.apk", [("lib/libapp.so", noise(60_000, 3), STORED), ("classes.dex", TEXT, DEFLATED)])
        self.assertEqual(self.copied(base, new), {"classes.dex": self.base_offsets(base)["classes.dex"]})
        patch = self.round_trip(base, new)
        self.assertGreater(patch.stat().st_size, 60_000)
        self.assertLess(patch.stat().st_size, 62_000)

    def test_reordered_entries_copy_out_of_order(self):
        files = [(f"res/{i}.bin", noise(10_000, i), STORED if i % 2 else DEFLATED) for i in range(5)]
        base = self.zip("base.apk", files)
        new = self.zip("new.apk", [("AndroidManifest.xml", b"<manifest/>", DEFLATED)] + files[::-1])
        copied = self.copied(base, new)
        self.assertEqual(copied, {name: offset for name, offset in self.base_offsets(base).items()})
        order = [name for name, _, _, _, _ in apk_delta.entries(new) if name in copied]
        self.assertEqual([copied[name] for name in order], sorted(copied.values(), reverse=True))
        self.round_trip(base, new)

    def test_stored_and_deflated(self):
        base = self.zip("base.apk", [("a.bin", TEXT, STORED), ("b.bin", TEXT, DEFLATED), ("c.bin", TEXT, STORED)])
        new = self.zip("new.apk", [("a.bin", TEXT, STORED), ("b.bin", TEXT, DEFLATED), ("c.bin", TEXT, DEFLATED)])
        # Same name and CRC-32, but compressed now: other bytes.
        self.assertEqual(sorted(self.copied(base, new)), ["a.bin", "b.bin"])
        self.round_trip(base, new)

    def test_same_header_fields_but_other_bytes_are_data(self):
        base = self.zip("base.apk", [("a.bin", TEXT, STORED)])
        new = self.zip("new.apk", [("a.bin", TEXT, STORED)])
        # Same name, CRC-32, size and method in the headers; the bytes differ.
        raw = bytearray(base.read_bytes())
        raw[self.base_offsets(base)["a.bin"] + 100] ^= 0xFF
        base.write_bytes(bytes(raw))
        self.assertEqual(self.copied(base, new), {})
        self.round_trip(base, new)

    def test_round_trip_is_byte_exact(self):
        rng = random.Random(7)
        files = [(f"f{i}", noise(rng.randrange(1, 30_000), i), rng.choice([STORED, DEFLATED])) for i in range(40)]
        base = self.zip("base.apk", files, comment=b"old")
        changed = [(name, noise(len(data), 100 + i) if i % 3 == 0 else data, method) for i, (name, data, method) in enumerate(files)]
        rng.shuffle(changed)
        new = self.zip("new.apk", changed[5:] + [("added", noise(5_000, 99), DEFLATED)], comment=b"new comment")
        self.round_trip(base, new)
        self.round_trip(new, base)

    def test_the_format(self):
        base = self.zip("base.apk", [("a", noise(9_000, 1), STORED), ("b", noise(9_000, 2), STORED), ("c", TEXT, DEFLATED)])
        new = self.zip("new.apk", [("a", noise(9_000, 1), STORED), ("b", noise(9_000, 3), STORED), ("c", TEXT, DEFLATED)])
        patch = self.round_trip(base, new).read_bytes()
        sha = lambda p: hashlib.sha256(p.read_bytes()).digest()
        self.assertEqual(patch[:80], MAGIC + sha(base) + sha(new) + struct.pack(">Q", new.stat().st_size))
        ops, pos = [], 80
        while patch[pos] != END:
            if patch[pos] == COPY:
                ops.append((COPY,) + struct.unpack(">QQ", patch[pos + 1 : pos + 17]))
                pos += 17
            else:
                self.assertEqual(patch[pos], DATA)
                (length,) = struct.unpack(">Q", patch[pos + 1 : pos + 9])
                ops.append((DATA, length))
                pos += 9 + length
        self.assertEqual(pos, len(patch) - 1)
        self.assertEqual([op for op, *_ in ops], [DATA, COPY, DATA, COPY, DATA])
        self.assertEqual(ops, [(op, offset, length) if op == COPY else (op, length) for op, offset, length in apk_delta.plan(base, new)])

    def test_another_base_is_refused(self):
        base = self.zip("base.apk", [("a", TEXT, DEFLATED)])
        other = self.zip("other.apk", [("a", TEXT + b"!", DEFLATED)])
        new = self.zip("new.apk", [("a", TEXT, DEFLATED), ("b", b"x", STORED)])
        patch, out = self.dir / "p.dshdelta", self.dir / "out.apk"
        apk_delta.make(base, new, patch)
        with self.assertRaisesRegex(DeltaError, "another base"):
            apk_delta.apply(other, patch, out)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["base.apk", "new.apk", "other.apk", "p.dshdelta"])

    def test_a_damaged_patch_leaves_nothing(self):
        base = self.zip("base.apk", [("a", noise(5_000, 1), STORED)])
        new = self.zip("new.apk", [("a", noise(5_000, 2), STORED)])
        patch, out = self.dir / "p.dshdelta", self.dir / "out.apk"
        apk_delta.make(base, new, patch)
        good = patch.read_bytes()
        for damaged, error in [
            (good[:200] + bytes([good[200] ^ 1]) + good[201:], "doesn't reproduce"),
            (good[:-1], "unexpected end"),
            (good[:80] + struct.pack(">BQ", DATA, 1 << 40) + good[89:], "past its target"),
            (b"DSHDLT02" + good[8:], "not a DSHDLT01 patch"),
        ]:
            patch.write_bytes(damaged)
            with self.assertRaisesRegex(DeltaError, error):
                apk_delta.apply(base, patch, out)
            self.assertFalse(out.exists() or pathlib.Path(f"{out}.part").exists())

    def staging_inputs(self):
        base = self.zip("source.apk", [("classes.dex", TEXT, DEFLATED)])
        new = self.zip("target.apk", [("classes.dex", TEXT + b"new revision", DEFLATED)], comment=b"target")
        patch = self.dir / "reference.dshdelta"
        apk_delta.make(base, new, patch)
        return base, new, patch

    def test_make_keeps_an_existing_part_file(self):
        base, new, _ = self.staging_inputs()
        out = self.dir / "publish.dshdelta"
        other = pathlib.Path(f"{out}.part")
        other.write_bytes(b"unrelated saved draft")
        before = set(self.dir.iterdir())
        apk_delta.make(base, new, out)
        apk_delta.apply(base, out)
        self.assertTrue(other.is_file(), "make must not remove another file")
        self.assertEqual(other.read_bytes(), b"unrelated saved draft")
        self.assertEqual(set(self.dir.iterdir()), before | {out})

    def test_apply_keeps_an_existing_part_file(self):
        base, new, patch = self.staging_inputs()
        out = self.dir / "restored.apk"
        other = pathlib.Path(f"{out}.part")
        other.write_bytes(b"unrelated recovery data")
        before = set(self.dir.iterdir())
        apk_delta.apply(base, patch, out)
        self.assertEqual(out.read_bytes(), new.read_bytes())
        self.assertTrue(other.is_file(), "apply must not remove another file")
        self.assertEqual(other.read_bytes(), b"unrelated recovery data")
        self.assertEqual(set(self.dir.iterdir()), before | {out})

    def test_failed_apply_keeps_existing_output_and_part(self):
        base, _, patch = self.staging_inputs()
        damaged = bytearray(patch.read_bytes())
        damaged[40] ^= 1  # A wrong target digest, after real output is written.
        patch.write_bytes(damaged)
        out = self.dir / "restored.apk"
        out.write_bytes(b"previous complete output")
        other = pathlib.Path(f"{out}.part")
        other.write_bytes(b"unrelated recovery data")
        before = set(self.dir.iterdir())
        with self.assertRaisesRegex(DeltaError, "doesn't reproduce"):
            apk_delta.apply(base, patch, out)
        self.assertEqual(out.read_bytes(), b"previous complete output")
        self.assertTrue(other.is_file())
        self.assertEqual(other.read_bytes(), b"unrelated recovery data")
        self.assertEqual(set(self.dir.iterdir()), before)

    def test_failed_make_commit_keeps_existing_directory_and_part(self):
        base, new, _ = self.staging_inputs()
        out = self.dir / "occupied.dshdelta"
        out.mkdir()
        (out / "owned-by-someone-else").write_bytes(b"keep directory contents")
        other = pathlib.Path(f"{out}.part")
        other.write_bytes(b"unrelated saved draft")
        before = set(self.dir.iterdir())
        with self.assertRaises(OSError):
            apk_delta.make(base, new, out)
        self.assertEqual((out / "owned-by-someone-else").read_bytes(), b"keep directory contents")
        self.assertTrue(other.is_file())
        self.assertEqual(other.read_bytes(), b"unrelated saved draft")
        self.assertEqual(set(self.dir.iterdir()), before)

    def concurrent_output(self, command):
        base, new, patch = self.staging_inputs()
        out = self.dir / ("concurrent.dshdelta" if command == "make" else "concurrent.apk")
        before = set(self.dir.iterdir())
        opened, committing = threading.Barrier(2), threading.Barrier(2)
        real_open, real_replace = open, os.replace
        paths, lock = [], threading.Lock()

        def open_together(path, mode="r", *args, **kwargs):
            stream = real_open(path, mode, *args, **kwargs)
            if mode == "wb" and os.fspath(path) != os.devnull:
                with lock:
                    paths.append(os.path.abspath(path))
                try:
                    opened.wait(timeout=10)
                except BaseException:
                    stream.close()
                    raise
            return stream

        def commit_together(source, destination):
            if pathlib.Path(destination) == out:
                committing.wait(timeout=10)
            return real_replace(source, destination)

        def invoke():
            if command == "make":
                return apk_delta.make(base, new, out)
            return apk_delta.apply(base, patch, out)

        with mock.patch.object(apk_delta, "open", open_together, create=True), mock.patch.object(
            apk_delta.os, "replace", commit_together
        ), ThreadPoolExecutor(max_workers=2) as pool:
            pending = [pool.submit(invoke) for _ in range(2)]
            failures = []
            for future in pending:
                try:
                    future.result(timeout=15)
                except Exception as error:
                    failures.append(f"{type(error).__name__}: {error}")
        self.assertEqual(failures, [], "both independently valid invocations must finish")
        self.assertEqual(len(set(paths)), 2, "writers must own separate paths")
        if command == "make":
            apk_delta.apply(base, out)
        else:
            self.assertEqual(out.read_bytes(), new.read_bytes())
        self.assertEqual(set(self.dir.iterdir()), before | {out})

    def test_concurrent_make_does_not_remove_the_other_writer(self):
        self.concurrent_output("make")

    def test_concurrent_apply_does_not_remove_the_other_writer(self):
        self.concurrent_output("apply")

    @unittest.skipUnless(os.name == "posix", "POSIX creation modes")
    def test_output_modes_still_follow_normal_open_umask(self):
        base, new, patch = self.staging_inputs()
        script = pathlib.Path(apk_delta.__file__).resolve()
        child = (
            "import os, runpy, sys; os.umask(0o027); "
            "sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')"
        )
        for command, second, out in [
            ("make", new, self.dir / "mode.dshdelta"),
            ("apply", patch, self.dir / "mode.apk"),
        ]:
            subprocess.run(
                [sys.executable, "-I", "-c", child, str(script), command, str(base), str(second), str(out)],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o640)


if __name__ == "__main__":
    unittest.main()
