# Excel 业务资料接入实现计划

> For agentic workers: REQUIRED SUB-SKILL: use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 在现有织贸工作台中安全接收四类 Excel 来源，提供可追溯预览、有限类型候选与确认后产品版本写入；合同、价格、生产和工时中未确认的业务含义继续留在 staging，不推断、不自动合并。

**架构：** Django/PostgreSQL 保存不可变来源版本、工作簿解析快照、逐单元格类型化证据和有限类型候选；原件进入独立私有 TRADELOOM_INTAKE_ROOT，不经过公开 MEDIA_ROOT。openpyxl 读取普通工作簿结构，标准库 ZIP/XML adapter 解析 OOXML richData 图片关联。mapping 与候选均版本化；仅明确确认的产品事实复用 Product/ProductRevision 和现有版本确认路径。用户从已有资料整理页面进入 intake 页面，不新造通用 ETL、Agent 或业务事实引擎。

**技术栈：** Django、PostgreSQL、openpyxl（正式依赖，约束为 openpyxl>=3.1,<4）、Python 标准库 zipfile/xml.etree.ElementTree；现有 CSRF、EventLog、产品版本服务、shell 同源 /business-api 代理和显式 TOOL_ACCESS。 不依赖 Codex bundled Python，不增加 django-import-export。

**设计依据：** docs/plans/2026-10-21-business-intake-design.md。本计划补充解析和实现验收细节。

**全局约束：**
- 只使用合成、脱敏 XLSX fixtures 进入仓库；四份实际原件、提取值、图片、匹配统计和私有分析留在非 Git intake 目录。原件不可覆写或公开下载。
- 不运行宏、外链、Excel 公式或重新计算。公式文本、保存的缓存值、错误值分别保留；空值不变成零，错误缓存不当作公式计算结果。
- 对 richData 使用 OOXML 标准关系逐层解析，不进行索引 +1/-1 猜配。无法证明关系完整时保留源并返回固定 warning。
- 不自动跨文件 join，不按款号、描述、规格、颜色、行号或条码推断统一产品身份；不把毛利价栏命名为当前售价，不把“实际用工价”解释为员工实报工时。
- 未确认的合同方向、价格性质、产品变体键和工时口径保持候选/待确认；“不知道”不是来源层开发的阻塞条件。
- 不把工作簿按文件拆成业务表，不建无类型万能事实仓库。候选必须有封闭 candidate_type、schema_version、字段白名单和逐字段来源。
- 所有状态变化使用现有本地桌面信任域并记录为 local_workbench，不伪造个人身份或 agent role。读工具只显式授权；Agent 不确认映射、不写产品、不调用 ERP 写入。
- 原始文件写入使用随机存储键、大小/MIME/ZIP 检查和事务化临时文件流程；服务报错不得回显路径、单元格敏感内容、堆栈或原始 XML。
- 正式并发/事务测试只用独立 PostgreSQL 测试数据库；不得连接业务数据库端口或用 SQLite 代替。
- 当前阶段不提交或推送。完成实现、验收和隐私自检后再按项目发布流程处理。

---

## 文件与接口规划

