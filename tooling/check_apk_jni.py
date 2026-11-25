#!/usr/bin/env python3
"""Check JNI class definitions in the actual R8 output, not just DEX string references."""

import argparse
from pathlib import Path
import re
import struct
import zipfile


REQUIRED_CLASSES = {
    "Lai/onnxruntime/OrtException;",
    "Lai/onnxruntime/OrtSession;",
    "Lai/onnxruntime/OnnxTensor;",
    "Lai/onnxruntime/TensorInfo;",
}


class ApkJniError(ValueError):
    pass


def dex_classes(data: bytes) -> set[str]:
    """Read class_def -> type_id -> string_id for standard little-endian DEX files."""
    if (len(data) < 112 or not re.fullmatch(rb"dex\n[0-9]{3}\x00", data[:8])
            or struct.unpack_from("<III", data, 32) != (len(data), 112, 0x12345678)):
        raise ApkJniError("Invalid or unsupported DEX header")

    def table(offset: int, width: int) -> tuple[int, int]:
        count, start = struct.unpack_from("<II", data, offset)
        if count and (start < 112 or start + count * width > len(data)):
            raise ApkJniError("DEX table extends outside the file")
        return count, start

    strings, string_ids = table(56, 4)
    types, type_ids = table(64, 4)
    classes, class_defs = table(96, 32)
    result = set()
    for i in range(classes):
        type_id = struct.unpack_from("<I", data, class_defs + i * 32)[0]
        if type_id >= types:
            raise ApkJniError("Invalid DEX class type index")
        string_id = struct.unpack_from("<I", data, type_ids + type_id * 4)[0]
        if string_id >= strings:
            raise ApkJniError("Invalid DEX descriptor string index")
        pos = struct.unpack_from("<I", data, string_ids + string_id * 4)[0]
        # A string_data_item starts with its UTF-16 length encoded as ULEB128.
        for _ in range(5):
            if pos >= len(data):
                raise ApkJniError("Truncated DEX descriptor")
            byte = data[pos]
            pos += 1
            if byte < 128:
                break
        else:
            raise ApkJniError("Invalid DEX descriptor length")
        try:
            end = data.index(0, pos)
        except ValueError as error:
            raise ApkJniError("Unterminated DEX descriptor") from error
        # Required JNI names are ASCII; do not need a full MUTF-8 decoder for other classes.
        result.add(data[pos:end].decode("ascii", errors="replace"))
    return result


def check_apk_jni(path: Path) -> None:
    defined = set()
    try:
        with zipfile.ZipFile(path) as apk:
            dex_files = [name for name in apk.namelist() if re.fullmatch(r"classes(?:[2-9]|[1-9][0-9]+)?\.dex", name)]
            if not dex_files:
                raise ApkJniError("APK contains no classes*.dex")
            for name in dex_files:
                defined.update(dex_classes(apk.read(name)))
    except (OSError, zipfile.BadZipFile) as error:
        raise ApkJniError(f"Cannot inspect APK: {error}") from error
    missing = REQUIRED_CLASSES - defined
    if missing:
        raise ApkJniError("APK is missing JNI class definitions (check R8 keep rules): " + ", ".join(sorted(missing)))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    args = parser.parse_args()
    try:
        check_apk_jni(args.apk)
    except ApkJniError as error:
        parser.exit(1, f"APK JNI check failed: {error}\n")
    print("APK JNI class definitions preserved")


if __name__ == "__main__":
    main()
