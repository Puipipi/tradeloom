# Excel 业务资料接入：领域设计草案

历史设计方案（2026-10-21），不是当前功能清单；实际实现进度以对应验收记录为准。本文记录当时提出的接入设计与边界，不能单独作为当前功能状态说明。业务语义须按来源与授权情况逐项核实；未确认的语义继续保持未知，不阻塞来源归档、预览和 typed staging。

## 设计目标

把用户提供的工作簿作为不可变来源版本保存，允许查看解析预览、有限的结构化候选与逐字段来源；只有明确确认的映射才进入现有产品版本链或后续明确的业务对象。不能按工作簿数量建一一对应的业务模块，也不能把所有内容放进任意键值事实表。系统不得自动把名称、规格、序号或颜色当成跨表身份键。

## 结构核对结论与限制

设计依据包括多种业务工作簿类型的只读结构检查。公开设计仅保留可复用的结构性结论，不发布真实文件中的坐标、字段原文、行列计数、计算表达式、图片关系或逐表匹配结果。结构检查表明，来源工作簿可能包含多层表头、合并单元格、公式及缓存值、图片/富值元数据、空缺和错误值；这些特征必须在预览与来源快照中保留。

表面相似的名称、规格、颜色、编号或序号不足以证明跨表身份相同。公式只能表达文件内的计算关系，不能证明其业务定义、币种/单位、批准状态或已成交状态。合同、价格、生产指令和工时资料中的角色、方向、计量口径及关联关系必须由业务方确认；没有确认的语义继续保持未知。
## 复用现有对象的边界

- `Task` 可承载处理任务；`TaskFile` 目前是 task 关联的普通附件行，不含内容哈希/解析版本，不能单独承担不可变来源版本库。
- `Product` 是既有商品主记录；`ProductRevision` 保存不可变 `snapshot`、`field_sources`、状态和 `source_refs`，适合承接已确认的产品事实。映射确认后应复用现有版本/审阅应用路径，并为来源引用增加 intake source version、sheet/range 和映射版本；不能直接覆盖旧 revision。
- 现有产品上传入口 `/api/tasks` 只接收 `products_csv` 和图片；`WorkbenchService.parse_csv()` 需要固定 SKU、名称、品类、材质、尺寸、颜色、图片文件名表头。它不是 XLSX 原件接收或多层表头解析入口。
- `workbench/erpnext/service.py` 的七类读取器覆盖 Item、Customer、Supplier、Warehouse、Bin、Sales Order、Purchase Order；它不建模这些来源工作簿。Item 条码是子表读取。受限 Quotation 草稿 operation 也不等同合同、生产指令或工时对象。

## 推荐接法：来源版本层 + 有限类型候选 staging

这是来源先行、业务事实后确认的窄层，不扩成通用 ETL 平台。

1. `IntakeSourceVersion`：只追加的文件版本，存随机私有存储键、原始文件名（只作私有 UI 展示）、SHA-256、长度、类型、接收时间及来源状态。使用单独的 `TRADELOOM_INTAKE_ROOT` 私有存储根，放在 `MEDIA_ROOT`、静态目录和仓库之外；当前开发配置会通过媒体 URL 暴露 `MEDIA_ROOT`，所以不能把原件放在普通上传目录。下载走带范围校验的 Django endpoint，不暴露物理路径。精确哈希重复上传复用来源版本并留下新的接收记录或回执，不覆写原件。
2. `WorkbookSnapshot` 与 `WorkbookSheetSnapshot`：每次解析独立记录 `parser_version`、完成/失败状态、sheet 序号/标题、有效维度、合并范围、公式/图像锚点数量与安全警告。重解析新增 snapshot，不改写旧解析。
3. `SourceCellSnapshot`：按来源 snapshot、sheet 序号及坐标唯一定位；存显式单元格类型、原值的类型化 JSON、公式文本、上次保存的缓存值、number format 和公式引用坐标。公式与缓存并存、缺失缓存显式标记；不运行公式、不把缓存伪装成复算结果。原 XLSX 始终是最终原件证据。
4. `IntakePreview`/`MappingRevision`：不可变版本化字段映射；记录来源 cell/range、候选规范字段、置信/冲突原因及确认状态。候选类别限定为 `product_identity`、`commercial_source`、`production_instruction`、`labor_analysis` 等有版本的枚举。每种类别必须有独立严格 schema/字段白名单；拒绝任意字段键和值，不创建通用事实仓库。当前语义未确认的候选保持待映射或歧义状态。
5. `IntakeCandidateLink`：保留来源/目标 candidate 间的候选关联、方法（例如 exact normalized）、匹配数量、证据坐标、状态（suggested/confirmed/rejected）和确认映射版本。任何非唯一、仅描述/规格/序号匹配的记录只显示冲突或候选，不自动合并。