- requirements-workbench.txt：增加受约束的 openpyxl 正式运行依赖。
- config/settings.py、apps/tradeloom-launcher/cli.mjs：实际 Django 启动由 cli.mjs 中的 startDjango 通过 startOwnedChild 接收 djangoEnv。launcher 从现有 paths.dataRoot 派生 TRADELOOM_INTAKE_ROOT=<dataRoot>/private/intake，使用已有 ensureOwnedDirectory/reparse-ancestor/realpath 机制建立并校验来源目录，再显式传入 Django；不读取未过滤的同名外部 env。settings 只接受 launcher 给出的受控路径，解析时再次核对该路径位于 DataRoot 的 private/intake，且不等于或包含 MEDIA_ROOT/STATIC_ROOT。
- workbench/models.py、workbench/migrations/0005_intake_sources.py：IntakeSourceVersion、WorkbookSnapshot、WorkbookSheetSnapshot、SourceCellSnapshot、WorkbookImageReference。唯一键包括内容 SHA/source identity、parser version 和 sheet/cell 坐标；快照仅追加。
- workbench/models.py、workbench/migrations/0006_intake_staging.py：IntakeMappingRevision、IntakeCandidate、IntakeCandidateLink。候选有封闭类别/schema 版本、状态、typed payload、字段来源和显式匹配决定；链接只表示 suggested/confirmed/rejected，不隐含合并。
- workbench/intake/limits.py、workbench/intake/storage.py、workbench/intake/snapshots.py：纯 limits 模块不导入 ORM；store_source(upload) -> IntakeSourceVersion、open_source(source_id) -> BinaryIO、verify_source_root() -> Path；capture_snapshot(source) -> (WorkbookSnapshot, created)。私有路径只由随机存储键构造，来源快照只追加。
- workbench/intake/ooxml_richdata.py：read_richdata_images(archive) -> list[ImageReference]。定位链为 c/@vm → metadata 中的 XLRICHVALUE future metadata → 对应 richValue 的 _localImage/_rvRel:LocalImageIdentifier 槽 → richValueRel 的 r:id → 对应 .rels → media 部件。校验 OOXML namespace、槽索引、relationship ID、内部 target 和媒体类型；外链、缺项、重复或不一致关系只产固定分类 warning，不猜另一个索引。普通浮动图片由 openpyxl anchor 单独记录。
- workbench/intake/parser.py：parse_workbook(source) -> WorkbookEvidence，纯解析 DTO 不依赖 Django ORM；持久化由单独 snapshot service 完成。共享资源常量来自不导入 ORM/settings 的 limits.py。用两个以默认非 read_only 模式打开的 openpyxl 视图（data_only=False/True）读取单元格；另对已界定的 ZIP 部件使用标准库 XML 读取 raw cell lexeme、merge ranges、worksheet drawing 关系、drawing anchors 和 richData 关系。公式节点存在标记、公式属性和原始文本分别保存；缓存状态分成 missing、empty、present，present 的零和错误词法值保留；错误只按 OOXML error type 判断。读取 openpyxl 前累计合并区域面积，不超过 250,000 个单元格，避免巨大合并范围导致对象扩展。不得启用 read_only=True 后依赖它提供完整图片/合并信息；不得静默省略 XML 中存在但 openpyxl 不支持的关系。固定资源界限为：压缩文件 20 MiB、解压后总量 128 MiB、ZIP 部件 2,000、worksheet 20、非空单元格 250,000、合并面积 250,000、图片引用 100。越界拒绝解析但保留原件和安全失败快照。
- workbench/intake/schemas.py、workbench/intake/mapping.py：有限候选类型 product_identity、commercial_source、production_instruction、labor_analysis；每类使用独立严格 schema。validate_mapping(snapshot, payload) 校验源 hash、sheet/cell 范围和 schema version；build_candidates(mapping_revision) 只生成候选和异常，不跨来源自动合并。
- workbench/intake/api.py、workbench/urls.py：固定 JSON/multipart API，统一现有 requestRejection/同源和 CSRF 边界；不提供任意路径、文件名路径或任意表/字段查询。
- workbench/views.py、workbench/urls.py、workbench/templates/workbench/intake.html、workbench/static/workbench/intake.js、workbench/static/workbench/styles.css：资料整理入口及上传、工作表预览、映射、候选和 provenance 页面。内置状态/错误文案不包含原单元格值或绝对路径。
- packages/tradeloom-shell/business-tools.js、packages/tradeloom-shell/tests/business-tools.test.js：增加显式授权的只读 tradeloom_intake_sources 和 tradeloom_intake_candidate 工具；固定 Django 路径和 object schema，未知角色拒绝，不接受 URL/路径/写入参数。
- 测试文件：workbench/tests/test_intake_storage.py、test_intake_parser.py、test_intake_api.py、test_intake_mapping.py、test_intake_product_application.py、packages/tradeloom-shell/tests/business-tools.test.js、packages/tradeloom-shell/tests/capabilities.test.js。Shell intake-tool coverage lives in the existing business-tools suite; no separate `intake-tools.test.js` is present. All XLSX fixtures are synthetic and exclude the four real source workbooks.
- 用户可运行说明更新到 docs/agent-development.md 和 docs/quick-start.md（如确有必要），仅描述资料导入路径和限制，不写实际客户、价格、路径或业务推断。

## 任务 1：私有来源归档和可追溯 XLSX 快照

**文件：** requirements-workbench.txt、config/settings.py、apps/tradeloom-launcher/{core.mjs,cli.mjs} 及其现有相关测试、workbench/models.py、workbench/migrations/0005_intake_sources.py、workbench/intake/{__init__.py,limits.py,storage.py,snapshots.py,parser.py,ooxml_richdata.py}、workbench/tests/test_intake_storage.py、workbench/tests/test_intake_parser.py。

