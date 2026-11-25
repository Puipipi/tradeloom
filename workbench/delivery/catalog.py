from __future__ import annotations

import base64
import re
from html import escape
from typing import Any


def display_name(row: dict[str, Any]) -> str:
    """目录标题：优先英文名（历史上人工填过就沿用），否则用中文名，再退到 SKU。

    版本体系下线后不再强制要求英文名——缺英文名不再阻断交付物生成。
    """
    snapshot = row.get("snapshot")
    if isinstance(snapshot, dict):
        for key in ("english_name", "name", "sku"):
            value = snapshot.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return str(row.get("product_id", ""))


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
        english_name = display_name(row)
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
        "<th>SKU</th><th>Catalog name</th><th>Original name</th><th>Category (source)</th>"
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
        english_name = display_name(row)
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
