# 生产来源只读预检

`scripts/production_draft_readonly_preflight.py` 用于复跑 production instruction 来源链验收。它只对运行中的本机 Django 服务发送 GET，并以 PostgreSQL 启动参数强制其自身 Django 连接只读。脚本不会创建草稿、确认分类、写入映射、创建 Product、执行计划或 ERP 操作。

运行前由受控本机配置文件提供：私有数据根目录、密码文件引用、主库名称/用户/loopback 主机/端口/版本前缀、已应用迁移名、本机 HTTP loopback URL、该服务要求的 Host 头，以及目标来源 SHA-256。数据库可填写 `127.0.0.1` 或 `localhost`；实际服务地址必须解析为 loopback。配置和密码文件应按本机现有受控配置管理；不要把配置内容、凭据或来源标识复制到命令行、提交或报告。

配置 JSON 使用以下键名；值由本机受控配置填入，不要把示例占位文本作为真实配置：

```json
{
  "data_root": "<private data-root path>",
  "password_file": "<private password-file path>",
  "database": {
    "name": "<main database>",
    "user": "<main database user>",
    "host": "127.0.0.1",
    "port": 0,
    "server_version_prefix": "<approved major version>"
  },
  "api_base": "http://127.0.0.1:<local service port>",
  "api_host_header": "<configured local Host header>",
  "source_sha256": "<target source SHA-256>",
  "migration": "<required workbench migration name>"
}
```

在仓库根目录运行：

```powershell
python scripts/production_draft_readonly_preflight.py --config <本机受控配置文件路径>
```

该配置路径只作为本地输入参数。脚本会忽略继承的 libpq 连接选择变量，按配置建立 Django 连接，并在连接启动时设置 `default_transaction_read_only=on`，随后核验 `transaction_read_only`、数据库身份、服务版本和迁移。每次新连接也通过相同启动选项取得只读默认值。数据库连接检查与 HTTP API 检查分开报告：HTTP 请求只使用 loopback 网络目标、GET 方法和禁用重定向的 opener；API 服务使用自己的数据库连接，runner 不把该连接描述成由 runner 的会话只读闸门保护。`--help` 仅显示静态用法并以 `0` 退出，不表示预检完成。

runner 会分页读取来源目录，按配置中的来源 SHA 唯一选择来源，再按 source 和 `production_instruction` 唯一选择候选。它在进程内核对候选、mapping、ready snapshot、source 的外键和 SHA，确认每个 mapped 字段都有有效 locator 且 locator 指向真实单元格；调用 `open_source` 将受控原件完整流式 hash 后关闭；GET 候选详情和要求草稿，并与 ORM 核对；最后统计候选草稿、revision、两类 evidence、执行计划 revision，以及当前候选的两类 record kind fingerprint receipt 状态数量。已存在草稿时，报告其已保存的分类选择，但该选择仍是未验证状态并继续要求人工复核。

JSON 输出仅有 `status`、白名单 `reason`、`checks`、数量 `counts` 和枚举 `gates`。不输出业务正文、字段值、文件名、locator、ID、SHA、绝对路径、SQL 参数、凭据或原始异常。退出码 `2` 表示需要业务复核；本次覆盖范围应以返回的 `checks`、`counts` 和 `gates` 为准。若候选缺失或有多个候选，runner 会在来源链核验前返回 `review_required`，相应 gate 为 `candidate_missing` 或 `candidate_ambiguous`，不能称为所有技术项已核验。只有唯一候选且对应来源链检查均在 `checks` 中成功，才能说明本次来源链核验完成。该 runner 不会提供业务人对 record kind 的确认依据，因此完整只读核验仍返回 `review_required`、退出码 `2`；这不是 POST 或确认许可。退出码 `1` 表示检查失败或不完整；退出码 `0` 只用于 `--help` 静态用法。缺映射、未知 record kind、已有草稿/receipt、候选缺失或歧义都不能被解释为可写入。

纯合成测试（不连接 Django、PostgreSQL 或真实服务）：

```powershell
python scripts/test_production_draft_readonly_preflight.py
```

合成测试只能证明纯逻辑与输出保护行为，不构成真实主库或图形界面验收。实际界面检查需由可用的原生 UI 工具另行完成。
