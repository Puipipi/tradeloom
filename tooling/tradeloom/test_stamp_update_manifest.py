import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from stamp_update_manifest import stamp


class StampManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name) / "update.json"
        self.digest = "a" * 64
        self.commit = "0123456789abcdef0123456789abcdef01234567"

    def manifest(self):
        return {
            "schema": 1,
            "version": "1.3.0+123",
            "tag": "v1.3.0",
            "page": None,
            "assets": {"arm64": {"name": "tradeloom-app-1.3.0-arm64.apk", "size": 17, "sha256": self.digest}},
        }

    def write(self, value):
        self.path.write_text(json.dumps(value), encoding="utf-8")

    def test_adds_commit_and_relative_version_path_without_changing_digest(self):
        self.write(self.manifest())
        result = stamp(self.path, self.commit)
        self.assertEqual(result["sourceCommit"], self.commit)
        self.assertEqual(result["title"], "TradeLoom 1.3.0")
        self.assertNotIn("page", result)
        self.assertEqual(result["assets"]["arm64"]["url"], "1.3.0/tradeloom-app-1.3.0-arm64.apk")
        self.assertEqual(result["assets"]["arm64"]["sha256"], self.digest)

    def test_rejects_unpinned_source_identity_and_delta_or_bad_asset(self):
        self.write(self.manifest())
        with self.assertRaisesRegex(ValueError, "Git SHA"):
            stamp(self.path, "not-a-sha")
        value = self.manifest(); value["patches"] = {"arm64": []}; self.write(value)
        with self.assertRaisesRegex(ValueError, "delta patches"):
            stamp(self.path, self.commit)
        value = self.manifest(); value["assets"]["arm64"]["name"] = "tradeloom-app-1.2.0-arm64.apk"; self.write(value)
        with self.assertRaisesRegex(ValueError, "asset name"):
            stamp(self.path, self.commit)


if __name__ == "__main__":
    unittest.main()
