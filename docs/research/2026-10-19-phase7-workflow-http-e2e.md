# Phase 7 工作流 HTTP 整链验收切片（2026-10-19）

## 八字段验收记录

| 字段 | 记录 |
|---|---|
| 当前阶段 | 本地业务链 loopback HTTP 验收切片，目标测试最终 1/1 通过。Task 22 浏览器 e2e、Task 23、Phase 7 及长期 Phase 0–7 仍未整体完成。 |
| 目标 | 用真实 Django live server、HTTP 请求和当前公开页面/API 契约串起上传、意图确认、计划、双角色执行、人审、恢复、真实文件生成/质检、预览/下载、审批和完成；不扩展业务规则或运行时框架。 |
| 来源 | 当前 README/API/HTML、`test_task13b_delivery_resume.py`、delivery service、task-intent、image-selection、missing-image 与 review 测试；Django 5.2 LiveServerTestCase 与 CSRF 官方参考由主控事先核对。既有 fixture 仅用于了解契约，不将其通过 Client/helper 造出的终态当作本次 HTTP 证据。 |
| 固定范围 | 新增 `workbench/tests/test_phase7_workflow_http_e2e.py`。测试一条含通用演示 SKU 的实际 CSV 行，以真实 multipart 上传 CSV 与两个同名不同字节 SVG；通过网页/API创建当前规则允许的计划；按页面依赖执行；由真实 Product role 产生英文名称缺项与歧义图候选。HTTP 外没有预置已完成/已批准 ORM 状态。 |
| 结果 | 用 Django `LiveServerTestCase` 动态端口 `127.0.0.1`，`urllib` 无 proxy opener、CookieJar、CSRF cookie/header 和 Django multipart encoder。workflow detail HTML 的 form/data 属性与 option 驱动 dispatch、typed review、apply、resume、生成、批准、完成；公开 JSON 用于查询当前状态。HTTP 新 session 可读取终态。ORM 只核对状态/数量/来源/版本/哈希和无副作用。 |
| 覆盖 | 无 CSRF 的 preview POST 被拒绝且未创建 Workflow/Step；preview 只读；相同创建 key/payload 返回冻结 DTO且不增加 Step/SubTask；提前 generate 和提前 complete 均被拒绝且保持原状态；缺字段/图片候选使产品角色进入 `waiting_human`；submit 只形成 `submitted`，未新建 apply Step、未写 Revision、未恢复；页面提供 apply 与恢复参数，两角色依依赖完成。生成通过五类ArtifactVersion，质量为 passed，HTML/MD目录和 sample CSV 预览成功；5个版本下载及外部登记文件 SHA 均匹配，来源 Revision 列表与生成 Step 绑定一致；相同生成 key 重放后 version ID/SHA 不变；bundle 显式批准后才允许完成。 |
| 验证与边界 | 本轮最终定向命令 `python manage.py test workbench.tests.test_phase7_workflow_http_e2e --keepdb --noinput -v 2`：1/1、4.349秒、exit 0；最终 workbench 全量 295/295、32.082秒、exit 0。`manage.py check` 与 `git diff --check` 通过。测试名 guard 从受控 expected/configured `TEST.NAME` 推导并与活动 connection name 比较，要求 `tradeloom_test_*`，且拒绝与正式 `TRADELOOM_DB_NAME` 相同；MEDIA/ARTIFACT 根拒绝位于 repo 内。专用 QA DB `tradeloom_test_workflow_http_e2e`，不访问 `tradeloom_dev` 写入；测试命令 `--keepdb --noinput`。 |
| 未完成与下一步 | 这是真实 loopback HTTP，不是 Playwright/CUA/browser test；不能据此称实际浏览器点击、浏览器下载附件或 Task 22 通过。Agent 使用现有本地模拟规则，未验证企业规则、LLM、AgentArts、账号与外部平台能力。Phase 3/4/5 仍有长期缺项，Phase 6账号未验，Phase 7 全量演示及报告核对待完成。由主控审计测试、HTTP证据和文件/hash manifest 后决定下一批。 |

## Phase 0–7 现状矩阵

| Phase | 有证据的当前状态 | 本切片对整体状态的影响 |
|---|---|---|
| 1 | 已完成并通过验收：五板块、持久化、版本与模拟资料。 | 无变化。 |
| 2 | 本地模拟双角色框架已实现；不是外部模型或平台集成。 | 复用现有 `product_profile → delivery_quality`；不扩展Agent行为。 |
| 3 | 六类业务冲突完整检测仍未完成；既有通用/已支持信号含缺字段、歧义图片及人审事实应用。完整Task13与Phase3仍未完成。 | 仅通过上传CSV/图片后真实角色产生缺英文字段与歧义图片候选，验证提交、apply、resume、文件链路。没有宣称全部冲突类型完成。 |
| 4 | 恢复、幂等、重试与生成接管等多个子批次已有实现/验证；真实LLM/平台及Phase4综合状态未验收。 | 核对workflow创建与交付生成同key重放；不重跑历史并发、崩溃接管全套测试。 |
| 5 | 主要工作台UI及真实生成文件、预览、下载等既有子批次已有证据；完整新链浏览器验收仍未完成。 | HTTP读取HTML/MD与样品CSV预览并下载五文件，不声称浏览器用户体验通过。 |
| 6 | 真实AgentArts账号、部署/调用与平台能力尚未验证。 | 无变化、未访问平台或调用付费服务。 |
| 7 | 当前测试、外部Python/PostgreSQL、启动与迁移说明已有证据；Phase7完整验收仍待完成。 | 本轮增加一条完整的隔离HTTP业务链和可复现实跑命令；Task22浏览器与Task23验收矩阵仍待完成。 |

以上状态来自既有报告、计划和实测范围，不从旧 checkbox 猜测缺失实现。长期阶段仍未完成时维持原状态。

## 隔离与外部证据

项目外 evidence 根目录：`<LOCAL_EVIDENCE_ROOT>\phase7-workflow-http-e2e\`。测试在这个经校验的外部 base 下原子创建唯一 `run-<UUID>` 子目录，确认其直接父目录为 base 且不在仓库内，再把演示 CSV、MEDIA 与 ARTIFACT 全部写入子目录；不覆盖或清理 base 中既有内容。`before/` 保存本批修改目标的原始字节快照；新建文件记录 `before_exists=false`。`after/` 与最终 live 内容逐字节同步。`canonical-manifest.json` 列出每个本批文件的 before 状态与 SHA、`before_snapshot_root`、`after_snapshot_root`、after/live SHA。targeted/full 日志只记录命令输出、exit 和覆盖摘要，不包含 Cookie、confirmation token 原文或密码。运行时文件是本测试自行创建的外部拥有目录，不是 formal media/artifact 目录。

测试期间不改产品源码、模型或迁移，不运行正式数据库写入、不重启8000、不停止PostgreSQL、不访问浏览器、不绕过CUA安全策略、不调用外部平台或付费服务。最终生产源码哈希清单见项目外 evidence。


## 审查结论

主控与独立审查均已接受本切片测试范围。生产源码仅保存本轮 after 哈希；本批初始快照未包含生产源码，因此没有独立 before/after 源码哈希比较。证据清单包含 7 个状态项，其中 6 个实际 after 文件；SDD 计划路径为 before/after 均不存在的 noop 项。
