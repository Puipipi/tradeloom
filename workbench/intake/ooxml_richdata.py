from __future__ import annotations

import posixpath
import zipfile
from dataclasses import dataclass
from xml.etree import ElementTree as ET

from .limits import MAX_IMAGE_REFERENCES


REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
RICH_NS = "http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"
RICH_REL_NS = "http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel"
SHEET_METADATA_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata"


class ImageReferenceLimitError(ValueError):
    pass


class ImageReferenceFormatError(ValueError):
    pass


def _append_reference(refs: list[ImageReference], reference: ImageReference) -> None:
    if len(refs) >= MAX_IMAGE_REFERENCES:
        raise ImageReferenceLimitError
    refs.append(reference)


@dataclass(frozen=True)
class ImageReference:
    kind: str
    sheet_part: str
    source_part: str
    coordinate: str = ""
    anchor: dict | None = None
    relationship_id: str = ""
    target_part: str = ""
    mime_type: str = ""
    rich_value_index: int | None = None
    relationship_slot: int | None = None
    warning_code: str = ""


def _xml(archive: zipfile.ZipFile, part: str) -> ET.Element | None:
    try:
        return ET.fromstring(archive.read(part))
    except KeyError:
        return None
    except ET.ParseError:
        return None


def _rels(archive: zipfile.ZipFile, source_part: str) -> dict[str, tuple[str, str, bool] | None]:
    directory, filename = posixpath.split(source_part)
    rel_part = posixpath.join(directory, "_rels", filename + ".rels")
    root = _xml(archive, rel_part)
    result = {}
    if root is None:
        return result
    for rel in root.findall(f"{{{REL_NS}}}Relationship"):
        rid = rel.get("Id", "")
        target = rel.get("Target", "")
        external = rel.get("TargetMode", "") == "External"
        resolved = target if target.startswith("/") else posixpath.normpath(posixpath.join(directory, target))
        resolved = resolved.lstrip("/")
        entry = (resolved, rel.get("Type", ""), external)
        if rid in result:
            result[rid] = None
        else:
            result[rid] = entry
    return result


def workbook_parts(archive: zipfile.ZipFile) -> tuple[list[tuple[str, str]], str | None]:
    workbook = _xml(archive, "xl/workbook.xml")
    rels = _rels(archive, "xl/workbook.xml")
    if workbook is None:
        return [], None
    sheets = []
    for sheet in workbook.findall(f".//{{{SHEET_NS}}}sheet"):
        rid = sheet.get(f"{{{DOC_REL_NS}}}id", "")
        entry = rels.get(rid)
        if entry and not entry[2]:
            sheets.append((sheet.get("name", ""), entry[0]))
    metadata_part = None
    for entry in rels.values():
        if entry is None:
            continue
        target, rel_type, external = entry
        if not external and rel_type == SHEET_METADATA_REL_TYPE:
            metadata_part = target
    return sheets, metadata_part


def _slot_mapping(archive: zipfile.ZipFile, metadata_part: str | None) -> tuple[dict[int, tuple[int | None, str]], list[str]]:
    warnings: list[str] = []
    if not metadata_part:
        return {}, warnings
    metadata = _xml(archive, metadata_part)
    if metadata is None:
        return {}, ["metadata_unreadable"]
    types = [node.get("name", "") for node in metadata.findall(f"{{{SHEET_NS}}}metadataTypes/{{{SHEET_NS}}}metadataType")]
    rich_type_indices = [index for index, name in enumerate(types) if name == "XLRICHVALUE"]
    if not rich_type_indices:
        return {}, ["richdata_type_unsupported"]
    if len(rich_type_indices) != 1:
        return {}, ["richdata_type_ambiguous"]
    rich_type_id = rich_type_indices[0] + 1
    future = metadata.find(f"{{{SHEET_NS}}}futureMetadata[@name='XLRICHVALUE']")
    values = metadata.find(f"{{{SHEET_NS}}}valueMetadata")
    if future is None or values is None:
        return {}, ["richdata_metadata_incomplete"]
    future_records = list(future.findall(f"{{{SHEET_NS}}}bk"))
    value_records = list(values.findall(f"{{{SHEET_NS}}}bk"))
    mapping: dict[int, tuple[int | None, str]] = {}
    for vm_index, book in enumerate(value_records, start=1):
        records = book.findall(f"{{{SHEET_NS}}}rc")
        matches = [
            record for record in records
            if record.get("t", "").isdigit() and int(record.get("t", "0")) == rich_type_id
        ]
        warning = ""
        rich_index: int | None = None
        if not matches:
            if any(
                not record.get("t", "").isdigit()
                or int(record.get("t", "0")) < 1
                or int(record.get("t", "0")) > len(types)
                for record in records
            ):
                warning = "richdata_metadata_type_invalid"
            else:
                warning = "richdata_metadata_type_unmapped"
        elif len(matches) != 1:
            warning = "richdata_metadata_type_ambiguous"
        else:
            future_index_text = matches[0].get("v", "")
            if not future_index_text.isdigit() or int(future_index_text) >= len(future_records):
                warning = "richdata_metadata_index_invalid"
            else:
                future_record = future_records[int(future_index_text)]
                rvb_nodes = future_record.findall(
                    f"./{{{SHEET_NS}}}extLst/{{{SHEET_NS}}}ext/{{{RICH_NS}}}rvb"
                )
                if not rvb_nodes:
                    warning = "richdata_rvb_missing"
                elif len(rvb_nodes) != 1:
                    warning = "richdata_rvb_ambiguous"
                else:
                    rich_index_text = rvb_nodes[0].get("i", "")
                    if not rich_index_text.isdigit():
                        warning = "richdata_rvb_index_invalid"
                    else:
                        rich_index = int(rich_index_text)
        if warning:
            warnings.append(warning)
        mapping[vm_index] = (rich_index, warning)
    return mapping, warnings


