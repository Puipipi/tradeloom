# SKU 成本台账：功能说明与实现方法

> 位置：`workbench/sku/` + `workbench/templates/workbench/products.html`（页面路由仍是 `/products`，导航名仍是「产品资料」）
> 取代：原「产品资料 / 只读总览」页面的内容（表格与批次列表面板下线，页面本身保留）
> 迁移：`0021_sku_ledger` → `0026_sku_duty_preferred`，依赖 `0020_business_documents`

## 1. 这个模块回答什么

一句话：**这件货卖这个价，扣掉采购、头程、关税和佣金之后还剩多少；同一批货换个市场卖，差多少。**

它不回答「该不该上这个品」——库存、账期、账号资质都不在这份数据里。

| 它做 | 它不做 |
|---|---|
| 单件到岸成本（采购 + 头程 + 关税）与商品毛利 | 猜广告费与退货率：那是期间费用，按实际发生额登记 |
| 按「HS × 目的市场」查现行税率，基础与附加分开 | 自动套用自贸协定优惠税率（要凭原产地证） |
| 跨市场各算一遍，给出「换市场 / 补税率 / 亏损 / 薄利」四类提示 | 给「建议下架」的结论 |
| 商品清单从 CSV 导入或官网后台推送（可重建） | 在界面上单条新增 / 删除 / 改名 SKU |
| 期间费用按月、按市场登记，与商品毛利在汇总层相加 | 把期间费用摊回单件成本 |

**为什么这个槽位给了成本台账**：原来的页面是把 intake 解析出的产品事实列出来看，回答的是「资料齐不齐」；实际经营里更常被问到的是「这价能不能接」。两者用同一批 SKU 主数据，但只有成本台账每天都要改数字，所以这个槽位给了台账。**导航与页面标题仍是「产品资料」**（与桌面版「织贸工作台」完全一致），换掉的只是页面内容。产品资料的数据模型（`Product` / `ProductRevision`）与 `/api/products/**`、`/api/product-library` 全部保留，交付物生成、ERPNext 适配、图片恢复仍走原链路，只是不再有独立页面。

## 2. 数据模型

七张表，全部由 `workbench/models.py` 定义，互不外键——台账是「成本」的独立账本，删掉它能靠主数据重建清单，但会丢掉人工填的成本。

| 表 | 存什么 | 能否重建 |
|---|---|---|
| `SkuCatalogItem` | 货号、名称、系列、子系列、材质、规格、官网链接、图片、在售、position、来源 | 能（CSV / 官网推送重导） |
| `SkuCatalogImport` | 每次清单导入的流水（新增 / 更新 / 跳过 / 总数） | 能 |
| `SkuCostEntry` | **人工成本**：HS 编码、售价 + 售价币种、采购价、头程、预估月销、佣金 | **不能，只能靠备份** |
| `SkuPeriodCost` | 期间费用（市场 × 月份）：广告、退货、店铺月费、其他、备注 | 不能 |
| `SkuSetting` | 单例：市场、渠道、汇率模式、手填汇率（按币种分存）、退税率、固定费 | 能（重配一遍） |
| `SkuDutyRate` | 关税率规则（市场 × HS 前缀）：基础、附加、优惠（只登记不参与计算）、备注 | 不能（要重新查税则） |
| `SkuFxSnapshot` | 汇率快照缓存（多源报价、上一次的汇率、分歧标记、检查时间） | 能（随时删） |

三条建模决定，改之前先读：

1. **0 与空白不是一回事。** 售价填 `0` 是「确实是 0」，留空是「还没填」。前者算出一个负毛利，后者标「待补」——两者混用会让「没填」被当成「不赚不亏」。
2. **售价带币种。** `price_currency` 记这一格是哪个币种填的。切了市场币种，旧数字自动退回「待补」并显示「原 10 USD」，绝不把 10 美元当 10 欧元算。
3. **关税不在 `SkuCostEntry` 上。** 它是「HS × 目的国 × 生效期」的规则，挂在 SKU 上会导致改一次政策翻遍历史行、报价阶段（还没有订单）根本算不出来。`hs_prefix` 支持前缀匹配，只录 `5806` 就能覆盖 `5806.32` / `5806.32.10`，取最长前缀。

