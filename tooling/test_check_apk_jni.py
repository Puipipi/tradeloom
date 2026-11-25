"""Exercise actual DEX class-definition tables; no SDK, APK build or network."""

from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

from check_apk_jni import ApkJniError, REQUIRED_CLASSES, check_apk_jni, dex_classes


def dex_fixture(defined, referenced=()):
    """Minimal DEX index-table fixture; references alone must never satisfy a definition."""
    names = sorted(set(defined) | set(referenced))
    string_ids = 112
    type_ids = string_ids + 4 * len(names)
    class_defs = type_ids + 4 * len(names)
    data = bytearray(class_defs + 32 * len(defined))
    data[:8] = b"dex\n039\x00"
    struct.pack_into("<II", data, 36, 112, 0x12345678)
    struct.pack_into("<II", data, 56, len(names), string_ids)
    struct.pack_into("<II", data, 64, len(names), type_ids)
    struct.pack_into("<II", data, 96, len(defined), class_defs)
    for i, name in enumerate(names):
        struct.pack_into("<I", data, string_ids + i * 4, len(data))
        struct.pack_into("<I", data, type_ids + i * 4, i)
        data.extend(bytes([len(name)]) + name.encode("ascii") + b"\x00")
    for i, name in enumerate(sorted(defined)):
        struct.pack_into("<I", data, class_defs + i * 32, names.index(name))
    struct.pack_into("<I", data, 32, len(data))
    return bytes(data)


class ApkJniTest(unittest.TestCase):
    def check(self, entries):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.apk"
            with zipfile.ZipFile(path, "w") as apk:
                for name, data in entries.items():
                    apk.writestr(name, data)
            check_apk_jni(path)

    def test_required_class_definitions_pass(self):
        self.check({"classes.dex": dex_fixture(REQUIRED_CLASSES)})

    def test_descriptor_strings_and_type_references_do_not_count_as_definitions(self):
        with self.assertRaisesRegex(ApkJniError, "OrtException"):
            self.check({"classes.dex": dex_fixture(set(), REQUIRED_CLASSES)})

    def test_renamed_exception_class_fails(self):
        defined = REQUIRED_CLASSES - {"Lai/onnxruntime/OrtException;"} | {"La/b;"}
        with self.assertRaisesRegex(ApkJniError, "OrtException"):
            self.check({"classes.dex": dex_fixture(defined)})

    def test_class_definitions_across_secondary_dex_files_pass(self):
        for name in ("classes2.dex", "classes10.dex"):
            with self.subTest(name=name):
                self.check({"classes.dex": dex_fixture(set()), name: dex_fixture(REQUIRED_CLASSES)})

    def test_no_dex_and_invalid_dex_fail_instead_of_skipping(self):
        for entries in ({}, {"classes.dex": b"not a DEX"}):
            with self.subTest(entries=entries), self.assertRaises(ApkJniError):
                self.check(entries)

    def test_out_of_bounds_tables_and_class_indices_fail(self):
        original = dex_fixture(REQUIRED_CLASSES)
        for offset, value in ((100, len(original)), (struct.unpack_from("<I", original, 100)[0], 0xFFFFFFFF)):
            data = bytearray(original)
            struct.pack_into("<I", data, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ApkJniError):
                dex_classes(bytes(data))


if __name__ == "__main__":
    unittest.main()
