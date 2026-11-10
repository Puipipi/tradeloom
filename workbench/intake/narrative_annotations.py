from __future__ import annotations

from datetime import date

from workbench.models import NarrativeAnnotationRevision


ANNOTATION_FIELDS = {"expected_revision", "source_kind", "recording_date", "audio_review_status"}
MAX_REVISION = 2_147_483_647


class AnnotationError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def canonical_payload(body: dict) -> dict:
    if set(body) != ANNOTATION_FIELDS:
        raise AnnotationError("invalid_arguments")
    expected = body["expected_revision"]
    if type(expected) is not int or not 0 <= expected <= MAX_REVISION:
        raise AnnotationError("invalid_revision")
    source_kind = body["source_kind"]
    if source_kind not in NarrativeAnnotationRevision.SourceKind.values:
        raise AnnotationError("invalid_arguments")
    audio_status = body["audio_review_status"]
    if audio_status not in NarrativeAnnotationRevision.AudioReviewStatus.values:
        raise AnnotationError("invalid_arguments")
    raw_date = body["recording_date"]
    if raw_date is None:
        recording_date = None
    elif isinstance(raw_date, str) and len(raw_date) == 10:
        try:
            recording_date = date.fromisoformat(raw_date)
        except ValueError:
            raise AnnotationError("invalid_arguments") from None
        if recording_date.isoformat() != raw_date:
            raise AnnotationError("invalid_arguments")
    else:
        raise AnnotationError("invalid_arguments")
    return {
        "expected_revision": expected,
        "source_kind": source_kind,
        "recording_date": recording_date,
        "audio_review_status": audio_status,
    }


def serialize_revision(row: NarrativeAnnotationRevision) -> dict:
    return {
        "id": row.pk,
        "source_id": row.source_id,
        "revision": row.revision,
        "source_kind": row.source_kind,
        "recording_date": row.recording_date.isoformat() if row.recording_date else None,
        "audio_review_status": row.audio_review_status,
        "content_status": NarrativeAnnotationRevision.ContentStatus.UNCONFIRMED,
        "actor": row.actor,
        "created_at": row.created_at.isoformat(),
    }


def current_for_source(source_id: str) -> dict | None:
    row = NarrativeAnnotationRevision.objects.filter(source_id=source_id).order_by("-revision").first()
    return serialize_revision(row) if row else None


def current_for_sources(source_ids: list[str]) -> dict[str, dict]:
    if not source_ids:
        return {}
    # PostgreSQL DISTINCT ON returns one latest immutable revision per source in one query.
    rows = NarrativeAnnotationRevision.objects.filter(source_id__in=source_ids).order_by(
        "source_id", "-revision"
    ).distinct("source_id")
    return {row.source_id: serialize_revision(row) for row in rows}


def history_page(source_id: str, offset: int, limit: int) -> tuple[list[dict], int | None, dict | None]:
    rows = list(NarrativeAnnotationRevision.objects.filter(source_id=source_id).order_by("revision")[offset:offset + limit + 1])
    page = rows[:limit]
    current_row = NarrativeAnnotationRevision.objects.filter(source_id=source_id).order_by("-revision").first()
    current = serialize_revision(current_row) if current_row else None
    next_offset = offset + limit if len(rows) > limit else None
    return [serialize_revision(row) for row in page], next_offset, current