## 3. 核算口径

实现：`workbench/sku/service.py::compute()`，纯函数、不碰数据库，可直接单测。

```
退税额      = 采购价 ÷ (1 + 13%) × 退税率
货品成本    = 采购价 − 退税额
到岸成本    = 货品成本 + 头程 + 关税
关税        = (货品成本 + 头程) × 关税率        ← CIF 计征，不是按采购价
佣金        = 售价(CNY) × 佣金率
商品毛利    = 售价(CNY) − 到岸成本 − 佣金
保本售价    = 到岸成本 ÷ (1 − 佣金率) ÷ 汇率
```

为什么这几处这么定：

| 决定 | 理由 |
|---|---|
| 关税按 CIF（货值 + 头程） | 只按采购价会把关税系统性算少，毛利偏高 |
| 广告 / 退货 / 月费不进单件 | 同一件货今天 ACOS 8%、明天 40%，摊进去得到的是一个没法校准的均值 |
| 佣金进单件、固定费不进 | 佣金是平台按比例抽的、可确定；月租是整店成本，按「预估月销」摊只会误导 |
| 缺必要字段就不出毛利 | 缺项列成「待补 N」并写明缺哪个；`profit` / `margin` 整段不出现，而不是给 0 |
| 退税率接受 `13` / `0.13` / `"13%"` | 与佣金同一套 `percent()` 解析，避免把 13 当 13% 用出负成本 |

经营净利只在汇总层出现：

```
月商品毛利 = Σ 商品毛利 × 预估月销        （只累加「可算」的行）
经营净利   = 月商品毛利 − 期间费用合计
```

期间费用里广告 / 退货 / 店铺月费没登记时，净利标 `missing`，页面显示成 `≤`——缺项只会让净利更低。

## 4. 关税取数

实现：`workbench/sku/duty_lookup.py`，直连官方站，不走浏览器自动化、不走第三方 API。

| 市场 | 取数地址 | 能取到什么 |
|---|---|---|
| 美国 | `hts.usitc.gov/reststop/search`（基础）+ `reststop/exportList`（Chapter 99：`9903.88.*` 301、`9903.01.*` 对华加征） | 基础税率精确；附加只列「现行条款 + 费率」，**无法按商品码判定落在哪份清单**，需人工核对 |
| 英国 | `www.trade-tariff.service.gov.uk/api/v2/commodities/<10 位>` | Third country duty → 基础；反倾销 / 反补贴 / 附加税（地理区域 China 或 ERGA OMNES）→ 附加，同类型多档取最高并在 note 说明 |
| 欧盟 | TARIC 两步查询（带 cookie 会话） | Third country duty → 基础；anti-dumping / countervailing / additional duty → 附加 |
| 日本 / 澳洲 / 香港 / 内地 | — | 返回 `supported=false` + 官网链接，**不猜数** |

四条前提，写死在模块 docstring 里：原产地固定中国；不做自贸协定优惠税率的自动填充；基础与附加分 `slot` 返回，两栏相加才是实际税负；任何一栏空着都表示「没查」，不等于零。

缓存：默认 10 分钟，欧盟 6 小时（两步查询要十几秒），美国 Chapter 99 附加清单 12 小时。8 位父级码查不到时自动展开子目并给出 warning，不会静默返回空。

## 5. 汇率