- [ ] 在独立 TRADELOOM_INTAKE_ROOT 下实现随机 key 私有归档。上传按大小、XLSX 扩展名及 ZIP 中央目录/内容结构预检；操作系统给出的 generic MIME 不构成拒绝理由。原件先写同目录临时文件、计算 SHA-256、fsync 后原子重命名，数据库唯一冲突清理未引用临时对象。重复 SHA 返回已有不可变来源版本；不得原地覆盖。
- [ ] 配置与启动验证确保 intake root 是 owned DataRoot 私有子目录，解析后 realpath 仍位于该 root；不能被 Django static/media URL 映射。未配置 root 时 intake 上传明确不可用，不回退到项目目录或通用媒体目录。
- [ ] 建立来源版本和解析快照模型：记录内容 hash、大小、格式、接收时间、解析器版本、sheet index/name/dimensions/merged ranges；逐 cell 存显式单元格类型、原值的类型化 JSON、公式文本、上次保存的缓存值、number format 和错误分类。source/snapshot/cell 均有稳定唯一约束和追加式版本关系。
- [ ] 使用 openpyxl 普通工作簿双视图读取公式与缓存，缓存节点缺失、空节点和有值节点明确区分；用有界 OOXML reader 获取原始 XML cell type/数值词法文本、shared/inline string 语义、合并范围和 drawing anchors。存储字段明确区分 source raw lexeme 与 openpyxl 规范化值，不能把 Excel 日期 serial 转换结果标作原始值。公式错误值只按 OOXML error 类型识别；字符串结果以 `#` 开头不自动视作错误。合并面积在 openpyxl 加载前有界。公式错误值不得被推导成零；外部、结构化、命名或无法可靠解析的公式引用只保留公式文本并标 unsupported，不用正则猜依赖。
- [ ] 建立 OOXML richData reader：从 worksheet cell 的 c/@vm 精确关联 metadata 中的 valueMetadata/futureMetadata 项，再到对应 richValue/_localImage 结构的 _rvRel:LocalImageIdentifier 槽、richValueRel 中的 r:id、relationships 中的内部 target 和 media 部件；严格按规范索引层级解析，禁止 +1/-1 重试或按媒体顺序猜图。另由 worksheet/drawing relationship 解析浮动图片 anchors。四张 cell 图片和一张浮动图片都使用仅含合成像素的 fixture；普通无 vm 的公式 #VALUE! 单独作为算术错误 fixture。断链、外部 target、缺 media 和未知结构各返回固定 warning 并保留原始单元格证据。
- [ ] 测试压缩/解压大小、部件数、sheet/cell/image 上限；坏 ZIP/伪 MIME、宏扩展、外部链接拒绝或固定警告；重复上传幂等；上传/解析前后原件 SHA 完全相同。对源目录做越界/符号链接路径拒绝测试。
- [ ] 用现有隔离 runner 执行唯一 CLI：node <TRADELOOM_HARNESS_ROOT>/local-dev/django-phase2-test-runner-20261021-01/run-django-tests.mjs test --test-db tradeloom_test_intake_task1_<unique> workbench.tests.test_intake_storage workbench.tests.test_intake_parser。runner 的 check/test 参数和 55435 专用集群已实际核验；每次测试都换不存在的新 test DB 名，keepdb 数据保留，不连业务端口。预期：仅合成工作簿；raw/normalized 值、公式/缓存、四条 richData 关系、普通 drawing 图片和无 vm 错误 cell 逐项可定位，原件不可变，超过边界安全失败；不产生 Product 或 ERP operation。

## 任务 2：严格映射、typed staging 与预览 API/UI

**文件：** workbench/models.py、0006_intake_staging.py、workbench/intake/schemas.py、workbench/intake/mapping.py、workbench/intake/api.py、workbench/urls.py、workbench/views.py、intake template/JS/CSS、workbench/tests/test_intake_api.py、test_intake_mapping.py。

