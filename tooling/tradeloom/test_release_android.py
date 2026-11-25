import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urljoin

from release_android import (candidate_commits, find_aapt2, package_release, preserve_previous_apks,
                             validate_feed, validate_versions)
from release_assets import ReleaseError


class ReleaseRules(unittest.TestCase):
    def test_bad_feeds(self):
        for feed in ("http://updates.example.com/update.json",
                     "https://127.0.0.1:18443/update.json",
                     "https://[::1]/update.json",
                     "https://user@updates.example.com/update.json",
                     "https://updates.example.com/update.json?token=fixture",
                     "https://updates.example.com/%2e%2e/update.json",
                     "https://updates.example.com/update.json#fragment"):
            with self.subTest(feed=feed), self.assertRaises(ValueError):
                validate_feed(feed)

    def test_prior_build_outputs_are_retained_before_build(self):
        with tempfile.TemporaryDirectory() as scratch:
            apk_dir = Path(scratch)
            first = apk_dir / "app-arm64-release.apk"
            second = apk_dir / "tradeloom-app-x64-release.apk"
            unrelated = apk_dir / "app-debug.apk"
            for path in (first, second, unrelated):
                path.write_bytes(path.name.encode())
            preserve_previous_apks(apk_dir)
            self.assertFalse(first.exists())
            self.assertFalse(second.exists())
            self.assertTrue(unrelated.exists())
            retained, = apk_dir.glob("previous-official-apks-*")
            self.assertEqual((retained / first.name).read_bytes(), first.name.encode())
            self.assertEqual((retained / second.name).read_bytes(), second.name.encode())

    def test_release_version_must_advance_like_the_client(self):
        validate_versions("1.3.0+11251201", "1.3.0+11251200")
        validate_versions("1.4.0-rc.12+12", "1.4.0-rc.2+11")
        for previous in ("1.3.0+11251201", "1.2.0+11251202", "1.4.0+11251200"):
            with self.subTest(previous=previous), self.assertRaises(ValueError):
                validate_versions("1.3.0+11251201", previous)


@unittest.skipUnless(os.environ.get("TRADELOOM_RELEASE_TEST_APKS"), "provide the existing signed QA APK fixture directory")
class ActualApkRelease(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(os.environ["TRADELOOM_RELEASE_TEST_APKS"]).resolve()
        cls.apks = {flavor: root / f"tradeloom-mobile-1.3.0-11251201-{flavor}.apk"
                    for flavor in ("arm64", "x64")}
        cls.older_x64 = root / "tradeloom-mobile-1.3.0-11251200-x64.apk"
        cls.aapt2 = find_aapt2()
        cls.apksigner = str(Path(cls.aapt2).with_name("apksigner.bat" if os.name == "nt" else "apksigner"))
        cls.head, cls.upstream = candidate_commits()

    def setUp(self):
        scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TRADELOOM_RELEASE_TEST_TMP"))
        self.addCleanup(scratch.cleanup)
        self.out = Path(scratch.name) / "bundle"
        self.args = dict(
            version="1.3.0+11251201", previous_version="1.3.0+11251200",
            feed="https://updates.example.com/tradeloom/update.json",
            fingerprint="7645b8002c00cfa20c983bef87a988840c820cd134f3f8a17c21833bb62e41f0",
            head=self.head, upstream=self.upstream, aapt2=self.aapt2, apksigner=self.apksigner,
        )

    def test_real_dual_abi_bundle(self):
        package_release(self.apks, self.out, **self.args)
        manifest = json.loads((self.out / "update.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["sourceCommit"], self.upstream)
        self.assertEqual(manifest["version"], self.args["version"])
        self.assertEqual(set(manifest["assets"]), set(self.apks))
        for flavor, asset in manifest["assets"].items():
            self.assertEqual(asset["url"], self.args["version"] + "/" + asset["name"])
            self.assertEqual(
                urljoin(self.args["feed"], asset["url"]),
                "https://updates.example.com/tradeloom/" + asset["url"],
            )
            path = self.out / asset["url"]
            with path.open("rb") as body:
                self.assertEqual(hashlib.file_digest(body, "sha256").hexdigest(), asset["sha256"])
            self.assertEqual(path.stat().st_size, asset["size"])
        proof = json.loads((self.out / "release-provenance.json").read_text(encoding="utf-8"))
        self.assertEqual(proof["feed"], self.args["feed"])
        self.assertEqual(proof["candidateCommit"], self.head)

    def test_missing_abi_is_rejected_without_feed(self):
        with self.assertRaisesRegex(ValueError, "both arm64 and x64"):
            package_release({"arm64": self.apks["arm64"]}, self.out, **self.args)
        self.assertFalse(self.out.exists())

    def test_mixed_builds_are_rejected_without_feed(self):
        with self.assertRaisesRegex(ReleaseError, "different build numbers"):
            package_release(self.apks | {"x64": self.older_x64}, self.out, **self.args)
        self.assertFalse(self.out.exists())

    def test_wrong_abi_is_rejected_without_feed(self):
        with self.assertRaises(subprocess.CalledProcessError):
            package_release(self.apks | {"arm64": self.apks["x64"]}, self.out, **self.args)
        self.assertFalse(self.out.exists())
    def test_wrong_signer_is_rejected_without_feed(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            package_release(self.apks, self.out, **(self.args | {"fingerprint": "0" * 64}))
        self.assertFalse(self.out.exists())

    def test_invalid_feed_is_rejected_without_output(self):
        with self.assertRaises(ValueError):
            package_release(self.apks, self.out, **(self.args | {"feed": "https://127.0.0.1/update.json"}))
        self.assertFalse(self.out.exists())

    def test_existing_release_preserved(self):
        self.out.mkdir()
        manifest = self.out / "update.json"
        manifest.write_bytes(b"prior release")
        with self.assertRaisesRegex(ValueError, "new release output directory"):
            package_release(self.apks, self.out, **self.args)
        self.assertEqual(manifest.read_bytes(), b"prior release")