- 三个公开源并行取价（er-api / frankfurter / jsdelivr currency-api），取中位数，记录分歧与点差，标「N 源校验」。
- 快照 TTL 30 分钟；联网失败回退旧值并标 `stale`，页面显示「缓存，未联网」。
- 模式二选一：`auto` 用实时牌价，`manual` 用手填值（**按币种分开存**，切市场不会互相覆盖）。
- 不再有「按月锁汇率」：一个月里往往有好几笔订单、每笔成交汇率都不同，锁一档月汇率等于把平均值写进成本。逐笔汇率归订单模块。

## 6. 选品建议

已独立成模块：`workbench/trade/advice.py`，入口 `GET /api/advice`（旧地址 `/api/sku/advice` 保留为别名，返回结构只增不减）。

它读两份数据：**成本侧**（`store.advice_inputs()` 把同一批 SKU 在每个出口市场各算一遍，售价按「同一件货卖等值价格」折算：当前币种价 × 当前市场汇率 ÷ 目标市场汇率）和**需求侧**（`trade.service` 算出的 HS6 各国进口额，见第 14 节）。

| 类型 | 触发条件 | 文案示例 |
|---|---|---|
| 没量 `no_demand` | 目标市场毛利最高，但那里该编码的年进口额低于 500 万美元 | 「美国每件毛利最高（30.00 元），但该市场 2025 年进口 100 万美元、同比 -12.0%，量太小——换过去可能只是把库存挪个地方。」 |
| 换市场 `switch` | 目标市场每件毛利更高，且月毛利差 ≥ 30 元 | 「同样的成本，在美国每件毛利 8.40 元，比澳大利亚多 2.10 元；按月销 400 件，每月多 840 元。该市场 2025 年进口 2.48 亿美元、同比 +8.0%、中国占 62.0%。」 |
| 补税率 `fill` | 当前市场算不出、别的市场能算 | 「美国还缺这个 HS 的税率，算不出；在英国每件毛利 6.20 元。补齐税率才谈得上比较。」 |
| 亏损 `loss` | 当前市场每件亏 | 「澳大利亚每件亏 2.89 元（月销 80 件，每月亏 231 元）；保本价 9.77，现价 9。」 |
| 薄利 `thin` | 毛利率 < 15% | 「澳大利亚毛利率 12.4%，扣完广告与退货基本不剩。」 |

四条硬约束：

1. **只比能算的市场**——没配税率不参与，把「未配」当 0 会得出假毛利；
2. **默认零关税市场排最后**（香港），并标「默认零关税」；
3. **排除中国内地**——本地市场没有出口关税与跨境头程，放进来会以 0 关税霸榜；
4. **没同步过贸易数据不装作有**——该市场标 `demand_flag=2`（未知），排序夹在「有量」和「量很小」之间。把「没查」当成「没量」会让缺数据变成负面证据。

市场排序键是 `(是否只是默认零关税, demand_flag, 平均毛利率, 可算 SKU 数)`，倒序。`demand_flag`：有量 3 / 未知 2 / 量很小 1 / 查过但没进口 0。

`no_demand` 用的是「低于需求下限」而不是档位——档位里的「小」仍然算有量（2000 万美元以下但过 500 万），真正该劝阻的是连下限都够不着的那种。

页面默认不计算，切到「选品建议」tab 才算：一次建议要把七个市场各算一遍，比读表格慢得多。

## 7. 接口