- [ ] 建立不可变 IntakeMappingRevision 和 typed IntakeCandidate。schema 采用 additionalProperties=false 等价的服务器端字段白名单；拒绝未知类别、版本、字段名、数据类型及超出来源 snapshot 的坐标。payload 是四类有界结构化候选，不存任意事实字典。
- [ ] 实现固定接口：POST /api/intake/sources（multipart 原件）；GET /api/intake/sources（仅安全元数据）；POST /api/intake/sources/<id>/previews（按 parser version 幂等）；GET /api/intake/previews/<id>（有界分页/行窗口）；POST /api/intake/previews/<id>/mappings；POST /api/intake/mappings/<id>/candidates；GET /api/intake/candidates；GET /api/intake/candidates/<id>；GET /api/intake/sources/<id>/download（授权后作为 attachment 流式响应，绝不返回磁盘路径）。
- [ ] POST 类操作以 Idempotency-Key 和源 SHA/schema version 做唯一条件；同键同 payload 回原 operation/result，同键不同 payload 返回 409。mapping 以 preview ID + 当前 source hash + mapping revision 做乐观条件；旧版本返回 conflict，不覆盖。
- [ ] 预览清晰显示合并区域、公式文本/缓存是否存在、公式错误分类、rich-data/floating image anchor、外部/损坏关联警告。按用户确认的语义只建议映射，不将推测 label 变成事实；空值、零值、错误值分开展示。
- [ ] candidate link 仅按配置方法产生 suggested 关联并显示证据/冲突；本阶段禁止自动把不同源 candidate 合并。相同产品描述、规格、行号、条码均不能作为默认 join key。
- [ ] 页面复用已有资料整理 /artifacts 入口，不改 shell 路由/Agent 顶部选择器。所有 mutation 使用现有 CSRF token 与同源 API；附件下载须有 permission gate，错误不回显路径/源文件内容。
- [ ] EventLog 仅记录 actor=local_workbench、opaque source/snapshot/mapping/candidate IDs、动作类型及计数/状态；不写单元格原值、商业文件名、路径或异常原文。无 workflow ID 时不伪造 Task/Workflow。
- [ ] 合成 API 测试：未配置 private root、非同源/CSRF、无权限下载、重复 SHA/key、幂等冲突、过期 mapping、坏坐标、未知字段类别、重复/歧义关联、失败 snapshot、无公式缓存、raw error 不泄露。preview/staging 前后 Product/ProductRevision/ERP 行数保持不变。
- [ ] 使用新隔离 PostgreSQL 数据库运行：node <TRADELOOM_HARNESS_ROOT>/local-dev/django-phase2-test-runner-20261021-01/run-django-tests.mjs test --test-db <fresh-unique-db> workbench.tests.test_intake_api workbench.tests.test_intake_mapping。预期所有 API 返回固定 DTO 与 provenance，旧版、同 payload 重放、未知字段及歧义决定有明确且可重复状态；没有自动商品合并或外部请求。

## 任务 3：只读 Agent 查询和已有场景中的资料整理 UI

**文件：** packages/tradeloom-shell/business-tools.js、packages/tradeloom-shell/tests/business-tools.test.js、packages/tradeloom-shell/tests/capabilities.test.js、workbench/intake/api.py。 The intake page and preview UI are implemented under Task 2b; their source is accepted while GUI verification remains pending.

- [x] 提供固定只读工具 tradeloom_intake_sources 与 tradeloom_intake_candidate。工具参数只含 source/candidate opaque ID、分页 cursor/页大小；严格 object schema，禁止任意 URL、路径、字段展开、确认和写入。
- [x] 按现有 shell role/preset 权限显式授权；未知 role、非授权 role、未知/伪造 ID 均 fail closed。工具只经现有 /business-api 代理访问 Django，不绕过同源、requestRejection 或 CSRF；Agent 结果不包含原始工作簿 blob、凭据、服务器路径或完整自由文本单元格值。
- [x] 查询结果包含 bounded source/snapshot/candidate 状态、字段来源坐标、匹配/冲突决定及截断标记；状态不确定时显示 unknown/incomplete，不把缺失数据显示为无数据。
- [x] 在既有资料整理入口提供来源列表、解析预览、字段映射与候选 provenance；维护解析版本、来源 SHA 和映射状态提示。列表和 cell window 有明确上限，窄屏可滚动，不横向撑开主工作区。源代码已由 Task 2b 接受；GUI 验证仍待完成。
- [x] Node 合约测试使用真实 pinned ToolRuntime/serializer 验证 schema object、固定路径、role allowlist 和不产生通用 URL；能力视图测试验证注册工具能被当前 Agent 的现有能力面板发现。PostgreSQL 测试验证来源分页 DTO。测试确认未增加写工具或业务事实变更。
- [x] 执行 `node --test packages/tradeloom-shell/tests/business-tools.test.js packages/tradeloom-shell/tests/capabilities.test.js`（设置已验证 `TRADELOOM_DSH_TOOLS_LIBRARY`）；再用 guarded runner 和全新 PostgreSQL test DB 执行来源分页用例。完整证据与范围限制记入 implementation progress。没有运行完整 `test_intake_api` / `test_intake_mapping`，因为 Task 3 只改了 source-list pagination 接缝；此前 Task 2a/2b 后端 suites 有自己的独立证据。

