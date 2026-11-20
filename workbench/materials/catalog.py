from __future__ import annotations

from dataclasses import dataclass


CATALOG_SOURCE = "demo_fixture"
CATALOG_VERSION = "2026-11-15"
CATALOG_DISCLAIMER = "演示物料主数据，未接入 ERPNext；不代表客户真实物料或已验收的主数据。"


@dataclass(frozen=True)
class MaterialItem:
    item_code: str
    item_name: str
    item_group: str
    stock_uom: str
    aliases: tuple[str, ...] = ()
    disabled: bool = False


# 业务形态取自访谈记录：整机为主控制器与木材，辅件为彩灯、氧吧、播放器。
# 编号规则为 <组别>-<序号>，仅用于演示解析与核对，不是客户现有编码。
_DEMO_ITEMS: tuple[MaterialItem, ...] = (
    MaterialItem("MAT-CTRL-001", "主控制器", "电子件", "台", ("控制器", "主控板")),
    MaterialItem("MAT-CTRL-002", "副控制器", "电子件", "台", ("副控板",)),
    MaterialItem("MAT-WOOD-001", "松木型材", "结构件", "根", ("松木条", "木方")),
    MaterialItem("MAT-WOOD-002", "樟子松板材", "结构件", "张", ("板材", "松木板")),
    MaterialItem("MAT-PANEL-001", "远红外发热板", "功能件", "片", ("发热板", "红外板")),
    MaterialItem("MAT-LED-001", "彩灯带", "照明", "米", ("彩灯", "灯带")),
    MaterialItem("MAT-OXY-001", "氧吧发生器", "功能件", "套", ("氧吧", "负离子发生器")),
    MaterialItem("MAT-AUD-001", "MP3播放器", "功能件", "台", ("MP3", "音乐播放器")),
    MaterialItem("MAT-SCR-001", "不锈钢螺丝 M4", "五金", "个", ("螺丝M4", "M4螺丝")),
    MaterialItem("MAT-PKG-001", "瓦楞纸箱", "包装", "个", ("纸箱", "外箱")),
    MaterialItem("MAT-PKG-002", "泡沫护角", "包装", "个", ("护角", "泡沫角")),
    MaterialItem("MAT-SEAL-001", "门封条", "五金", "米", ("封条",), disabled=True),
)


def material_items() -> tuple[MaterialItem, ...]:
    """返回主数据快照；调用方不得依赖可变全局状态。"""
    return _DEMO_ITEMS
