from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from workbench.delivery import storage


class NativeArtifactStorageTests(TestCase):
    def test_sync_error_survives_failed_directory_cleanup(self):
        version_id = "41d8989b-c541-442b-bd21-c770b8aa0e24"
        write_error = OSError("injected fsync failure")
        cleanup_error = PermissionError("injected directory cleanup failure")
        with TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()
            with (
                patch.object(storage, "artifact_root", return_value=root),
                patch.object(storage.os, "fsync", side_effect=write_error),
                patch("shutil.rmtree", side_effect=cleanup_error) as remove_directory,
                self.assertRaises(OSError) as raised,
            ):
                storage.write_native_artifact(b"unpublished artifact", version_id)

            remove_directory.assert_called_once_with(root / "native" / version_id)
            self.assertIs(raised.exception, write_error)
            self.assertIn(str(cleanup_error), "\n".join(raised.exception.__notes__))