统一契约：成功 `{"ok": true, ...}`；失败 `{"ok": false, "error_code": "..."}`，错误码映射 HTTP 状态，中文文案留给前端。请求体走 `workbench.intake.api._json_object`，带 content_type 校验、体积上限、重复键检测。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/sku` | 整份状态：设置、市场条、14 列核算行、统计、期间费用、关税缺口 |
| POST | `/api/sku/rows` | 改人工成本（`{patch: {sku: {字段: 值}}}`，空值 = 清格） |
| POST | `/api/sku/import` | 成本 CSV 导入（按 SKU 覆盖，未知 SKU 单独报出） |
| GET | `/api/sku/export.csv` | 导出，参数 `q / series / state / month` 与页面筛选同口径 |
| POST | `/api/sku/catalog/import` | 商品清单 CSV 导入 |
| POST | `/api/sku/catalog/push` | 官网后台推送清单 |
| GET | `/api/sku/catalog/template.csv` | 清单模板下载 |
| GET/POST | `/api/sku/settings` | 口径设置（市场 / 渠道 / 汇率模式 / 退税率 / 手填汇率） |
| GET/POST | `/api/sku/fx` | 汇率快照，POST 为强制刷新 |
| GET/POST | `/api/sku/duty` | 关税率表，POST 整表覆盖当前市场 |
| GET/POST | `/api/sku/duty/lookup` | 按 HS 向官方税则查询，返回 `slot=base/extra` 候选 |
| POST | `/api/sku/hs-bulk` | 按子系列批量写 HS 编码（默认只补空白） |
| GET | `/api/sku/period` | 期间费用，按「市场 × 月份」登记 |
| GET | `/api/advice` | 选品建议（成本侧 × 需求侧）；`/api/sku/advice` 是兼容别名 |

需求侧（第 14 节）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/trade` | 面板状态：HS6 清单、矩阵、覆盖率、最近同步流水、接入设置 |
| POST | `/api/trade/sync` | 分批拉取，`{offset, max_calls}`；返回 `next_offset` 与 `done` |
| POST | `/api/trade/settings` | `{settings: {api_key, lookback_years}}`，**只回 has_key，不回 key 本身** |
| POST | `/api/trade/clear` | 清缓存，`{hs6}` 可只清一个编码 |

写接口一律把当前核算月份带回整份 `state`，前端局部刷新，不整页 reload。

## 8. 前端

产品资料页现在是**三个模块**，顶部分 tab 切换，状态记在 localStorage 与 URL hash（`#trade` 可直接分享）：

| 模块 | 脚本 | 内容 |
|---|---|---|
| SKU 成本台账 | `sku-ledger.js` | 144 行核算表、市场条、关税率弹窗、期间费用 |
| UN Comtrade | `trade-ledger.js` | 覆盖率统计、HS6 × 市场矩阵、分批同步进度、接入设置 |
| 选品建议 | `advice-panel.js` | 市场排序（毛利 + 需求）、建议列表 |

- **切换只改 `hidden`，不重载页面**：SKU 表格 144 行、矩阵几十格，每次点 tab 重新请求既慢又会丢掉滚动位置。
- **各面板按需加载**：`products-tabs.js` 派发 `pd:show` 事件，选品建议只在切进来时才算。
- **一个页面、一份状态**：`applyState(payload)` 把行、统计、市场条、汇率说明、关税提示、期间费用一次刷完；输入框「数值相等就不改写 DOM」，避免自动保存把光标打断。
- **导出跟随筛选**：点击时把 `q / series / state / month` 拼进查询串，导出的就是屏幕上那批行（以前固定导全量，筛了「仅亏损」还得回 Excel 再筛一遍）。
- **关税率弹窗**按「本市场实际用到的 HS」列出待填分组，未配的排最前并标覆盖多少 SKU。
- **折叠状态**用根元素上的类表示，模板 `<head>` 内联脚本先打类，首帧就是收起的，不会先铺开再塌回去。

## 9. 接入与迁移

1. `workbench/sku/` 与 `migrations/0021…0026` 一起放入 `workbench/`（依赖 `0020_business_documents`，无需改号）。
2. `urls.py` 挂 14 条 `api/sku/**`，`/products` 页面路由不变。
3. `views.products` 改为渲染 `workbench/products.html` 并传 `sku_ledger`；页面文件、`sku-ledger.css`、`sku-ledger.js` 一并带上。
4. 静态资源走 `{% business_path '/static/workbench/...' %}`，与其它页面一致；模板只用到 `base.html` 已有的 5 个 block。

