from __future__ import annotations

import zipfile
from io import BytesIO
from unittest.mock import patch
from xml.etree import ElementTree as ET

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase
from openpyxl import Workbook
from openpyxl.drawing.image import Image as WorksheetImage
from PIL import Image

from workbench.intake.parser import parse_workbook
from workbench.intake.ooxml_richdata import _rels

SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
RICH_NS = "http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"
RICH_REL_NS = "http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel"


def _synthetic_png() -> bytes:
    image = Image.new("RGB", (2, 2), (12, 34, 56))
    output = BytesIO()
    image.save(output, format="PNG")
    image.close()
    return output.getvalue()


def _synthetic_jpeg() -> bytes:
    image = Image.new("RGB", (2, 2), (56, 34, 12))
    output = BytesIO()
    image.save(output, format="JPEG")
    image.close()
    return output.getvalue()


def _base_workbook(with_floating=True) -> bytes:
    book = Workbook()
    sheet = book.active
    sheet.title = "Synthetic"
    sheet["A1"] = 45292
    sheet["A1"].number_format = "yyyy-mm-dd"
    sheet["B2"] = "cached text"
    sheet["C3"] = "=1+2"
    sheet["D4"] = "#VALUE!"
    if with_floating:
        sheet.add_image(WorksheetImage(BytesIO(_synthetic_png())), "E5")
    sheet.merge_cells("A1:B1")
    output = BytesIO()
    book.save(output)
    book.close()
    return output.getvalue()


