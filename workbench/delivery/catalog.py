from __future__ import annotations

import base64
import re
from html import escape
from typing import Any


class EnglishNameRequired(ValueError):
    def __init__(self, product_id: str, revision_id: str):
        self.product_id = product_id
        self.revision_id = revision_id
        super().__init__(f"Product {product_id} revision {revision_id} needs an English name")


def _required_english_name(row: dict[str, Any]) -> str:
    snapshot = row.get("snapshot")
    value = snapshot.get("english_name") if isinstance(snapshot, dict) else None
    if not isinstance(value, str) or not value.strip():
        raise EnglishNameRequired(str(row.get("product_id", "")), str(row.get("revision_id", "")))
    return value.strip()


def _image_data_uri(image: dict[str, Any] | None) -> str:
    if not image:
        return ""
    mime_type = image["mime_type"]
    content = image["content"]
    return f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}"


def build_catalog_html(products: list[dict[str, Any]]) -> str:
    rows = []
    for row in products:
        snapshot = row["snapshot"]
        english_name = _required_english_name(row)
        image = row.get("image")
        image_html = ""
        if image:
            image_html = (
                f'<img alt="{escape(english_name, quote=True)}" '
                f'src="{escape(_image_data_uri(image), quote=True)}">'
            )
        values = (
            row["product_id"],
            row["revision_id"],
            row["version"],
            snapshot.get("sku", ""),
            english_name,
            snapshot.get("name", ""),
            snapshot.get("category", ""),
            snapshot.get("material", ""),
            snapshot.get("size", ""),
            snapshot.get("color", ""),
        )
        cells = "".join(f"<td>{escape(str(value), quote=True)}</td>" for value in values)
        image_source = ""
        if image:
            image_source = (
                f'<span>TaskFile {escape(str(image["task_file_id"]))}; '
                f'{escape(str(image["filename"]))}; SHA-256 '
                f'{escape(str(image["sha256"]))}</span>'
            )
        rows.append(f"<tr><td>{image_html}{image_source}</td>{cells}</tr>")
    body = "\n".join(rows)
    return (
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<title>Product Catalog</title>"
        "<style>body{font-family:Arial,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%}"
        "th,td{border:1px solid #ccd3dc;padding:.55rem;text-align:left}img{max-width:8rem;max-height:8rem;display:block}"
        "</style></head><body><h1>Product Catalog</h1><table><thead><tr>"
        "<th>Image source</th><th>Product ID</th><th>Revision ID</th><th>Revision version</th>"
        "<th>SKU</th><th>English name</th><th>Original name</th><th>Category (source)</th>"
        "<th>Material (source)</th><th>Size (source)</th><th>Color (source)</th>"
        f"</tr></thead><tbody>{body}</tbody></table></body></html>\n"
    )


def _markdown_text(value: Any) -> str:
    text = escape(str(value), quote=False).replace("\r", " ").replace("\n", " ")
    escaped = []
    for character in text:
        if character in "\\`*_{}[]()#+-.!|~":
            escaped.append("\\")
        escaped.append(character)
    return "".join(escaped)


def _markdown_code_span(value: Any) -> str:
    text = str(value).replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
    longest_run = max((len(run) for run in re.findall(r"`+", text)), default=0)
    delimiter = "`" * (longest_run + 1)
    if text.startswith((" ", "`")) or text.endswith((" ", "`")):
        text = f" {text} "
    return f"{delimiter}{text}{delimiter}"


def build_catalog_markdown(products: list[dict[str, Any]]) -> str:
    sections = ["# Product Catalog", ""]
    for row in products:
        snapshot = row["snapshot"]
        english_name = _required_english_name(row)
        image = row.get("image")
        sections.extend(
            [
                f"## {_markdown_text(english_name)}",
                "",
                f"- Product ID: {_markdown_text(row['product_id'])}",
                f"- Revision ID: {_markdown_text(row['revision_id'])}",
                f"- Revision version: {_markdown_text(row['version'])}",
                f"- SKU: {_markdown_text(snapshot.get('sku', ''))}",
                f"- Original name: {_markdown_text(snapshot.get('name', ''))}",
                f"- Category (source): {_markdown_text(snapshot.get('category', ''))}",
                f"- Material (source): {_markdown_text(snapshot.get('material', ''))}",
                f"- Size (source): {_markdown_text(snapshot.get('size', ''))}",
                f"- Color (source): {_markdown_text(snapshot.get('color', ''))}",
            ]
        )
        if image:
            sections.extend(
                [
                    "",
                    f"![{_markdown_text(english_name)}]({_image_data_uri(image)})",
                    f"Image source: TaskFile {_markdown_code_span(image['task_file_id'])}, "
                    f"{_markdown_code_span(image['filename'])}, "
                    f"SHA-256 {_markdown_code_span(image['sha256'])}.",
                ]
            )
        else:
            sections.append("- Image source: none")
        sections.append("")
    return "\n".join(sections)
