from __future__ import annotations

import json
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory

from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TransactionTestCase, override_settings

from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT
from workbench.models import NarrativeAnnotationRevision, NarrativeSourceVersion


class NarrativeAnnotationApiTests(TransactionTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.data_root = Path(self.temp.name) / "data"
        self.intake_root = self.data_root / "private" / "intake"
        self.intake_root.mkdir(parents=True)
        (self.intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        self.settings_override = override_settings(
            TRADELOOM_DATA_ROOT=self.data_root,
            TRADELOOM_INTAKE_ROOT=self.intake_root,
        )
        self.settings_override.enable()
        self.client = Client()
        upload = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("synth.txt", "synthetic line\nsecond synthetic line\n".encode("utf-8"), "text/plain")},
            HTTP_IDEMPOTENCY_KEY=f"annotations-upload-{uuid.uuid4().hex}",
        )
        self.assertEqual(upload.status_code, 201, upload.content)
        self.source = NarrativeSourceVersion.objects.get(pk=upload.json()["narrative"]["id"])
        self.endpoint = f"/api/intake/narratives/{self.source.pk}/annotations"

    def tearDown(self):
        self.settings_override.disable()
        self.temp.cleanup()

    def create_revision(self, *, key=None, expected=0, kind="transcript_excerpt", date="2026-10-20", audio="unknown"):
        body = {"expected_revision": expected, "source_kind": kind, "recording_date": date,
                "audio_review_status": audio}
        return self.client.post(self.endpoint, data=json.dumps(body), content_type="application/json",
                                HTTP_IDEMPOTENCY_KEY=key or f"annotation-{uuid.uuid4().hex}")

    def test_narrative_upload_remains_file_only_and_annotations_keep_version_history(self):
        invalid_upload = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("bad.txt", b"synth", "text/plain"), "source_kind": "transcript_excerpt"},
            HTTP_IDEMPOTENCY_KEY="annotation-file-only-compat",
        )
        self.assertEqual(invalid_upload.status_code, 422)

        first = self.create_revision(key="annotation-history-1", audio="operator_claimed_checked")
        self.assertEqual(first.status_code, 201, first.content)
        self.assertEqual(first.json()["current"]["revision"], 1)
        self.assertEqual(first.json()["current"]["content_status"], "unconfirmed")
        self.assertEqual(first.json()["current"]["audio_review_status"], "operator_claimed_checked")
        second = self.create_revision(key="annotation-history-2", expected=1, kind="secondary_summary_analysis", date=None)
        self.assertEqual(second.status_code, 201, second.content)
        history = self.client.get(self.endpoint).json()
        self.assertEqual([row["revision"] for row in history["history"]], [1, 2])
        self.assertEqual(history["history"][0]["source_kind"], "transcript_excerpt")
        self.assertIsNone(history["history"][1]["recording_date"])
        self.assertEqual({row["source_id"] for row in history["history"]}, {self.source.pk})
        self.assertNotIn("synthetic line", json.dumps(history))
        self.assertEqual(NarrativeAnnotationRevision.objects.filter(source=self.source).count(), 2)
        same_blob = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("renamed-synth.txt", "synthetic line\nsecond synthetic line\n".encode("utf-8"), "text/plain")},
            HTTP_IDEMPOTENCY_KEY="annotation-reupload-same-blob",
        )
        self.assertEqual(same_blob.status_code, 200, same_blob.content)
        self.assertEqual(same_blob.json()["narrative"]["id"], self.source.pk)
        self.assertEqual(same_blob.json()["narrative"]["sha256"], self.source.sha256)
        self.assertEqual(same_blob.json()["narrative"]["line_count"], self.source.line_count)
        self.assertEqual(NarrativeAnnotationRevision.objects.filter(source=self.source).count(), 2)

    def test_annotation_idempotency_stale_revision_and_validation(self):
        first = self.create_revision(key="annotation-idempotent", date=None)
        self.assertEqual(first.status_code, 201, first.content)
        replay = self.create_revision(key="annotation-idempotent", date=None)
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["current"]["id"], first.json()["current"]["id"])
        advanced = self.create_revision(key="annotation-advance", expected=1, kind="user_supplement", date=None)
        self.assertEqual(advanced.status_code, 201, advanced.content)
        replay_after_advance = self.create_revision(key="annotation-idempotent", date=None)
        self.assertEqual(replay_after_advance.status_code, 200)
        self.assertEqual(replay_after_advance.json()["annotation"]["id"], first.json()["annotation"]["id"])
        self.assertEqual(replay_after_advance.json()["current"]["revision"], 2)
        changed = self.create_revision(key="annotation-idempotent", kind="user_supplement", date=None)
        self.assertEqual(changed.status_code, 409)
        changed_expected = self.create_revision(key="annotation-idempotent", expected=1, date=None)
        self.assertEqual(changed_expected.status_code, 409)
        foreign_upload = self.client.post(
            "/api/intake/narratives",
            {"file": SimpleUploadedFile("foreign-synth.txt", b"different synthetic source\n", "text/plain")},
            HTTP_IDEMPOTENCY_KEY="annotation-foreign-source-upload",
        )
        self.assertEqual(foreign_upload.status_code, 201, foreign_upload.content)
        foreign_endpoint = f"/api/intake/narratives/{foreign_upload.json()['narrative']['id']}/annotations"
        foreign_replay = self.client.post(
            foreign_endpoint,
            data=json.dumps({"expected_revision": 0, "source_kind": "transcript_excerpt", "recording_date": None,
                             "audio_review_status": "unknown"}),
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="annotation-idempotent",
        )
        self.assertEqual(foreign_replay.status_code, 409)
        self.assertFalse(NarrativeAnnotationRevision.objects.filter(source_id=foreign_upload.json()["narrative"]["id"]).exists())
        stale = self.create_revision(key="annotation-stale", expected=0, date=None)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(NarrativeAnnotationRevision.objects.filter(source=self.source).count(), 2)

        for body in (
            {"expected_revision": 1, "source_kind": "recording", "recording_date": None, "audio_review_status": "unknown"},
            {"expected_revision": 1, "source_kind": "unknown", "recording_date": "2026-02-30", "audio_review_status": "unknown"},
            {"expected_revision": True, "source_kind": "unknown", "recording_date": None, "audio_review_status": "unknown"},
            {"expected_revision": 1, "source_kind": "unknown", "recording_date": None, "audio_review_status": "unknown", "content_status": "confirmed"},
            {"expected_revision": 1, "source_kind": "unknown", "recording_date": None, "audio_review_status": "unknown", "actor": "operator"},
        ):
            response = self.client.post(self.endpoint, data=json.dumps(body), content_type="application/json",
                                        HTTP_IDEMPOTENCY_KEY=f"annotation-invalid-{uuid.uuid4().hex}")
            self.assertEqual(response.status_code, 422, (body, response.content))
        response = self.client.post(self.endpoint, data="[]", content_type="application/json",
                                    HTTP_IDEMPOTENCY_KEY="annotation-invalid-json")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(NarrativeAnnotationRevision.objects.filter(source=self.source).count(), 2)

    def test_annotation_get_pagination_csrf_and_immutable_source(self):
        for i, kind in enumerate(("unknown", "transcript_excerpt", "user_supplement")):
            response = self.create_revision(key=f"annotation-pages-{i}", expected=i, kind=kind, date=None)
            self.assertEqual(response.status_code, 201, response.content)
        first = self.client.get(f"{self.endpoint}?limit=2")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual([row["revision"] for row in first.json()["history"]], [1, 2])
        self.assertEqual(first.json()["next_offset"], 2)
        second = self.client.get(f"{self.endpoint}?offset=2&limit=2")
        self.assertEqual([row["revision"] for row in second.json()["history"]], [3])
        self.assertEqual(second.json()["current"]["revision"], 3)

        other = NarrativeSourceVersion.objects.create(sha256="f" * 64, storage_key="narrative-foreign.txt",
            display_name="foreign.txt", byte_size=0, line_count=0)
        self.assertEqual(self.client.get(f"/api/intake/narratives/{other.pk}/annotations").status_code, 200)
        self.assertEqual(self.client.get(f"/api/intake/narratives/{'0' * 32}/annotations").status_code, 404)
        self.assertEqual(self.client.get(f"{self.endpoint}?limit=1&limit=2").status_code, 422)
        csrf_client = Client(enforce_csrf_checks=True)
        self.assertEqual(csrf_client.post(self.endpoint, data="{}", content_type="application/json").status_code, 403)

        revision = NarrativeAnnotationRevision.objects.filter(source=self.source).first()
        revision.recording_date = None
        with self.assertRaises(ValidationError):
            revision.save()
        with self.assertRaises(ValidationError):
            revision.delete()
        listed = next(row for row in self.client.get("/api/intake/narratives").json()["narratives"] if row["id"] == self.source.pk)
        self.assertEqual(listed["current_annotation"]["revision"], 3)
        line_source = self.client.get(f"/api/intake/narratives/{self.source.pk}/lines").json()["source"]
        self.assertEqual(line_source["sha256"], self.source.sha256)
        self.assertEqual(line_source["current_annotation"]["revision"], 3)
