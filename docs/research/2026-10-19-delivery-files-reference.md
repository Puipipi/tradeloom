# 交付文件、版本与下载链路研究

日期：2026-10-19  
范围：Task 14/15/19/20 设计准备阶段的只读代码与计划调查；本文完成时未修改生产代码、测试或数据库。随后实施情况见 `.superpowers/sdd/2026-10-18-multi-agent-workbench/plans/task14-15-files.md` 与同目录 `reports/task14-15-files.md`。

## 计划目标

- Task 14 的原计划要求生成英文目录 HTML/Markdown 与样品清单 CSV/JSON；缺英文名抛 `EnglishNameRequired` 并经已有 HumanReview 接缝处理，禁止自动翻译；生成时固化 ProductRevision 快照 JSON。实施时确认不能由交付服务伪造无来源审核候选：正常 needs_human 由现有角色路径形成；saved-ready 与冻结来源冲突时交付服务安全拒绝。
- Task 15 增加确定性质检、产物版本、SHA256、来源快照、批准/驳回及端到端流程；根目录配置默认 `data/runtime/artifacts`。
- Task 19 展示版本和质检、HTML/Markdown 预览、CSV/JSON 真实下载与批准/驳回。
- Task 20 补全英文内容提示、缺英文名审核回环、驳回后生成新版本、旧版本只读，并提供文件名和 Content-Disposition。
- 总计划要求 ArtifactVersion 持有生成时不可变 ProductRevision 快照；后续产品变更不能改写旧交付文件。Task14–20 具体文案和业务内容仍应按已确认规格实现，不从本笔记推断新字段标签或翻译。

## 当前实现中可复用的接缝

- `Artifact`/`ArtifactVersion` 已有持久化模型。Artifact 含 WorkflowTask 归属、`artifact_type`、`storage_key`、`current_version`、`status`；版本含整数 `version`、`file_path`、`sha256`、`source_product_versions`、JSON `snapshot`、`status` 与时间戳，且 `(artifact, version)` 有唯一约束。可承载版本元数据，无须为基本版本号另建表。
- `ProductRevision` 以每产品最大 `version` 表示当前版本，`snapshot` 不可经模型 save、QuerySet.update 或 bulk_update 改写。快照构造/确认复用 `workbench.products.versions`；其中 `snapshot_from_product()` 当前仅包含 legacy 七字段，生成器要读取已确认的 `ProductRevision.snapshot` 才能保留 `english_name` 等批准字段。ArtifactVersion 的 `source_product_versions` 与 `snapshot` 可记来源 ID/版本和值，但字段具体序列化契约仍需定案。
- `DeliveryQualityAgent` 明确仅检查 full_batch 的数据就绪，输出 `artifacts_generated=false`、`artifact_quality=not_evaluated`，仅给 `generation_intent`；其工具集没有生成/写文件能力。工作流完成门禁当前要求真实文件质检，不能把 Agent 计划/意图当成生成或文件 QA 结果。
- 旧 CSV 生成可复用 `CSV_FIELDS`、`csv.DictWriter` 和 `WorkbenchService.export_csv()` 的 UTF-8 文本逻辑。现有 API 把文本编码后返回 `HttpResponse`，固定附件名 `products.csv`；它不写 ArtifactVersion，也不表示新四种交付物已经实现。
- 文件上传目前在 `WorkbenchService._store_file()` 对 `MEDIA_ROOT` 做路径拼接与 `write_bytes()`，DB 记录保存 TaskFile stored name。设置中 `MEDIA_ROOT` 可配置；项目中暂未发现 `FileSystemStorage`、`default_storage` 或 `FileResponse` 用法。交付存储可以借鉴“配置根目录+数据库相对路径”的现有形态，但需单独决定是否采用 Django Storage 以获得安全路径处理与可替换后端。
- 交付物页面目前只读列出 Artifact 的类型、当前版本、状态、批次和更新时间；模板默认 HTML 自动转义。还没有版本查询、文件预览/下载路由或审核操作。旧 CSV 下载路径只说明项目已有附件响应约定。

