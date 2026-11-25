"""SKU 成本台账。

分层与其它业务域一致：
  fx.py       币种口径与三源汇率抓取
  catalog.py  商品清单 CSV 解析
  service.py  渠道口径、成本计算、汇总与展示格式化（纯函数）
  store.py    数据库读写与事务（唯一碰 ORM 的地方）
  api.py      HTTP 入口与 error_code 契约

清单可随时从 CSV / 官网后台重建，成本是人工数据需备份——所以分表存放。
"""
from __future__ import annotations

__all__ = ["api", "catalog", "fx", "service", "store"]