def _with_richdata(
    source: bytes,
    *,
    broken_target=False,
    exaggerated_dimension=False,
    image_count=1,
    external_target=False,
    unsupported_structure=False,
    rvb_indices=None,
    slot_by_rich=None,
    media_by_slot=None,
    missing_rvb=False,
    invalid_metadata_type=False,
    duplicate_rvb=False,
    invalid_rvb_index=False,
    duplicate_relationship_id=False,
    wrong_local_image_key=False,
    wrong_local_image_namespace=False,
    wrong_rich_rel_namespace=False,
    legacy_metadata_reltype=False,
) -> bytes:
    input_zip = zipfile.ZipFile(BytesIO(source))
    parts = {name: input_zip.read(name) for name in input_zip.namelist()}
    input_zip.close()
    sheet_part = "xl/worksheets/sheet1.xml"
    sheet_root = ET.fromstring(parts[sheet_part])
    row = sheet_root.find(f".//{{{SHEET_NS}}}row[@r='2']")
    existing_cells = {cell.get("r"): cell for cell in row.findall(f"{{{SHEET_NS}}}c")}
    cell_refs = ["B2", "C2", "D2", "E2"][:image_count]
    for index, cell_ref in enumerate(cell_refs, start=1):
        cell = existing_cells.get(cell_ref)
        if cell is None:
            cell = ET.Element(f"{{{SHEET_NS}}}c", {"r": cell_ref})
            row.append(cell)
        cell.set("vm", str(index))
    if exaggerated_dimension:
        dimension = sheet_root.find(f"{{{SHEET_NS}}}dimension")
        dimension.set("ref", "A1:XFD1048576")
    parts[sheet_part] = ET.tostring(sheet_root, encoding="utf-8", xml_declaration=True)

    wb_rels = ET.fromstring(parts["xl/_rels/workbook.xml.rels"])
    metadata_rel_type = "metadata" if legacy_metadata_reltype else "sheetMetadata"
    ET.SubElement(wb_rels, f"{{{REL_NS}}}Relationship", {
        "Id": "rIdIntakeMetadata", "Type": f"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{metadata_rel_type}", "Target": "metadata.xml"
    })
    parts["xl/_rels/workbook.xml.rels"] = ET.tostring(wb_rels, encoding="utf-8", xml_declaration=True)
    rvb_indices = rvb_indices or list(range(len(cell_refs)))
    slot_by_rich = slot_by_rich or list(range(len(cell_refs)))
    media_by_slot = media_by_slot or list(range(len(cell_refs)))
    future_records = "".join(
        "<bk/>" if missing_rvb and index == 0 else
        f'<bk><extLst><ext uri="{{A8765BA9-456A-4DAB-B4F3-ACF838C121DE}}"><rvb xmlns="{RICH_NS}" i="{"bad" if invalid_rvb_index and index == 0 else rvb_indices[index]}"/>'
        f'{f"<rvb xmlns=\"{RICH_NS}\" i=\"{rvb_indices[index]}\"/>" if duplicate_rvb and index == 0 else ""}</ext></extLst></bk>'
        for index in range(len(cell_refs))
    )
    value_records = "".join(
        f'<bk><rc t="{0 if invalid_metadata_type and index == 0 else 1}" v="{index}"/></bk>'
        for index in range(len(cell_refs))
    )
    parts["xl/metadata.xml"] = (
        f'<metadata xmlns="{SHEET_NS}"><metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000"/></metadataTypes>'
        f'<futureMetadata name="XLRICHVALUE" count="{len(cell_refs)}">{future_records}</futureMetadata>'
        f'<valueMetadata count="{len(cell_refs)}">{value_records}</valueMetadata></metadata>'
    ).encode()
    value_rows = "".join(f'<rv s="0"><v>{slot_by_rich[index]}</v><v>0</v></rv>' for index in range(len(cell_refs)))
    parts["xl/richData/rdrichvalue.xml"] = f'<rvData xmlns="{RICH_NS}">{value_rows}</rvData>'.encode()
    structure_type = "_otherType" if unsupported_structure else "_localImage"
    parts["xl/richData/rdrichvaluestructure.xml"] = (
        f'<rvStructures xmlns="{RICH_NS}"><s t="{structure_type}"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>'
    ).encode()
    rich_rels = "".join(f'<rel r:id="rIdSlot{index}"/>' for index in range(len(cell_refs)))
    rich_rel_namespace = RICH_NS if wrong_rich_rel_namespace else RICH_REL_NS
    parts["xl/richData/richValueRel.xml"] = f'<richValueRels xmlns="{rich_rel_namespace}" xmlns:r="{DOC_REL_NS}">{rich_rels}</richValueRels>'.encode()
    relationship_rows = []
    for slot in range(len(cell_refs)):
        media_index = media_by_slot[slot]
        extension = "jpg" if media_index % 2 else "png"
        missing = broken_target and slot == 0
        target = f"../media/missing.{extension}" if missing else f"../media/rich{media_index}.{extension}"
        mode = ' TargetMode="External"' if external_target and slot == 0 else ""
        relationship_rows.append(f'<Relationship Id="rIdSlot{slot}" Type="http://schemas.microsoft.com/office/2017/06/relationships/image" Target="{target}"{mode}/>')
        if not missing and not (external_target and slot == 0):
            parts[f"xl/media/rich{media_index}.{extension}"] = _synthetic_jpeg() if extension == "jpg" else _synthetic_png()
    if duplicate_relationship_id:
        relationship_rows.append('<Relationship Id="rIdSlot0" Type="http://schemas.microsoft.com/office/2017/06/relationships/image" Target="../media/other.png"/>')
    parts["xl/richData/_rels/richValueRel.xml.rels"] = f'<Relationships xmlns="{REL_NS}">{"".join(relationship_rows)}</Relationships>'.encode()
    if wrong_local_image_key:
        structure_root = ET.fromstring(parts["xl/richData/rdrichvaluestructure.xml"])
        key = structure_root.find(f".//{{{RICH_NS}}}k")
        key.set("n", "other:LocalImageIdentifier")
        parts["xl/richData/rdrichvaluestructure.xml"] = ET.tostring(structure_root, encoding="utf-8", xml_declaration=True)
    if wrong_local_image_namespace:
        structure_root = ET.fromstring(parts["xl/richData/rdrichvaluestructure.xml"])
        key = structure_root.find(f".//{{{RICH_NS}}}k")
        key.tag = "{urn:wrong-richdata-namespace}k"
        parts["xl/richData/rdrichvaluestructure.xml"] = ET.tostring(structure_root, encoding="utf-8", xml_declaration=True)
    types_root = ET.fromstring(parts["[Content_Types].xml"])
    ET.SubElement(types_root, "{http://schemas.openxmlformats.org/package/2006/content-types}Override", {
        "PartName": "/xl/metadata.xml", "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"
    })
    parts["[Content_Types].xml"] = ET.tostring(types_root, encoding="utf-8", xml_declaration=True)
    output = BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)
    return output.getvalue()