## 与生成、存储、幂等和下载相关的官方参考

- Django 5.2 [FileResponse](https://docs.djangoproject.com/en/5.2/ref/request-response/#fileresponse-objects)：适合从已打开的二进制文件返回附件/文件响应，可设置下载文件名；下载端应只打开已登记版本的受控路径。是否直接采用它取决于最终响应接口。
- Django 5.2 [FileSystemStorage](https://docs.djangoproject.com/en/5.2/ref/files/storage/#the-filesystemstorage-class)：提供基于文件系统的保存/读取接口，并处理存储名冲突。若配置 `TRADELOOM_ARTIFACT_ROOT`，需明确与 Django `STORAGES`、`MEDIA_ROOT` 的关系，不应让绝对文件路径作为用户输入。
- Python [csv](https://docs.python.org/3/library/csv.html)：标准库 `DictWriter` 与 `newline=""` 可复用既有 CSV 导出做法；固定字段顺序、编码与行终止符应由已批准接口约束。
- Python [html.escape](https://docs.python.org/3/library/html.html#html.escape)：动态文本插入 HTML 时可转义 HTML 特殊字符；Django 模板也默认转义普通变量。生成静态 HTML 不经过模板时需显式转义值，避免把产品内容当 HTML。

这些参考只支持相应技术机制，不决定文件命名、HTML/CSS结构、业务字段标签、版本策略或审批权限。

## 现有不足与需主控最少定案项

为避免生成层与下载/审批 UI 各自发明契约，建议主控明确以下接口边界后再进入写实现阶段：

1. **生成入口和范围**：由哪个服务/API/工作流步骤调用生成器；以 WorkflowTask 全批次还是批次 ID 作为入口；仅允许 confirmed 批次的条件如何沿用现有门禁。`DeliveryQualityAgent` 仍保持纯只读计算，写文件应由另一个明确的服务步骤负责。
2. **文件身份与版本规则**：四种 `artifact_type` 的稳定值/扩展名、一个批次每种类型一个 Artifact 的身份键、初版从 v1 递增、并发生成的锁与幂等键策略；失败时版本号是否只在完整文件写入并登记后占用。拒绝审核后再生成必须保留旧版并新增版本，旧版本元数据和字节只读。
3. **存储和失败原子性**：`TRADELOOM_ARTIFACT_ROOT` 的解析（相对路径相对 BASE_DIR 还是原样相对当前目录）、ArtifactVersion.file_path 存相对 storage key 还是绝对路径、写临时文件/最终命名、摘要计算时点、文件写成而 DB 事务失败或 DB 登记后文件缺失的修复/清理行为。数据库事务不能自动回滚普通文件系统写入；需确定一致性与重试策略，避免复用半成品文件。
4. **读取/响应接口**：页面预览和下载是否走同一版本详情端点、如何指定版本、附件文件名规则/ASCII 与非 ASCII 文件名编码、HTML 预览的隔离/转义策略，以及审批动作路由和状态转换。仅对 ArtifactVersion 记录解析出的文件开放读取，路径不能由请求任意指定。
5. **质检与审批含义**：四类文件分别有哪些确定性检查、错误与警告如何表示、哪个状态能批准/驳回、批准/驳回是否要求 reviewer 标识或鉴权、驳回对当前版本/Artifact 状态的影响。当前页面只读且既有 `HumanReview` 是业务事实说明回执，不能直接推定它就是交付审批记录。
6. **验收边界**：Task 15 要覆盖的端到端状态序列及何时允许 WorkflowTask completed；Task 19/20 页面/API smoke 的真实用户动作、下载字节/文件名断言和失败情形。生成缺英文名时应新增何种 review_key/item_ref/question/options，以及处理回执后如何恢复，需接上既有审核契约，不由生成器自动翻译或猜用户答案。

除上述边界外，字段标签、英文内容、英文名处理规则继续遵循已定规格与用户访谈结果；本研究不新增业务规则。现阶段不修改 Agent 的角色、只读权限或 `supports_safe_retry` 声明。
