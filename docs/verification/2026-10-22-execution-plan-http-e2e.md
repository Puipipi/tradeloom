# 执行计划真实 HTTP 与 ToolRuntime E2E 验证（2026-10-22）

本轮只验证合成数据经 Django loopback HTTP 与现有 DSH 只读工具的闭环。Phase 1/2 的冻结审查包保持不变。测试没有连接生产 ERP、写入真实业务资料、迁移主库、同步静态文件、重启服务或打包发布。

## 覆盖范围

`workbench.tests.test_execution_plan_http_e2e` 使用 `LiveServerTestCase` 随机 127.0.0.1 端口、全新隔离 PostgreSQL 55435 testDB、外部临时目录、真实 urllib/cookie jar/multipart/CSRF。Django 写操作均经 HTTP 完成。合成 workbook 流程包括上传、preview、mapping、candidate、new_demand、文字来源、补齐未决字段、公开确认、创建计划、更新需求并回读旧计划。实际字段来源仍定位到旧 confirmed revision 的原 preview snapshot 与 sheet 1/A1；计划材料数量是显式合成提议字符串 `"0"`，工序值也是明确输入，actual 固定为 `missing`。

Probe 使用固定 candidate8 Node v24.21.0 与 `packages/core/tools/lib/index.js`，通过 `ToolRuntime.prototype.register` 原型 adapter 注册项目源码中现有的 `tradeloom_read_execution_plan`。center 与 delivery 实际请求同一随机 LiveServer GET；request wrapper 校验精确 GET path、私有测试 Host、目标随机端口与来源；product actor 在 HTTP 前被拒绝，非法 ID 也不发请求。renderer envelope 与只读期间业务行计数不变均通过。它不是原生 DSH session、provider serializer 或模型推理。

测试外部目录为 `workspace/testing/execution-plan-http-20261022/`，只含合成数据和验证结果。runner 外部目录守卫四例断言通过：拒绝仓库根、仓库内 child、仓库祖先，允许兄弟 `workspace/testing`；生产 `ALLOWED_HOSTS` 未修改，E2E 设置只在 `override_settings` 内生效。

## 实际执行

首次隔离运行 `2026-10-22T102110-246Z-57152` exit 1。HTTP 链已到计划详情回读，失败原因是 probe 误以为 `product` preset 应注册 center/delivery 限定的只读工具。该问题属于验证夹具假设错误；随后改为 center 注册，再用 product actor 检查角色守卫，未更改产品角色权限。原始结果与日志完整保留在 runner `runs/2026-10-22T102110-246Z-57152/`。

修正后的 E2E 运行 `2026-10-22T102303-848Z-59396` exit 0，1 test。之后使用另一个新 testDB 运行 `workbench.tests.test_execution_plan`、`workbench.tests.test_production_requirement` 与 E2E：run `2026-10-22T102335-159Z-61472` exit 0，27 tests / 20.103s，system check 无问题。两次 testDB 均为 runner 在 PG 55435 上新建的唯一 `tradeloom_test_*` 数据库；结果显示 `Using existing test database` 是 Django `keepdb=True` 的固定提示，不据此推断数据库复用。具体 JSON、原始 stdout/stderr、命令、退出码与文件 SHA 在外部 `workspace/testing/execution-plan-http-20261022/review-final/`。

固定 candidate8 依赖：Node SHA-256 `BA4E6D110E8C1592A1ECD390F6B05F3DA124B13871A5BE62B341A07A853C6C32`；ToolRuntime SHA-256 `1E53932E7C4213EA24A7D87F06960B7A7702CB21F8A5741C97242B4A470A442A`。runner/probe Node `--check`、四个路径边界断言与四个标签匹配断言 exit 0。runner 对精确模块标签、其 class/method 后代以及会包含该模块的 `workbench.tests` 祖先标签都要求显式传入 `--node-exe <candidate8-node.exe> --tools-library <candidate8>/packages/core/tools/lib/index.js`；依赖缺失会失败，不会 skip。只运行其他模块时仍不需传入这些参数。

## 验收边界

本结果证明 Django 真实 loopback HTTP、PostgreSQL 测试库及 registered ToolRuntime handler 的合成闭环。没有验证原生窗口/UI、DSH真实会话、模型或 provider、手机、发布包或主库激活。独立的测试服务线程仅在测试期间运行；主库 55432 未变更，阶段3未部署。

证据包 `workspace/testing/execution-plan-http-20261022/review-final/` 含 before SHA manifest、本阶段源快照、相对 before 的 focused diff、准确 changed/unchanged 清单以及每次 run 原始结果。验证说明自身 SHA 单列在外部 manifest，不在本文自引用。
