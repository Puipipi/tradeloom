#!/usr/bin/env python3
"""Delta updates between two APKs (docs/design/delta-update.md).

    python3 tooling/apk_delta.py make BASE NEW OUT      a patch that turns BASE into NEW
    python3 tooling/apk_delta.py apply BASE PATCH OUT   NEW again, checked against the patch

A patch (DSHDLT01, big-endian) is a header, then ops that write NEW front to back:

    "DSHDLT01", SHA-256 of BASE (32 bytes), SHA-256 of NEW (32 bytes), u64 length of NEW
    0x01 COPY  u64 offset in BASE, u64 length
    0x02 DATA  u64 length, then that many bytes
    0x00 END

`make` works per zip entry: an entry of NEW whose compressed bytes are in BASE
too (same name, CRC-32, compressed size and method, and the bytes compared) is
a COPY of them; everything else (local headers, changed entries, the APK
Signing Block, the central directory) is DATA. It applies the patch before
writing OUT. Standard library only, so it runs under `python3 -I`.
"""

import hashlib
import os
import struct
import sys
import tempfile
import zipfile
from contextlib import contextmanager

MAGIC = b"DSHDLT01"
END, COPY, DATA = 0, 1, 2
HEADER = 80  # magic, two SHA-256, u64
CHUNK = 1 << 20


class DeltaError(Exception):
    pass


def sha256(path) -> bytes:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            digest.update(chunk)
    return digest.digest()


def entries(path):
    """(name, CRC-32, compressed size, method, offset of the compressed bytes) per entry."""
    with zipfile.ZipFile(path) as z, open(path, "rb") as f:
        out = []
        for info in z.infolist():
            # The local header's name and extra field can differ from the central
            # directory's (zipalign pads the local extra field).
            f.seek(info.header_offset + 26)
            name_len, extra_len = struct.unpack("<HH", f.read(4))
            out.append((info.filename, info.CRC, info.compress_size, info.compress_type, info.header_offset + 30 + name_len + extra_len))
        return out


def read(f, n):
    data = f.read(n)
    if len(data) < n:
        raise DeltaError(f"{f.name}: unexpected end of file")
    return data


def chunks(f, offset, length):
    f.seek(offset)
    while length:
        chunk = read(f, min(length, CHUNK))
        length -= len(chunk)
        yield chunk


def same(a, a_offset, b, b_offset, length) -> bool:
    return all(x == y for x, y in zip(chunks(a, a_offset, length), chunks(b, b_offset, length)))


def plan(base, new):
    """The ops that turn [base] into [new], as (op, offset, length): COPY offsets
    are in base, DATA offsets in new."""
    old = {name: (crc, size, method, offset) for name, crc, size, method, offset in entries(base)}
    copies = []
    with open(base, "rb") as b, open(new, "rb") as n:
        for name, crc, size, method, offset in entries(new):
            match = old.get(name)
            if size and match and match[:3] == (crc, size, method) and same(b, match[3], n, offset, size):
                copies.append((offset, size, match[3]))
        end = n.seek(0, os.SEEK_END)
    ops = []

    def add(op, offset, length):
        last = ops[-1] if ops else None
        if last and last[0] == op and (op == DATA or last[1] + last[2] == offset):
            ops[-1] = (op, last[1], last[2] + length)
        else:
            ops.append((op, offset, length))

    pos = 0
    for start, length, at in sorted(copies):
        if start > pos:
            add(DATA, pos, start - pos)
        add(COPY, at, length)
        pos = start + length
    if end > pos:
        add(DATA, pos, end - pos)
    return ops


@contextmanager
def _staged_output(out):
    if not out:
        yield os.devnull
        return
    parent = os.path.dirname(os.path.abspath(out))
    # A private directory owns the path, while ordinary open() preserves
    # the output's normal creation mode and the caller's umask.
    with tempfile.TemporaryDirectory(prefix=".dsh-apk-delta-", dir=parent) as directory:
        yield os.path.join(directory, "output")


def apply(base, patch, out=None):
    """Writes NEW from [base] and [patch] to [out] (None: only checks it).
    Refuses a patch for another base; anything but exactly the target's length
    and SHA-256 is an error, and leaves nothing at [out]."""
    with _staged_output(out) as tmp:
        with open(base, "rb") as b, open(patch, "rb") as p, open(tmp, "wb") as sink:
            head = read(p, HEADER)
            if head[:8] != MAGIC:
                raise DeltaError(f"{patch}: not a DSHDLT01 patch")
            if head[8:40] != sha256(base):
                raise DeltaError(f"{patch} is for another base APK")
            want, (size,) = head[40:72], struct.unpack(">Q", head[72:])
            digest, written = hashlib.sha256(), 0
            while (op := read(p, 1)[0]) != END:
                if op == COPY:
                    offset, length = struct.unpack(">QQ", read(p, 16))
                    source = chunks(b, offset, length)
                elif op == DATA:
                    (length,) = struct.unpack(">Q", read(p, 8))
                    source = chunks(p, p.tell(), length)
                else:
                    raise DeltaError(f"{patch}: unknown op {op} at byte {p.tell() - 1}")
                if written + length > size:
                    raise DeltaError(f"{patch} writes past its target's length")
                for chunk in source:
                    digest.update(chunk)
                    sink.write(chunk)
                written += length
            if written != size or digest.digest() != want:
                raise DeltaError(f"{patch} doesn't reproduce its target")
        if out:
            os.replace(tmp, out)


def make(base, new, out):
    """Writes the patch from [base] to [new] at [out], once applying it gives
    [new] back. Returns its ops (see plan)."""
    ops = plan(base, new)
    with _staged_output(out) as tmp:
        with open(new, "rb") as n, open(tmp, "wb") as f:
            f.write(MAGIC + sha256(base) + sha256(new) + struct.pack(">Q", n.seek(0, os.SEEK_END)))
            for op, offset, length in ops:
                if op == COPY:
                    f.write(struct.pack(">BQQ", COPY, offset, length))
                else:
                    f.write(struct.pack(">BQ", DATA, length))
                    for chunk in chunks(n, offset, length):
                        f.write(chunk)
            f.write(bytes([END]))
        apply(base, tmp)
        os.replace(tmp, out)
    return ops


def main(argv):
    if len(argv) != 4 or argv[0] not in ("make", "apply"):
        sys.exit(__doc__.split("\n\n")[1])
    cmd, base, second, out = argv
    try:
        if cmd == "apply":
            apply(base, second, out)
            print(f"{out}: {os.path.getsize(out)} bytes, the patch's target")
            return
        ops = make(base, second, out)
    except DeltaError as e:
        sys.exit(f"apk_delta: {e}")
    copies = [length for op, _, length in ops if op == COPY]
    size, target = os.path.getsize(out), os.path.getsize(second)
    print(f"{out}: {size} bytes, {size / target:.1%} of {target}; COPY {sum(copies)} bytes in {len(copies)} ops, DATA {target - sum(copies)} bytes")


if __name__ == "__main__":
    main(sys.argv[1:])