def _replace_cell_xml(source: bytes, coordinate: str, transform) -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(BytesIO(source)) as source_zip, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for entry in source_zip.infolist():
            data = source_zip.read(entry.filename)
            if entry.filename == "xl/worksheets/sheet1.xml":
                root = ET.fromstring(data)
                cell = root.find(f".//{{{SHEET_NS}}}c[@r='{coordinate}']")
                transform(cell)
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            target.writestr(entry.filename, data)
    return output.getvalue()


def _remove_zip_part(source: bytes, part_name: str) -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(BytesIO(source)) as source_zip, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for entry in source_zip.infolist():
            if entry.filename != part_name:
                target.writestr(entry.filename, source_zip.read(entry.filename))
    return output.getvalue()


class IntakeParserTests(SimpleTestCase):
    def test_workbook_without_richdata_does_not_warn_about_missing_relationship_part(self):
        evidence = parse_workbook(BytesIO(_base_workbook(with_floating=False)))

        self.assertNotIn("richdata_relationship_part_missing", evidence.warnings)

    def test_missing_richdata_relationship_part_warns_and_keeps_cell_locator(self):
        source = _remove_zip_part(
            _with_richdata(_base_workbook(with_floating=False)),
            "xl/richData/richValueRel.xml",
        )

        evidence = parse_workbook(BytesIO(source))

        self.assertIn("richdata_relationship_part_missing", evidence.warnings)
        self.assertEqual(evidence.images[0]["coordinate"], "B2")
        self.assertEqual(evidence.images[0]["warning_code"], "richdata_relationship_part_missing")
        self.assertEqual(evidence.images[0]["target_part"], "")

    def test_cell_image_placeholder_preserves_source_error_and_image_locator(self):
        def make_cell_image_placeholder(cell):
            cell.set("t", "e")
            for child in list(cell):
                cell.remove(child)
            ET.SubElement(cell, f"{{{SHEET_NS}}}v").text = "#VALUE!"

        source = _replace_cell_xml(_base_workbook(with_floating=False), "B2", make_cell_image_placeholder)
        evidence = parse_workbook(BytesIO(_with_richdata(source, image_count=1)))
        cell = next(cell for cell in evidence.sheets[0].cells if cell.coordinate == "B2")

        self.assertEqual(cell.source_type, "e")
        self.assertEqual(cell.raw_value["v_lexeme"], "#VALUE!")
        self.assertEqual(cell.raw_value["vm"], "1")
        self.assertEqual(cell.error_code, "")
        self.assertEqual(evidence.images[0]["coordinate"], "B2")

    def test_preserves_raw_xml_and_normalized_values_formula_cache_and_merges(self):
        evidence = parse_workbook(BytesIO(_base_workbook(with_floating=False)))
        sheet = evidence.sheets[0]
        cells = {cell.coordinate: cell for cell in sheet.cells}
        self.assertEqual(sheet.merged_ranges, ("A1:B1",))
        self.assertEqual(cells["A1"].raw_value["v_lexeme"], "45292")
        self.assertNotEqual(cells["A1"].normalized_value, "45292")
        self.assertEqual(cells["C3"].formula, "1+2")
        self.assertEqual(cells["C3"].formula_status, "unsupported")
        self.assertEqual(cells["C3"].cached_value, {"state": "empty"})
        self.assertEqual(cells["C3"].raw_value["normalized_formula"], "=1+2")
        self.assertEqual(cells["D4"].source_type, "e")
        self.assertEqual(cells["D4"].raw_value["v_lexeme"], "#VALUE!")
        self.assertEqual(evidence.cell_count, 4)

    def test_maps_richdata_slot_to_exact_media_part_and_drawing_anchor(self):
        evidence = parse_workbook(BytesIO(_with_richdata(_base_workbook())))
        rich = next(ref for ref in evidence.images if ref["kind"] == "rich_data")
        floating = next(ref for ref in evidence.images if ref["kind"] == "drawing")
        self.assertEqual(rich["coordinate"], "B2")
        self.assertEqual(rich["relationship_slot"], 0)
        self.assertEqual(rich["target_part"], "xl/media/rich0.png")
        self.assertEqual(rich["mime_type"], "image/png")
        self.assertEqual(floating["coordinate"], "E5")
        self.assertEqual(floating["target_part"].startswith("xl/media/"), True)
        self.assertEqual(floating["anchor"], {"col": 4, "colOff": 0, "row": 4, "rowOff": 0})

    def test_four_richdata_cells_follow_independent_metadata_slots_and_media_relationships(self):
        evidence = parse_workbook(BytesIO(_with_richdata(
            _base_workbook(),
            image_count=4,
            rvb_indices=[1, 0, 3, 2],
            slot_by_rich=[2, 0, 3, 1],
            media_by_slot=[3, 1, 0, 2],
        )))
        rich = [ref for ref in evidence.images if ref["kind"] == "rich_data"]
        self.assertEqual([ref["coordinate"] for ref in rich], ["B2", "C2", "D2", "E2"])
        self.assertEqual([ref["rich_value_index"] for ref in rich], [1, 0, 3, 2])
        self.assertEqual([ref["relationship_slot"] for ref in rich], [0, 2, 1, 3])
        self.assertEqual([ref["target_part"] for ref in rich], [
            "xl/media/rich3.jpg", "xl/media/rich0.png", "xl/media/rich1.jpg", "xl/media/rich2.png",
        ])
        self.assertEqual([ref["mime_type"] for ref in rich], ["image/jpeg", "image/png", "image/jpeg", "image/png"])

    def test_nonstandard_metadata_relationship_type_is_not_guessed(self):
        evidence = parse_workbook(BytesIO(_with_richdata(
            _base_workbook(with_floating=False), legacy_metadata_reltype=True,
        )))
        self.assertEqual(evidence.images[0]["warning_code"], "richdata_vm_unmapped")
        self.assertEqual(evidence.images[0]["target_part"], "")

    def test_richdata_rejects_zero_based_metadata_type_and_invalid_rvb_links(self):
        invalid_type = parse_workbook(BytesIO(_with_richdata(
            _base_workbook(with_floating=False), invalid_metadata_type=True,
        )))
        self.assertEqual(invalid_type.images[0]["warning_code"], "richdata_metadata_type_invalid")
        self.assertEqual(invalid_type.images[0]["target_part"], "")

        missing_rvb = parse_workbook(BytesIO(_with_richdata(
            _base_workbook(with_floating=False), missing_rvb=True,
        )))
        self.assertEqual(missing_rvb.images[0]["warning_code"], "richdata_rvb_missing")
        self.assertEqual(missing_rvb.images[0]["target_part"], "")

        duplicate_rvb = parse_workbook(BytesIO(_with_richdata(
            _base_workbook(with_floating=False), duplicate_rvb=True,
        )))
        self.assertEqual(duplicate_rvb.images[0]["warning_code"], "richdata_rvb_ambiguous")
        self.assertEqual(duplicate_rvb.images[0]["target_part"], "")

        invalid_index = parse_workbook(BytesIO(_with_richdata(
            _base_workbook(with_floating=False), invalid_rvb_index=True,
        )))
        self.assertEqual(invalid_index.images[0]["warning_code"], "richdata_rvb_index_invalid")
        self.assertEqual(invalid_index.images[0]["target_part"], "")

    def test_richdata_requires_exact_local_image_key_and_unique_relationship_id(self):
        wrong_key = parse_workbook(BytesIO(_with_richdata(
            _base_workbook(with_floating=False), wrong_local_image_key=True,
        )))
        self.assertEqual(wrong_key.images[0]["warning_code"], "richdata_local_image_slot_missing")
        self.assertEqual(wrong_key.images[0]["target_part"], "")

        wrong_namespace = parse_workbook(BytesIO(_with_richdata(
            _base_workbook(with_floating=False), wrong_local_image_namespace=True,
        )))
        self.assertEqual(wrong_namespace.images[0]["warning_code"], "richdata_local_image_slot_missing")
        self.assertEqual(wrong_namespace.images[0]["target_part"], "")

        wrong_relationship_namespace = parse_workbook(BytesIO(_with_richdata(
            _base_workbook(with_floating=False), wrong_rich_rel_namespace=True,
        )))
        self.assertEqual(wrong_relationship_namespace.images[0]["warning_code"], "richdata_relationship_namespace_unsupported")
        self.assertEqual(wrong_relationship_namespace.images[0]["target_part"], "")

        duplicate_relationship = parse_workbook(BytesIO(_with_richdata(
            _base_workbook(with_floating=False), duplicate_relationship_id=True,
        )))
        self.assertEqual(duplicate_relationship.images[0]["warning_code"], "richdata_relationship_ambiguous")
        self.assertEqual(duplicate_relationship.images[0]["target_part"], "")

    def test_broken_rich_relationship_is_explicit_and_does_not_guess_other_media(self):
        evidence = parse_workbook(BytesIO(_with_richdata(_base_workbook(with_floating=False), broken_target=True)))
        rich = next(ref for ref in evidence.images if ref["kind"] == "rich_data")
        self.assertEqual(rich["warning_code"], "richdata_media_missing")
        self.assertEqual(rich["target_part"], "xl/media/missing.png")

    def test_external_target_and_unknown_rich_structure_are_not_guessed(self):
        external = parse_workbook(BytesIO(_with_richdata(_base_workbook(with_floating=False), external_target=True)))
        rich = next(ref for ref in external.images if ref["kind"] == "rich_data")
        self.assertEqual(rich["warning_code"], "richdata_external_target")
        unsupported = parse_workbook(BytesIO(_with_richdata(_base_workbook(with_floating=False), unsupported_structure=True)))
        rich = next(ref for ref in unsupported.images if ref["kind"] == "rich_data")
        self.assertEqual(rich["warning_code"], "richdata_structure_unsupported")

    def test_duplicate_generic_relationship_ids_are_not_silently_overwritten(self):
        rels = (
            f'<Relationships xmlns="{REL_NS}">'
            '<Relationship Id="rIdSame" Target="first.xml" Type="first"/>'
            '<Relationship Id="rIdSame" Target="second.xml" Type="second"/>'
            '</Relationships>'
        ).encode()
        archive_bytes = BytesIO()
        with zipfile.ZipFile(archive_bytes, "w") as archive:
            archive.writestr("xl/_rels/workbook.xml.rels", rels)
        with zipfile.ZipFile(BytesIO(archive_bytes.getvalue())) as archive:
            self.assertIsNone(_rels(archive, "xl/workbook.xml")["rIdSame"])

    def test_formula_error_cache_without_vm_is_not_a_rich_image(self):
        source = _replace_cell_xml(
            _base_workbook(with_floating=False),
            "D4",
            lambda cell: (
                cell.set("t", "e"),
                ET.SubElement(cell, f"{{{SHEET_NS}}}f").__setattr__("text", "1/0"),
                cell.find(f"{{{SHEET_NS}}}v").__setattr__("text", "#VALUE!"),
            ),
        )
        evidence = parse_workbook(BytesIO(source))
        cell = next(cell for cell in evidence.sheets[0].cells if cell.coordinate == "D4")
        self.assertEqual(cell.error_code, "cached_formula_error")
        self.assertEqual(cell.raw_value["vm"], None)
        self.assertFalse(any(image["coordinate"] == "D4" for image in evidence.images))

    def test_exaggerated_declared_dimension_does_not_trigger_dense_traversal(self):
        evidence = parse_workbook(BytesIO(_with_richdata(_base_workbook(with_floating=False), exaggerated_dimension=True)))
        self.assertEqual(evidence.cell_count, 4)
        self.assertEqual(len(evidence.sheets[0].cells), 4)

    def test_nonempty_cell_budget_is_enforced_without_changing_production_limit(self):
        with patch("workbench.intake.parser.MAX_CELLS", 3):
            with self.assertRaises(ValidationError):
                parse_workbook(BytesIO(_base_workbook(with_floating=False)))

    def test_sheet_and_image_budgets_are_enforced_with_small_synthetic_workbook(self):
        with patch("workbench.intake.parser.MAX_SHEETS", 0):
            with self.assertRaises(ValidationError):
                parse_workbook(BytesIO(_base_workbook(with_floating=False)))
        with patch("workbench.intake.parser.MAX_IMAGE_REFERENCES", 0):
            with self.assertRaises(ValidationError):
                parse_workbook(BytesIO(_with_richdata(_base_workbook(with_floating=False))))

    def test_formula_node_presence_and_cache_states_are_distinct(self):
        source = _base_workbook(with_floating=False)
        missing_cache = _replace_cell_xml(source, "C3", lambda cell: cell.remove(cell.find(f"{{{SHEET_NS}}}v")))
        def make_shared_follower(cell):
            formula = cell.find(f"{{{SHEET_NS}}}f")
            formula.attrib.update({"t": "shared", "si": "0"})
            formula.text = None
        follower = _replace_cell_xml(source, "C3", make_shared_follower)
        string_cache = _replace_cell_xml(source, "C3", lambda cell: (
            cell.set("t", "str"),
            cell.find(f"{{{SHEET_NS}}}v").__setattr__("text", "#ready"),
        ))

        missing_cell = {cell.coordinate: cell for cell in parse_workbook(BytesIO(missing_cache)).sheets[0].cells}["C3"]
        follower_cell = {cell.coordinate: cell for cell in parse_workbook(BytesIO(follower)).sheets[0].cells}["C3"]
        string_cell = {cell.coordinate: cell for cell in parse_workbook(BytesIO(string_cache)).sheets[0].cells}["C3"]

        self.assertEqual(missing_cell.cached_value, {"state": "missing"})
        self.assertEqual(follower_cell.cached_value, {"state": "empty"})
        self.assertEqual(follower_cell.formula, "")
        self.assertTrue(follower_cell.raw_value["formula_present"])
        self.assertIsNone(follower_cell.raw_value["formula_text"])
        self.assertEqual(follower_cell.raw_value["formula_attrs"], {"t": "shared", "si": "0"})
        self.assertEqual(string_cell.cached_value["value"], "#ready")
        self.assertEqual(string_cell.error_code, "")

        zero_cache = _replace_cell_xml(source, "C3", lambda cell: cell.find(f"{{{SHEET_NS}}}v").__setattr__("text", "0"))
        zero_cell = {cell.coordinate: cell for cell in parse_workbook(BytesIO(zero_cache)).sheets[0].cells}["C3"]
        self.assertEqual(zero_cell.cached_value, {"state": "present", "value": 0, "lexeme": "0"})

    def test_formula_error_uses_ooxml_error_type_not_hash_prefix(self):
        source = _replace_cell_xml(_base_workbook(with_floating=False), "C3", lambda cell: (
            cell.set("t", "e"),
            cell.find(f"{{{SHEET_NS}}}v").__setattr__("text", "#VALUE!"),
        ))
        cell = {cell.coordinate: cell for cell in parse_workbook(BytesIO(source)).sheets[0].cells}["C3"]
        self.assertEqual(cell.error_code, "cached_formula_error")
        self.assertEqual(cell.cached_value["lexeme"], "#VALUE!")

    def test_oversized_merge_area_is_rejected_before_openpyxl_expands_it(self):
        source = _replace_cell_xml(_base_workbook(with_floating=False), "A1", lambda cell: None)
        output = BytesIO()
        with zipfile.ZipFile(BytesIO(source)) as source_zip, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
            for entry in source_zip.infolist():
                data = source_zip.read(entry.filename)
                if entry.filename == "xl/worksheets/sheet1.xml":
                    root = ET.fromstring(data)
                    merge = root.find(f".//{{{SHEET_NS}}}mergeCell")
                    merge.set("ref", "A1:XFD1048576")
                    data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                target.writestr(entry.filename, data)
        with self.assertRaises(ValidationError):
            parse_workbook(BytesIO(output.getvalue()))
