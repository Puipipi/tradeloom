"""商品清单的导入口径：表头映射与 CSV 解析。

清单只描述"有哪些 SKU、长什么样"，**不掺任何成本**。CSV 导入和未来官网后台
推送共用同一套字段名，接后台时把对方数据映射成 records 即可，账这边不用改。

表头认中文标签、英文字段名，也认几个随手改的别名（型号/货号/尺寸…），
因为这份文件常年在 Excel 里被人工编辑。
"""
from __future__ import annotations

import csv
import io

CATALOG_COLS = [
    ("sku", "SKU"),
    ("name", "商品名称"),
    ("series", "系列"),
    ("sub_category", "子系列"),
    ("size", "规格"),
    ("material", "材质"),
    ("active", "在售"),
]

CATALOG_ALIAS = {
    "型号": "sku", "货号": "sku", "编码": "sku", "商品编码": "sku",
    "名称": "name", "品名": "name", "商品名": "name",
    "大类": "series", "产品系列": "series",
    "子类": "sub_category", "类目": "sub_category",
    "尺寸": "size", "宽度": "size",
    "材料": "material", "面料": "material",
    "状态": "active", "是否在售": "active",
}

TEXT_FIELDS = ("name", "series", "sub_category", "size", "material")

_INACTIVE_WORDS = ("0", "false", "no", "n", "停用", "下架", "否", "淘汰", "off")


class CatalogError(ValueError):
    """清单内容无法解析成任何 SKU 行。"""


def label_map() -> dict[str, str]:
    mapping = {key: key for key, _label in CATALOG_COLS}
    mapping.update({label: key for key, label in CATALOG_COLS})
    mapping.update(CATALOG_ALIAS)
    return mapping


def truthy_active(value) -> bool | None:
    """None = 这行没说，保持原状；其余按字面判断。"""
    if value is None:
        return None
    text = str(value).strip().lower()
    if text == "":
        return None
    return text not in _INACTIVE_WORDS


def clean_sku(value) -> str:
    return str(value or "").strip()


def parse_csv(text: str) -> tuple[list[dict], int]:
    """返回 (records, skipped)。有内容却没 SKU 的行也算 skipped，便于解释行数对不上。"""
    text = (text or "").lstrip("\ufeff")
    if not text.strip():
        raise CatalogError("内容为空")
    mapping = label_map()
    records: list[dict] = []
    skipped = 0
    for raw in csv.DictReader(io.StringIO(text)):
        row: dict = {}
        for column, value in raw.items():
            if column is None:
                continue
            key = mapping.get(str(column).strip().lstrip("\ufeff"))
            if key:
                row[key] = value
        if clean_sku(row.get("sku")):
            records.append(row)
        else:
            skipped += 1
    if not records:
        raise CatalogError("没有解析到任何 SKU 行，确认首行是表头，且有一列叫 SKU")
    return records, skipped


def normalize_record(record: dict) -> dict:
    """把一行原始输入收敛成可入库的字段。空字符串一律当"没说"，不覆盖已有值。"""
    out: dict = {"sku": clean_sku(record.get("sku"))}
    for field in TEXT_FIELDS:
        value = record.get(field)
        out[field] = None if value is None else (str(value).strip() or None)
    flag = truthy_active(record.get("active"))
    out["active"] = flag
    return out


def template_csv() -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([label for _key, label in CATALOG_COLS])
    writer.writerow([
        "VFR-01-38", "VFR-01 – Wired Velvet Ribbon", "Christmas & Winter Collections",
        "Velvet Ribbon", "38mm", "Polyester", "是",
    ])
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")