## 任务 4：确认产品事实写入和四份真实来源本地验收

**文件：** workbench/intake/application.py、workbench/products/versions.py（仅在现有 helper 不足时追加窄接缝）、workbench/intake/api.py、workbench/tests/test_intake_product_application.py、intake UI，以及非 Git 的本地验收证据目录。

- [ ] 仅 product_identity candidate 可申请写入既有 Product 版本；商业、生产指令、工时候选没有 apply handler。申请必须给出候选 ID、精确 mapping revision、source SHA 和 expected Product/revision 状态；过期或已有应用回执返回原结果/conflict，不重复写。
- [ ] 若目标产品不存在，使用现有 upload Task/Product 领域创建路径并按现有版本服务生成 ProductRevision；若目标已存在，追加 revision，不覆盖历史快照。field_sources 和 source_refs 明确保留 source SHA、snapshot ID、sheet/range/cell、mapping ID/version 及原值/公式缓存区分；应用状态/操作者只记 local_workbench，不伪造认证身份。
- [ ] 同一 candidate/revision 的确认回执事务化并幂等。任何业务规则未确认、缺少关键单位/版本、存在歧义关联或来源错误时拒绝应用并保留 staging，不以猜测补值。现有人工 review 仍按产品版本流程处理，不能用新的 Agent 人工审批工作流替代。
- [ ] PostgreSQL 合成测试覆盖新建/已有 Product 追加版本、字段 provenance、应用重复、source hash 变更、mapping 过期、候选拒绝、歧义/空单位、安全错误、无意外 ERP 写。预期：只有明确确认的身份字段进入 ProductRevision；其余 3 类候选留在 staging；既有 CSV import、ProductRevision 和 ERP operation 行为不变。
- [ ] 外部私有验收按 SHA 校验 intake 目录中的四份原始 workbook，通过页面逐份上传→source snapshot→预览→可映射字段→typed staging。对未确认业务语义不创建关系或补值；不创建 ERP 单据、不执行任何 Excel 公式、宏或外链。真实文件和逐单元格结果不复制到仓库。
- [ ] 最后由桌面窗口验证资料整理入口、上传/进度/安全失败、复杂表头与图片锚点查看、候选分页/来源追踪、日夜主题和窄屏；通过前不得称端到端验收完成。原生 Agent 查询以工具输入输出与 provenance 可回溯验证，不要求或宣称模型自主解释业务规则。
- [ ] 用 guarded PostgreSQL runner + 唯一新数据库运行 workbench.tests.test_intake_product_application 和相关旧产品版本模块；使用 pinned shell 测试运行只读工具与 ACL。仅在本地人工完成真实文件验收后归档脱敏 receipt/hash；不发布原始工作簿、导出值、图片或私人日志。

## 关键解析断言

合成 richData fixture 必须独立断言以下关系，而不能仅断言“找到图片数量为 4”：

1. 从 c/@vm 解析 metadata 索引，并由 metadata 类型索引找到 XLRICHVALUE future metadata。
2. 对应 richValue 标记为 _localImage，其 _rvRel:LocalImageIdentifier 槽决定 richValueRel 中的关系项；不对源索引做盲目的零基/一基偏移重试。
3. relationship ID 精确解析到包内 .rels target，再解析到包内媒体部件；跨部件名称、槽号与媒体签名都须一致。
4. 合成样例含四个单元格内图片引用（PNG/JPEG 类型均覆盖）、一张浮动 drawing 图片、普通无 vm 的算术 #VALUE!。图片损坏、外部目标、错槽和普通公式错误分开测试；它们都保留来源单元格及固定状态，不被合并成同一“图片错误”。

真实来源的直接核验在私有分析中确认：价格类工作簿 sheet 1 的四个连续 rich-data cell 各有独立 vm/metadata/richValue/relationship/media 链，另有一个浮动图片 anchor；四个媒体均可解码。该证据仅用于确定解析契约，不把原图、文件 hash、商品内容或商业数据加入代码和 fixtures。公式推导只在私有来源语义内保留为 成本/(1-毛利率)；公开实现文档不得固化实际毛利参数。

## 业务语义与验收界限

业务方对合同买卖方向/价格性质、跨文件产品身份键、工时是否标准或实际均回答“不知道”。来源接收、预览、候选与来源追溯可以独立完成；不允许自动 cross-file join、不把历史单据标成当前有效，也不以猜测的 SKU/名称/宽度让产品写入通过。上述语义需要将来由业务资料确认，不阻塞 typed staging 基础能力。