**与老产品资料库的关系**：`workbench/products/`（query / versions / restoration）、`Product` / `ProductRevision`、`/api/products/**`、`/api/product-library` 全部保留——intake 解析、交付物生成、ERPNext 草稿、图片恢复仍依赖它们。本次只替换了「页面」，没有删数据模型，也没有删接口。

## 10. 验收

自动：

```bash
TRADELOOM_DB_TEST_NAME=tradeloom_test_xxx python manage.py test \
  workbench.tests.test_sku_ledger workbench.tests.test_pages --keepdb
```

`test_sku_ledger.py` 覆盖：到岸成本 / 毛利 / 保本价的黄金数字、出口退税对货值的冲减、缺税率不硬编 0、`0` 与空白的区别、切币种后旧售价退回待补、期间费用只在汇总层相减且缺项标上限、导出跟随筛选、成本 CSV 只动已知 SKU、建议接口排除中国内地且香港带 `assumed_zero`。

手工：

1. `/products` 打开 → 统计条、目的市场条、14 列表格、「期间费用」与「选品建议」两个可折叠区。
2. 点「导入商品清单」→ 下载模板 → 填两行 → 导入；「导入成本 CSV」改一格售价 → 行内毛利即时变化。
3. 点市场芯片切到美国 → 关税未配时横幅列出缺哪几个 HS；「关税率…」录入 `5806` `6%` → 毛利率出现。
4. 填完期间费用后看「经营净利」是否等于月商品毛利减费用；漏填退货时数字前出现 `≤`。
5. 展开「选品建议」→ 徽标报条数，列表里能点出「换市场 / 补税率 / 亏损 / 薄利」。

## 11. 已知边界

| 边界 | 现状 | 下一步 |
|---|---|---|
| 佣金只有一个比例 | `SkuCostEntry.commission` 是单值，亚马逊那种「佣金 + 固定成交费」放不下 | 需要时加固定费字段，或按渠道拆佣金结构 |
| 渠道只有三档 | 国内批发 0% / 亚马逊美国 15% + $39.99 / B2B 出口 FOB 0% | 渠道即费率，新增渠道只改 `service.CHANNELS` 一张表 |
| 原产地写死中国 | 关税查询按中国出口口径取，优惠税率只登记不参与计算 | 「本批有原产地证」开关 + 优惠税率参与计算 |
| 日本 / 澳洲 / 香港不自动取数 | 返回官网链接，人工填 | 有稳定机读接口再接 |
| 「本月销售额」是估算 | 售价 × 预估月销，页面标「按预估月销」 | 接订单模块后换成实际成交额 |
| 逐笔订单汇率 | 不在本模块 | 订单模块按单登记，台账只做月度参考 |

## 12. 模块清单（按文件读代码）

改动集中在 12 个文件、约 5700 行，读代码建议按下面顺序：先 `market → service`（口径），再 `store → api`（数据与接口），最后前端。

| 文件 | 行数 | 职责 | 读它的理由 |
|---|---|---|---|
| `workbench/sku/__init__.py` | 14 | 域包门面，导出对外符号 | 看清模块边界 |
| `workbench/sku/market.py` | 108 | 6 个出口市场、各自币种、`supported` 标记 | 「市场」这个词在这里被定义，中国内地不参与比价 |
| `workbench/sku/service.py` | 712 | **纯函数核算**：到岸成本、商品毛利、保本价、四类建议；不碰数据库 | 全部算术都在这，可直接单测 |
| `workbench/sku/store.py` | 775 | 数据库读写：整份状态装配、patch 落库、清单/成本导入、期间费用、设置、汇率快照 | 表结构与「0 vs 空白」在这落地 |
| `workbench/sku/api.py` | 400 | 14 条 HTTP 接口、`ok/error_code` 契约、JSON 体校验 | 前端只认这里的返回 |
| `workbench/sku/fx.py` | 208 | 三源并行取汇率、取中位数、偏离校验、断网回退上次快照 | 「缓存的汇率」从哪来 |
| `workbench/sku/duty_lookup.py` | 726 | 按 HS 向 USITC / UK Trade Tariff / TARIC 查基础税与附加税 | 自动取税率只覆盖美英欧 |
| `workbench/sku/catalog.py` | 108 | 商品清单 CSV 解析、官网后台推送 | 清单为什么能重建 |
| `workbench/templates/workbench/products.html` | 340 | 页面骨架：统计条、市场条、14 列表格、期间费用、选品建议 | 一眼看清页面由哪几块拼成 |
| `workbench/static/workbench/sku-ledger.js` | 1372 | 交互层：`applyState` 全量渲染、自动保存、筛选、税率弹窗 | 改 DOM 与保存的时序都在这 |
| `workbench/static/workbench/sku-ledger.css` | 640 | 台账表格、市场芯片、折叠区样式 | 样式名与模板一一对应 |
| `workbench/tests/test_sku_ledger.py` | 312 | 15 条回归：黄金数字、口径、导出、建议 | 改算法先跑它 |