def read_richdata_images(archive: zipfile.ZipFile, sheet_parts: list[tuple[str, str]], metadata_part: str | None) -> tuple[list[ImageReference], list[str]]:
    refs: list[ImageReference] = []
    warnings: list[str] = []
    metadata_map, metadata_warnings = _slot_mapping(archive, metadata_part)
    warnings.extend(metadata_warnings)
    names = set(archive.namelist())
    rich_values = _xml(archive, "xl/richData/rdrichvalue.xml")
    structures = _xml(archive, "xl/richData/rdrichvaluestructure.xml")
    rich_rels = _xml(archive, "xl/richData/richValueRel.xml")
    rel_part = "xl/richData/_rels/richValueRel.xml.rels"
    rel_root = _xml(archive, rel_part)
    value_rows = rich_values.findall(f"{{{RICH_NS}}}rv") if rich_values is not None else []
    structure_rows = structures.findall(f"{{{RICH_NS}}}s") if structures is not None else []
    relationship_namespace_warning = ""
    has_richdata_signal = bool(metadata_map) or any(
        name.lower().startswith("xl/richdata/") for name in names
    )
    if rich_rels is None:
        if has_richdata_signal:
            relationship_namespace_warning = "richdata_relationship_part_missing"
        relationship_rows = []
    elif rich_rels.tag != f"{{{RICH_REL_NS}}}richValueRels":
        relationship_namespace_warning = "richdata_relationship_namespace_unsupported"
        relationship_rows = []
    elif any(node.tag != f"{{{RICH_REL_NS}}}rel" for node in list(rich_rels)):
        relationship_namespace_warning = "richdata_relationship_namespace_unsupported"
        relationship_rows = []
    else:
        relationship_rows = rich_rels.findall(f"{{{RICH_REL_NS}}}rel")
    if relationship_namespace_warning:
        warnings.append(relationship_namespace_warning)
    rel_by_id = {}
    if rel_root is not None:
        for relationship in rel_root.findall(f"{{{REL_NS}}}Relationship"):
            rid = relationship.get("Id", "")
            if rid in rel_by_id:
                rel_by_id[rid] = None
            else:
                rel_by_id[rid] = relationship

    for sheet_name, sheet_part in sheet_parts:
        root = _xml(archive, sheet_part)
        if root is None:
            warnings.append("worksheet_unreadable")
            continue
        for cell in root.findall(f".//{{{SHEET_NS}}}c"):
            vm_text = cell.get("vm")
            if not vm_text:
                continue
            cell_ref = cell.get("r", "")
            if not vm_text.isdigit() or int(vm_text) not in metadata_map:
                _append_reference(refs, ImageReference("rich_data", sheet_part, sheet_part, cell_ref, warning_code="richdata_vm_unmapped"))
                continue
            rich_index, mapping_warning = metadata_map[int(vm_text)]
            if rich_index is None:
                _append_reference(refs, ImageReference("rich_data", sheet_part, sheet_part, cell_ref, warning_code=mapping_warning or "richdata_vm_unmapped"))
                continue
            if rich_index >= len(value_rows):
                _append_reference(refs, ImageReference("rich_data", sheet_part, sheet_part, cell_ref, rich_value_index=rich_index, warning_code="richdata_value_missing"))
                continue
            value_row = value_rows[rich_index]
            structure_index = value_row.get("s", "")
            if not structure_index.isdigit() or int(structure_index) >= len(structure_rows):
                _append_reference(refs, ImageReference("rich_data", sheet_part, sheet_part, cell_ref, rich_value_index=rich_index, warning_code="richdata_structure_missing"))
                continue
            structure = structure_rows[int(structure_index)]
            struct_type = structure.get("t", "")
            if struct_type != "_localImage":
                _append_reference(refs, ImageReference(
                    "rich_data", sheet_part, "xl/richData/rdrichvalue.xml", cell_ref,
                    rich_value_index=rich_index, warning_code="richdata_structure_unsupported",
                ))
                continue
            slot: int | None = None
            warning = ""
            value_nodes = list(value_row)
            exact_keys = [
                (index, node) for index, node in enumerate(list(structure))
                if node.tag == f"{{{RICH_NS}}}k" and node.get("n") == "_rvRel:LocalImageIdentifier"
            ]
            if len(exact_keys) != 1:
                warning = "richdata_local_image_slot_missing"
            else:
                key_index, _ = exact_keys[0]
                if key_index >= len(value_nodes) or value_nodes[key_index].tag != f"{{{RICH_NS}}}v":
                    warning = "richdata_local_image_slot_missing"
                else:
                    slot_text = (value_nodes[key_index].text or "").strip()
                    if slot_text.isdigit():
                        slot = int(slot_text)
                    else:
                        warning = "richdata_slot_invalid"
            rid = ""
            target = ""
            mime = ""
            if relationship_namespace_warning:
                warning = relationship_namespace_warning
            elif not warning and slot is None:
                warning = "richdata_slot_invalid"
            elif not warning and (slot < 0 or slot >= len(relationship_rows)):
                warning = "richdata_slot_invalid"
            elif not warning:
                rid = relationship_rows[slot].get(f"{{{DOC_REL_NS}}}id", "")
                relationship = rel_by_id.get(rid)
                if relationship is None:
                    warning = "richdata_relationship_ambiguous" if rid in rel_by_id else "richdata_relationship_missing"
                elif relationship.get("TargetMode") == "External":
                    warning = "richdata_external_target"
                else:
                    raw_target = relationship.get("Target", "")
                    target = posixpath.normpath(raw_target.lstrip("/") if raw_target.startswith("/") else posixpath.join("xl/richData", raw_target))
                    if target.startswith("../") or target == ".." or "\\" in target:
                        warning = "richdata_media_missing"
                        target = ""
                    elif target not in names:
                        warning = "richdata_media_missing"
                    else:
                        mime = _mime_from_archive(archive, target)
                        if not mime:
                            warning = "richdata_media_type_unsupported"
            _append_reference(refs, ImageReference("rich_data", sheet_part, "xl/richData/rdrichvalue.xml", cell_ref, relationship_id=rid, target_part=target, mime_type=mime, rich_value_index=rich_index, relationship_slot=slot, warning_code=warning))

        sheet_relations = _rels(archive, sheet_part)
        for relation in sheet_relations.values():
            if relation is None:
                warnings.append("drawing_relationship_ambiguous")
                continue
            drawing_part, rel_type, external = relation
            if external or not rel_type.endswith("/drawing"):
                continue
            drawing = _xml(archive, drawing_part)
            if drawing is None:
                warnings.append("drawing_unreadable")
                continue
            drawing_rels = _rels(archive, drawing_part)
            for anchor_node in list(drawing):
                pic = next((node for node in anchor_node.iter() if node.tag.endswith("}pic")), None)
                if pic is None:
                    continue
                blip = next((node for node in pic.iter() if node.tag.endswith("}blip")), None)
                rid = blip.get(f"{{{DOC_REL_NS}}}embed", "") if blip is not None else ""
                rel = drawing_rels.get(rid)
                from_node = next((node for node in anchor_node if node.tag.endswith("}from")), None)
                anchor = {}
                coord = ""
                if from_node is not None:
                    try:
                        fields = {node.tag.rsplit("}", 1)[-1]: int(node.text or "0") for node in from_node}
                    except (TypeError, ValueError) as exc:
                        raise ImageReferenceFormatError from exc
                    if not (0 <= fields.get("col", -1) < 16_384 and 0 <= fields.get("row", -1) < 1_048_576):
                        raise ImageReferenceFormatError
                    anchor = fields
                    coord = _cell_coordinate(fields.get("col", 0), fields.get("row", 0))
                target = rel[0] if rel and not rel[2] else ""
                warning = "" if rel and not rel[2] and target in names else (
                    "drawing_relationship_ambiguous" if rid in drawing_rels and drawing_rels[rid] is None
                    else "drawing_external_target" if rel and rel[2]
                    else "drawing_relationship_missing"
                )
                mime = _mime_from_archive(archive, target) if target and not warning else ""
                if target and not warning and not mime:
                    warning = "drawing_media_type_unsupported"
                _append_reference(refs, ImageReference("drawing", sheet_part, drawing_part, coord, anchor, rid, target if not warning else "", mime, warning_code=warning))

    for name in names:
        if name.lower() in {"xl/cellimages.xml", "xl/cellimages.xml"}:
            warnings.append("cell_images_alternate_format_preserved")
    return refs, sorted(set(warnings))


def _cell_coordinate(column_zero: int, row_zero: int) -> str:
    from openpyxl.utils import get_column_letter

    return f"{get_column_letter(column_zero + 1)}{row_zero + 1}"


def _mime_from_archive(archive: zipfile.ZipFile, part: str) -> str:
    try:
        with archive.open(part) as media:
            header = media.read(16)
    except (KeyError, OSError, RuntimeError):
        return ""
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if header.startswith(b"BM"):
        return "image/bmp"
    return ""
