from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction

from workbench.models import (
    SourceCellSnapshot,
    WorkbookImageReference,
    WorkbookSheetSnapshot,
    WorkbookSnapshot,
)

from .parser import PARSER_VERSION, parse_workbook
from .storage import open_source


def capture_snapshot(source):
    existing = WorkbookSnapshot.objects.filter(source=source, parser_version=PARSER_VERSION).first()
    if existing is not None:
        return existing, False
    try:
        with open_source(source.pk) as content:
            evidence = parse_workbook(content)
    except ValidationError:
        try:
            with transaction.atomic():
                failed = WorkbookSnapshot.objects.create(
                    source=source,
                    parser_version=PARSER_VERSION,
                    status="failed",
                    error_code="workbook_parse_failed",
                )
            return failed, True
        except IntegrityError:
            existing = WorkbookSnapshot.objects.filter(source=source, parser_version=PARSER_VERSION).first()
            if existing is not None:
                return existing, False
            raise

    try:
        with transaction.atomic():
            snapshot = WorkbookSnapshot.objects.create(
                source=source,
                parser_version=evidence.parser_version,
                status="ready",
                warnings=list(evidence.warnings),
                sheet_count=len(evidence.sheets),
                cell_count=evidence.cell_count,
            )
            sheet_map = {}
            for sheet in evidence.sheets:
                saved_sheet = WorkbookSheetSnapshot.objects.create(
                    snapshot=snapshot,
                    sheet_index=sheet.sheet_index,
                    title=sheet.title,
                    source_part=sheet.source_part,
                    dimensions=sheet.dimensions,
                    merged_ranges=list(sheet.merged_ranges),
                    warnings=list(sheet.warnings),
                )
                sheet_map[sheet.sheet_index] = saved_sheet
                SourceCellSnapshot.objects.bulk_create([
                    SourceCellSnapshot(
                        sheet=saved_sheet,
                        coordinate=cell.coordinate,
                        source_type=cell.source_type,
                        raw_value=cell.raw_value,
                        normalized_value=cell.normalized_value,
                        formula=cell.formula,
                        cached_value=cell.cached_value,
                        number_format=cell.number_format,
                        formula_status=cell.formula_status,
                        error_code=cell.error_code,
                    )
                    for cell in sheet.cells
                ])
            image_references = [
                WorkbookImageReference(
                    snapshot=snapshot,
                    sheet=sheet_map.get(next((sheet.sheet_index for sheet in evidence.sheets if sheet.source_part == image["sheet_part"]), 0)),
                    kind=image["kind"],
                    coordinate=image["coordinate"],
                    anchor=image["anchor"],
                    source_part=image["source_part"],
                    relationship_id=image["relationship_id"],
                    target_part=image["target_part"],
                    mime_type=image["mime_type"],
                    rich_value_index=image["rich_value_index"],
                    relationship_slot=image["relationship_slot"],
                    warning_code=image["warning_code"],
                )
                for image in evidence.images
            ]
            for image_reference in image_references:
                image_reference._validate_snapshot_relation()
            WorkbookImageReference.objects.bulk_create(image_references)
        return snapshot, True
    except IntegrityError:
        existing = WorkbookSnapshot.objects.filter(source=source, parser_version=PARSER_VERSION).first()
        if existing is not None:
            return existing, False
        raise