一次请求的数据流：

```
浏览器 GET /api/sku
  → sku/api.py::library
    → store.load_state()      读 7 张表 + 汇率快照（过期才刷新）
    → service.compute()       逐 SKU 算到岸成本 / 毛利 / 保本价
    → service.advice()        跨市场比价，产出四类建议
  ← 一份完整 state（设置 + 市场条 + 14 列行 + 统计 + 期间费用 + 关税缺口）
浏览器渲染 ← sku-ledger.js::applyState(state)
```

写操作走同一条路：`POST /api/sku/rows` → `store.save_cost_patch()` 落库 → **重算整份 state 返回**，前端局部替换，不整页刷新。所以「自动保存」不会打断光标，也不会出现只更新一格、合计没跟着变的情况。

想在桌面版里看效果：双击桌面「织贸助手（桌面版）」→ 左侧「商品」→「产品资料」，首屏就是这份台账。

## 13. 产品资料库下线（迁移 `0027`）

台账上线时产品资料库还留着（只是没有页面）。本次把它整块删掉，`/products` 从此只有台账。

| 删了什么 | 说明 |
|---|---|
| `Product` / `ProductRevision` / `ProductBatch` 三个模型 | 换成一个 `BatchItem`（批次产品行），只保留 sku / 名称 / 品类 / 材质 / 尺寸 / 颜色 / 图片 / 缺字段 |
| 表 `workbench_product`、`workbench_productrevision` | 迁移会先把旧行复制进 `workbench_batchitem` 再删表 |
| `workbench/products/`（查询 / 还原 / 版本） | 连同 `/api/product-library`、`/api/products/<id>/revisions`、`fact-restoration` 一起移除 |
| 候选 → 产品应用 | `workbench/intake/product_application.py` 与 `/api/intake/candidates/<id>/apply` |
| 版本评审链 | `workflows/fact_application.py`、`reviews.py`、`review_images.py`、`validation.py`，以及对应的人审提交 / 补图 / 应用接口 |
| 旧命令 | `backfill_product_revisions`、`migrate_legacy_sqlite` |

**保留的**：任务、批次、上传文件、Agent 编排、交付物生成、订单 / 客户 / 物料 / 采购 / 生产要求 / ERPNext / intake 解析。

**功能口径的变化**（改算法或写测试前必读）：

1. 不再有「产品版本」概念：一次修改直接写 `BatchItem`，没有草稿 / 已确认状态，也没有字段来源。
2. 交付物不再要求「全批次当前版本已确认 + 英文名齐全」：只要批次已确认、两个子任务完成、没有未决人审，且每行字段齐全、有批次图片，就能生成。目录标题按「英文名 → 中文名 → SKU」取第一个非空值。
3. 人审事项不再产生：`HumanReview` 表仍在（交付前仍会拦未决项），但页面与接口不再新建评审。
4. Agent 拿到的「当前版本」是 `BatchItem` 的只读投影（`version=1`、`status=confirmed`），只为兼容既有工具契约，不代表真实版本。

