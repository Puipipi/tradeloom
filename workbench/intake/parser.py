from __future__ import annotations

import json
import posixpath
import zipfile
from dataclasses import asdict, dataclass
from datetime import date, datetime, time
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

from django.core.exceptions import ValidationError
from openpyxl import load_workbook
from openpyxl.utils.cell import coordinate_to_tuple, range_boundaries

from .limits import (
    MAX_CELLS,
    MAX_IMAGE_REFERENCES,
    MAX_MERGED_AREA,
    MAX_SHEETS,
    MAX_SOURCE_BYTES,
    MAX_UNCOMPRESSED_BYTES,
    MAX_ZIP_PARTS,
)
from .ooxml_richdata import ImageReferenceFormatError, ImageReferenceLimitError, SHEET_NS, workbook_parts, read_richdata_images

PARSER_VERSION = "intake-xlsx-1"
@dataclass(frozen=True)
class CellEvidence:
    coordinate: str
    source_type: str
    raw_value: dict
    normalized_value: object
    formula: str
    cached_value: object
    number_format: str
    formula_status: str
    error_code: str = ""


@dataclass(frozen=True)
class SheetEvidence:
    sheet_index: int
    title: str
    source_part: str
    dimensions: str
    merged_ranges: tuple[str, ...]
    cells: tuple[CellEvidence, ...]
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class WorkbookEvidence:
    parser_version: str
    sheets: tuple[SheetEvidence, ...]
    images: tuple[dict, ...]
    warnings: tuple[str, ...]
    cell_count: int


def _read_bytes(source) -> bytes:
    if isinstance(source, (str, Path)):
        path = Path(source)
        if path.stat().st_size > MAX_SOURCE_BYTES:
            raise ValidationError("工作簿超过解析大小限制。")
        return path.read_bytes()
    position = source.tell() if hasattr(source, "tell") else None
    data = source.read(MAX_SOURCE_BYTES + 1)
    if position is not None and hasattr(source, "seek"):
        source.seek(position)
    if len(data) > MAX_SOURCE_BYTES:
        raise ValidationError("工作簿超过解析大小限制。")
    return data


def _json_value(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date, time)):
        return {"type": value.__class__.__name__.lower(), "iso": value.isoformat()}
    return {"type": "unsupported", "python_type": type(value).__name__}


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    except ET.ParseError as exc:
        raise ValidationError("工作簿共享字符串部件损坏。") from exc
    return ["".join(t.text or "" for t in si.findall(f".//{{{SHEET_NS}}}t")) for si in root.findall(f"{{{SHEET_NS}}}si")]


def _raw_cells(archive: zipfile.ZipFile, part: str, shared: list[str]):
    try:
        root = ET.fromstring(archive.read(part))
    except (KeyError, ET.ParseError) as exc:
        raise ValidationError("工作表 XML 部件损坏。") from exc
    cells = {}
    nonempty_count = 0
    for cell in root.findall(f".//{{{SHEET_NS}}}c"):
        coordinate = cell.get("r", "")
        try:
            row_number, column_number = coordinate_to_tuple(coordinate)
        except (TypeError, ValueError) as exc:
            raise ValidationError("工作簿单元格坐标无效。") from exc
        if not (1 <= row_number <= 1_048_576 and 1 <= column_number <= 16_384):
            raise ValidationError("工作簿单元格坐标无效。")
        source_type = cell.get("t", "")
        value_node = cell.find(f"{{{SHEET_NS}}}v")
        formula_node = cell.find(f"{{{SHEET_NS}}}f")
        inline_node = cell.find(f"{{{SHEET_NS}}}is")
        lexeme = value_node.text if value_node is not None else None
        inline_text = "".join(node.text or "" for node in inline_node.findall(f".//{{{SHEET_NS}}}t")) if inline_node is not None else None
        shared_text = None
        if source_type == "s" and lexeme is not None:
            try:
                shared_text = shared[int(lexeme)]
            except (ValueError, IndexError):
                shared_text = None
        formula_text = formula_node.text if formula_node is not None else None
        formula = formula_text or ""
        if lexeme is not None or inline_node is not None or formula_node is not None:
            nonempty_count += 1
        if len(cells) >= MAX_CELLS:
            raise ValidationError("工作簿单元格记录数量超出支持范围。")
        cells[coordinate] = {
            "source_type": source_type,
            "raw_value": {
                "xml_type": source_type,
                "v_lexeme": lexeme,
                "shared_string": shared_text,
                "inline_string": inline_text,
                "vm": cell.get("vm"),
                "cm": cell.get("cm"),
                "formula_attrs": dict(formula_node.attrib) if formula_node is not None else {},
                "formula_present": formula_node is not None,
                "formula_text": formula_text,
            },
            "formula": formula,
            "formula_present": formula_node is not None,
            "formula_attrs": dict(formula_node.attrib) if formula_node is not None else {},
            "cache_state": "missing" if value_node is None else ("empty" if value_node.text is None else "present"),
        }
    merges = root.findall(f".//{{{SHEET_NS}}}mergeCell")
    merged = tuple(node.get("ref", "") for node in merges if node.get("ref"))
    return cells, merged, nonempty_count