### 上传到确认的闭环

1. `POST /api/intake/sources`：same-origin + 现有 CSRF 保护，先校验文件名、XLSX MIME/ZIP 结构、单文件/解压尺寸、条目数、sheet/cell 上限；计算 SHA 后写入私有存储。格式/大小错误在落库前拒绝；保存中断清理未引用的临时对象。
2. `POST /api/intake/sources/{id}/previews`：用固定解析器版本解析；每个 source+parser version 幂等。分别读取公式视图与缓存视图，并按 sheet/cell 对齐。禁止 `Workbook.save()` 覆写源、执行宏、重算公式或跟随外部链接。多层表头以原合并区和坐标展示，启发式字段映射只标为建议。保留单元格错误值及其富值/图片元数据关系、普通浮动图片的锚点与关系；不能将其扁平化为空值、删除或改写原件。
3. `GET /api/intake/previews/{id}`：返回 sheet 结构、字段映射候选、重复/缺项/类型异常和有限行预览；敏感列按现有本地工作台信任边界处理，错误消息不复制原单元格内容或异常堆栈。
4. 用户保存一个严格验证的 `MappingRevision` 后，解析成有限类型候选行，并保留每个字段对应的 `source_version + snapshot + sheet + cell/range`。重复候选、类型冲突、公式缓存缺失、无单位字段均须显式标记，不默认补值。
5. `GET /api/intake/candidates/{id}` 及只读 Agent tools 返回 typed candidate、来源引用、映射版本和状态；工具不上传、确认、修改 Product 或调用 ERP 写 API。按现有 shell `TOOL_ACCESS` 显式开通读取能力，未知角色默认拒绝。
6. 仅确认的 `product_identity` 可经现有产品 fact/review 应用路径写入 Product 并追加 ProductRevision；将 intake 引用放入 revision `source_refs`/字段来源。商业、生产、工时候选保留在各自 typed staging，待业务语义确认后再定义实体和事务。所有确认操作记录操作者来源（当前桌面信任域只能写 local_workbench，不冒称个人认证）及幂等操作回执。

### 安全、错误、幂等和可追溯性

- 原始文件不可从静态目录或当前通用媒体 URL 直出、不可覆盖、不可被解析器写回。内部路径从随机键派生，不使用用户提供路径；UI只返回 opaque source ID、安全文件名和摘要。
- 限制 ZIP bomb、格式伪装、超大工作簿、超多工作表/单元格/合并区/图片；不接受宏文件。外链只记录其存在，不请求网络。解析失败保留原件、创建 `failed` snapshot 与固定错误码/定位坐标，不重复自动解析。
- 上传幂等键/摘要冲突、重复行、重复产品键和跨表歧义分别报告；重试不会生成重复候选或覆盖已确认版本。mapping 确认以 preview id、mapping revision 和当前源哈希作为乐观条件，旧版本冲突需刷新。
- 每个字段都能回溯到原件 SHA、parser version、sheet/cell/range、原类型/公式/缓存以及确认映射版本。保留拒绝/歧义决定，支持撤销候选但不删除原件。