迁移前后核对：

```sql
select to_regclass('workbench_product'), to_regclass('workbench_productrevision');  -- 均应为 NULL
select count(*) from workbench_batchitem;                                           -- 与旧 Product 行数一致
```

## 14. UN Comtrade 需求侧（迁移 `0028`）

### 14.1 为什么接

台账只回答「哪里卖更赚」，不知道「那个市场到底有没有量」。毛利 40% 但一年只进口 50 万美元的市场，换过去只是把库存挪个地方。Comtrade 补的正是这一半：**HS6 × 国家 × 年份的进口额**。

两边都只出事实、不出决策：进口额是需求侧事实，毛利是成本侧事实，混在一个数里就没人说得清哪部分是假设。

### 14.2 走哪个端点

`public/v1/preview/C/A/HS`，**免 key**。限制是「一次 1 个 cmdCode、1 个 period、500 行」，但 `reporterCode` 和 `partnerCode` 支持逗号多值，正好匹配「一个 HS6 × 一个年份 × 多个报告国」的查询形状：

```
GET /public/v1/preview/C/A/HS
  ?reporterCode=842,276,251,380,724,528,826,392,36,344
  &period=2025
  &partnerCode=0,156
  &cmdCode=580632
  &flowCode=M
```

一次请求就拿到 10 个报告国 × 2 个伙伴（世界合计 + 中国）。14 个编码 × 3 年 = **42 次请求**，免费档 500 次/天绰绰有余。

填了 `api_key` 才走 `/data/v1/get/C/A/HS`：可以一次多编码多年份。key 存 `SkuTradeSetting`（单例），接口只回 `has_key`，**不回 key 本身，也不写进日志**。

### 14.3 市场 → 报告国