def _validate_archive(data: bytes) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(BytesIO(data))
        entries = archive.infolist()
        if len(entries) > MAX_ZIP_PARTS or sum(item.file_size for item in entries) > MAX_UNCOMPRESSED_BYTES:
            raise ValidationError("工作簿超出解析资源限制。")
        names = {item.filename for item in entries}
        if len(names) != len(entries):
            raise ValidationError("工作簿包含重复部件。")
        if not {"[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"}.issubset(names):
            raise ValidationError("文件不是受支持的 XLSX 工作簿。")
        if any(item.filename.lower().endswith("vbaproject.bin") for item in entries):
            raise ValidationError("含宏的工作簿不能解析。")
        for entry in entries:
            part = Path(entry.filename)
            if part.is_absolute() or ".." in part.parts or "\\" in entry.filename:
                raise ValidationError("工作簿部件路径无效。")
        if archive.testzip() is not None:
            raise ValidationError("工作簿压缩内容损坏。")
        return archive
    except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
        raise ValidationError("文件不是有效的 XLSX 工作簿。") from exc


def _validate_merged_area(archive: zipfile.ZipFile, parts: list[tuple[str, str]]) -> None:
    total_area = 0
    for _, part in parts:
        try:
            root = ET.fromstring(archive.read(part))
        except (KeyError, ET.ParseError) as exc:
            raise ValidationError("工作表 XML 部件损坏。") from exc
        for node in root.findall(f".//{{{SHEET_NS}}}mergeCell"):
            reference = node.get("ref", "")
            try:
                min_col, min_row, max_col, max_row = range_boundaries(reference)
                if None in (min_col, min_row, max_col, max_row):
                    raise ValueError
            except ValueError as exc:
                raise ValidationError("工作簿合并区域无效。") from exc
            total_area += (max_col - min_col + 1) * (max_row - min_row + 1)
            if total_area > MAX_MERGED_AREA:
                raise ValidationError("工作簿合并区域超出解析资源限制。")


def parse_workbook(source) -> WorkbookEvidence:
    data = _read_bytes(source)
    archive = _validate_archive(data)
    try:
        parts, metadata_part = workbook_parts(archive)
        if not parts or len(parts) > MAX_SHEETS:
            raise ValidationError("工作簿工作表数量超出支持范围。")
        _validate_merged_area(archive, parts)
        shared = _shared_strings(archive)
        raw_by_part = {}
        total_cells = 0
        for _, part in parts:
            raw = _raw_cells(archive, part, shared)
            raw_by_part[part] = raw
            total_cells += raw[2]
            if total_cells > MAX_CELLS:
                raise ValidationError("工作簿非空单元格数量超出支持范围。")
        try:
            image_refs, image_warnings = read_richdata_images(archive, parts, metadata_part)
        except ImageReferenceLimitError as exc:
            raise ValidationError("工作簿图片引用数量超出支持范围。") from exc
        except ImageReferenceFormatError as exc:
            raise ValidationError("工作簿图片定位信息无效。") from exc
        if len(image_refs) > MAX_IMAGE_REFERENCES:
            raise ValidationError("工作簿图片引用数量超出支持范围。")
        try:
            formulas_wb = load_workbook(BytesIO(data), data_only=False, read_only=False, keep_links=False)
            values_wb = load_workbook(BytesIO(data), data_only=True, read_only=False, keep_links=False)
        except Exception as exc:
            raise ValidationError("工作簿无法安全解析。") from exc

        sheets = []
        for index, (title, part) in enumerate(parts, start=1):
            if title not in formulas_wb.sheetnames or title not in values_wb.sheetnames:
                raise ValidationError("工作簿工作表目录与内容不一致。")
            formula_ws = formulas_wb[title]
            value_ws = values_wb[title]
            raw_cells, merged, _ = raw_by_part[part]
            evidence = []
            sheet_warnings = []
            for coordinate, raw in raw_cells.items():
                normalized_cell = formula_ws[coordinate]
                cached_cell = value_ws[coordinate]
                formula = raw["formula"]
                formula_present = raw["formula_present"]
                normalized = _json_value(cached_cell.value if formula_present else normalized_cell.value)
                if formula_present:
                    cache_state = raw["cache_state"]
                    cached = {"state": cache_state}
                    if cache_state == "present":
                        cached["value"] = _json_value(cached_cell.value)
                        cached["lexeme"] = raw["raw_value"]["v_lexeme"]
                else:
                    cached = None
                formula_status = "not_formula"
                error = ""
                if formula_present:
                    formula_status = "unsupported"
                    normalized_formula = normalized_cell.value
                    if isinstance(normalized_formula, str) and normalized_formula.startswith("="):
                        normalized = _json_value(cached_cell.value)
                    if raw["source_type"] == "e" or cached_cell.data_type == "e":
                        error = "cached_formula_error"
                raw_value = dict(raw["raw_value"])
                if formula_present:
                    raw_value["normalized_formula"] = _json_value(normalized_cell.value)
                evidence.append(CellEvidence(
                    coordinate=coordinate,
                    source_type=raw["source_type"],
                    raw_value=raw_value,
                    normalized_value=normalized,
                    formula=formula,
                    cached_value=cached,
                    number_format=normalized_cell.number_format or "",
                    formula_status=formula_status,
                    error_code=error,
                ))
            images = getattr(formula_ws, "_images", [])
            if images:
                sheet_warnings.append("floating_drawing_images_read_from_ooxml")
            sheets.append(SheetEvidence(index, title, part, formula_ws.calculate_dimension(), merged, tuple(evidence), tuple(sheet_warnings)))

        image_dicts = tuple(asdict(ref) for ref in image_refs)
        warnings = tuple(sorted(set(image_warnings + [ref.warning_code for ref in image_refs if ref.warning_code])))
        return WorkbookEvidence(PARSER_VERSION, tuple(sheets), image_dicts, warnings, total_cells)
    finally:
        archive.close()