## 两种可行实现路线

| 路线 | 做法 | 适用性与风险 |
| --- | --- | --- |
| A. 来源版本 + typed staging（推荐） | 在现有 Django/PostgreSQL 中加上述窄来源/预览模型与解析服务；`ProductRevision` 仅承接确认事实 | 保留复杂合并表头、公式、缓存、图像锚点与 provenance；可先实现来源导入而不猜合同/价格/工时语义。需新增少量模型、迁移和专用 endpoint，但不改变 ERP 或既有 CSV 导入 |
| B. 先映射为 tabular dataset，再用模型资源导入 | 每种已确认模板写显式 parser/mapping，将 dry-run dataset 导入既有 ProductRevision 或未来的 domain model | 适合字段/身份键稳定、单层表头明确的资源。django-import-export 的 workflow 面向带 header 的 tablib dataset，并提供 dry-run、事务和逐行结果；当前多层/合并表头和公式原件不适合直接套用。不能替代原件保存与来源坐标，需先有路线 A 的预览/来源记录。 |

不推荐一开始给四本表各建一个业务表/Agent；也不推荐直接调用 django-import-export 对现有 Product 导入全部行。最佳顺序是路线 A 建好来源、解析、预览及 typed staging；确认稳定的产品候选后再用路线 B 的明确映射/现有版本服务写入。

## 验收门槛

- 公开自动化 fixture 与演示采用合成数据或经授权脱敏的 XLSX 样例；经授权真实资料在私有本地环境验证原件哈希、sheet/range、合并表头、图像锚点、公式文本与缓存的保留，并确认不触发外部网络、宏或重算，parser version 重跑不覆盖前版。
- 对尺寸/ZIP 限制、重复哈希上传幂等、坏文件安全错误、权限和私有下载隔离进行验证；公开 fixture 覆盖单元格内富值图片关系和普通浮动图片锚点。授权真实资料可在私有本地环境进一步核验原件哈希及来源回溯。
- 验证 preview 默认不创建 Product/ProductRevision/ERP 数据；字段来源精确回到 sheet/cell；重复/歧义匹配不会自动连边。
- 验证 mapping revision 并发/过期拒绝；只有确认的产品候选走现有 review/version 路径并追加 revision/source refs；候选来源与拒绝记录不丢。
- 测试所有基于 PostgreSQL；不得以 SQLite 的事务/锁行为代替正式并发验收。还需真实桌面上传、预览和辅助滚动的 GUI 验收；本设计本轮未实现，因此没有声称通过。

## 尚未确认的语义（不阻塞来源层）

业务语义仍有待确认：合同/价格资料的角色与商业性质、稳定产品身份及变体规则、工时数据类型和关联维度。实现来源、公式缓存和候选 staging 时应保留未知状态；不得把某类价格字段直接命名为当前销售价、从成本计价项推成员工实际工时、为汇率字段擅自指定币种对，或把包装、条码、序号当跨表身份键。

## 参考

- 现有代码：`workbench/models.py`（Task、TaskFile、Product、ProductRevision）；`workbench/products/versions.py`；`workbench/workflows/fact_application.py`；`workbench/api.py` 的 `/api/tasks` 与 `/api/product-library`；`workbench/services.py` 的 `parse_csv()`；`workbench/erpnext/service.py`。
- [openpyxl 官方教程](https://openpyxl.readthedocs.io/en/stable/tutorial.html)：解析阶段只读读取；当前样本需并行保留公式视图和缓存视图，不能保存回原件。
- [django-import-export 导入工作流](https://django-import-export.readthedocs.io/en/latest/import_workflow.html)：其 Resource 以带 header 的 tablib Dataset 为输入，提供 dry-run、错误/行结果与可选事务；用于稳定、已确认的映射，不作为复杂 XLSX 原件归档层，本项目当前不新增该依赖。