| 市场 | reporterCode | 说明 |
|---|---|---|
| 美国 | 842 | |
| 欧盟 | 276 / 251 / 380 / 724 / 528 | **德法意西荷五国合计**。Comtrade 里没有「EU 作为进口国」的年度商品数据，表头显示「EU」、tooltip 写清是五国。法国是 **251**——250 在 M49 里是「France, Monaco」历史条目，[Reporters.json](https://comtradeapi.un.org/files/v1/app/reference/Reporters.json) 里没有它，查回来恒为 0 行 |
| 英国 | 826 | 脱欧后单独报告 |
| 日本 | 392 | |
| 澳大利亚 | 36 | |
| 中国香港 | 344 | 转口港，数字含转口，看趋势比看绝对值可靠 |
| 中国内地 | 156 | 本地市场，不进出口比较 |

伙伴侧只用两个：`0`（World，市场容量）和 `156`（中国，份额）。

### 14.4 数据模型

| 表 | 作用 |
|---|---|
| `SkuTradeSnapshot` | 一条观测：`hs6 × reporter × partner × flow × period` 唯一，存 `primary_value`（美元）、`net_wgt`（kg）、`qty` |
| `SkuTradeRun` | 同步流水。`failed` 记的是**哪个编码哪一年失败了**，不是计数——只知道「失败 3 个」等于没记 |
| `SkuTradeSetting` | 单例：`api_key`、`lookback_years`（默认 3） |

只存原始观测，不存推导值。份额、增速、单价带都是「同一批行怎么算」，口径改的时候不用回写全表。

### 14.5 指标口径

| 指标 | 算法 | 用途 |
|---|---|---|
| 市场容量 | 该市场所有成员国 `partner=0` 的 `primary_value` 之和 | 这就是「需求量」 |
| 中国份额 | `partner=156` ÷ `partner=0` | 高 = 渠道成熟但价格战，低 = 待开发 |
| 同比 | 最新有值年份 vs 上一个有值年份 | 连续下滑的市场降权 |
| 单价带 | `primary_value ÷ net_wgt`（USD/kg） | 和 FOB 单价对比，看报价有没有空间 |
| 分档 | ≥ 3 亿「大」、2000 万–3 亿「中」、< 2000 万「小」、0「无进口」 | 排序与配色 |

三个必须守住的口径：

1. **没同步 ≠ 没进口**。`market_metrics` 返回 `None` 表示没数据（页面写「未同步」），返回 `level="none"` 才是「查过了，真没有」。
2. **只看有值的年份**。某年上报但值为 0 的，不能当「最近一年」，否则同比会算成 -100%。
3. **净重缺失不算单价**。澳大利亚等市场部分年份没报 `netWgt`，此时 `unit_price=None`，页面显示「—」，不拿 `qty` 凑。

### 14.6 HS 编码从哪来

按优先级合并两个来源：

1. `SkuCostEntry.hs_code`——逐 SKU 人工填的，能算「覆盖几个 SKU」；
2. `SkuDutyRate.hs_prefix`——关税表里配过的编码。台账里 HS 还没填但关税表有，说明这批货确实按这个编码出口，**不能因为前者空着就判定「没有商品」**。这类编码 `sku_count=0`，页面标「关税表」徽章。

规范化：去非数字取前 6 位（`5806.32` / `5806321010` → `580632`）。不足 6 位的返回 `None` 并进 `invalid` 列表——4 位是章级别，查回来是整章的贸易额，和具体商品没关系。

### 14.7 同步策略

分批：`POST /api/trade/sync {offset, max_calls}` 一次只跑 `max_calls` 组（默认 6），返回 `next_offset` 与 `done`，前端循环到 `done`。

不在服务端一次拉完的原因很实在：42 次上游请求按 1 次/秒节流要 40 秒以上，同步视图必然超时，中间也没有进度可显示。

- 全局串行 + 1.05 秒最小间隔（免费档 1 次/秒，留余量）；
- 429 / 5xx 重试 2 次，指数退避；401/403 不重试（key 无效重试多少次都一样）；
- 写库用 `bulk_create(update_conflicts=True)` 按唯一键覆盖，**不先删后插**：中途失败时旧数据还在，页面不会突然白掉。

### 14.8 已知边界

1. **数据滞后 1–2 年**：默认从「今年 - 1」开始回看，页面上所有数字都标 `source_year`。
2. **欧盟不是单一报告方**：五国合计，不含其余 22 国，绝对值偏低但趋势可用。
3. **转口国重复计算**：香港、新加坡的进口额里含转口，不把它们的数字加到别的市场里。
4. **HS 版本漂移**：固定按 `clCode=HS`（报告国申报版本），不混用 H5/H6 做跨年比较。
5. **preview 500 行上限**：当前查询形状（10 报告国 × 2 伙伴最多 20 行）碰不到；真要超了会打 warning 日志。

### 14.9 实测记录（2026-11-27，HS 580632）

| 市场 | 2025 进口额 | 同比 | 中国占比 | 单价带 |
|---|---|---|---|---|
| 美国 | 2.48 亿美元 | -5.2% | 11.1% | 8.09 USD/kg |
| 欧盟（五国） | 1.99 亿美元 | +18.0% | 25.5% | 9.66 USD/kg |
| 中国香港 | 4191 万美元 | +6.3% | 81.7% | 15.83 USD/kg |
| 日本 | 3572 万美元 | -1.6% | 46.3% | 6.70 USD/kg |
| 英国 | 3222 万美元 | +10.5% | 37.8% | 10.12 USD/kg |
| 澳大利亚 | 1390 万美元 | -2.3% | 55.7% | —（净重缺失） |

一次同步写入 54 行（3 年 × 18 行），零失败。

迁移核对：

```sql
select count(*) from workbench_skutradesnapshot;   -- 观测行数
select hs6, reporter_code, partner_code, period, primary_value
  from workbench_skutradesnapshot order by period desc limit 10;
select count(*) from workbench_skutradesetting;    -- 应为 1
```
