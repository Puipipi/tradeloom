# ERPNext 实时只读接入实施计划

## Goal

让本地工作台能从用户私有配置安全启动 ERPNext 连接，并在“ERPNext”企业管理场景中显示实际连接状态、7 类已授权 DocType 的分页列表与详情。未配置时继续显示未配置，不生成演示记录。草稿写入与任何提交/审批操作留待后续独立阶段。

本计划不启动或部署 ERPNext，也不运行测试、打开 GUI、安装依赖、同步运行时或打包。当前远端服务尚未证明可用；用户要求本轮不做实机验证。

## Architecture

- launcher 读取用户显式传入的私有 JSON 配置文件，仅向 Django 子进程注入 ERPNext 的四个环境变量。Electron/DSH 进程、参数、日志和状态/错误 DTO 不接触凭据。
- Django 复用现有只读适配器与路由：`GET /api/erpnext/status`、`GET /api/erpnext/records`、`GET /api/erpnext/record`。shell 继续通过现有 `/business-api` 同源代理请求，不建立通用 REST 代理。
- 原生 `erpnext` scene 的现有状态面板扩展为连接状态、DocType 选择、分页记录和详情；界面使用 React 文本节点呈现数据并沿用现有浅/深主题及 Dockview 面板。外部 ERPNext 链接只在 status DTO 带有服务器验证后的 URL 时显示，并由用户点击打开；不在本阶段构造不受信任的 URL。
- 只读范围由 `workbench/erpnext/service.py` 的 `SUPPORTED_DOCTYPES`、字段/过滤器白名单及现有 API 限制决定；不得添加写入或提交路径。

## TechStack

- Node.js launcher (`apps/tradeloom-launcher/cli.mjs`、`core.mjs`)
- Django/Python 只读 ERPNext adapter (`workbench/erpnext`)
- 已有原生 React scene (`packages/tradeloom-shell/client.scenes.js`, `scenes.json`)
- 无新运行时依赖；配置读取仅使用 Node 标准库。

## Spec

Launcher option：`--erpnext-config-file <absolute-file>`；桌面脚本对应 `-ErpNextConfigFile`。此参数必须有非空路径；缺失值或空值启动失败，不得静默退回未配置。未提供参数时不设置任何 `TRADELOOM_ERPNEXT_*` 环境变量，status 保持 `not_configured`。提供时必须同时显式指定 owned DataRoot（`--data-root` 或 `TRADELOOM_DATA_ROOT`），先由 launcher 现有 ownership/reparse 检查确认 DataRoot，再读取精确路径 `<ownedDataRoot>/private/erpnext.json`；文件及目录必须是普通路径，拒绝符号链接/reparse point；UTF-8 文件大小上限 16 KiB。JSON 必须是对象且仅含以下键：

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:18080",
  "instanceId": "local-erpnext",
  "apiKey": "由管理员提供的 API key",
  "apiSecret": "由管理员提供的 API secret"
}
```

`version` 必须为整数 1；其余必须是非空、无换行的字符串，`instanceId` 不超过 128 字符。`baseUrl` 仅允许 HTTPS 或 loopback HTTP，拒绝 userinfo、query、fragment；规则与 `ErpNextConfig` 一致。文件读取、解析或验证失败统一报“ERPNext 私密配置无效”，不得拼接原始错误、路径或内容。

有效配置只向 `manage.py runserver` 的 Django 子进程添加 `TRADELOOM_ERPNEXT_BASE_URL`、`TRADELOOM_ERPNEXT_INSTANCE_ID`、`TRADELOOM_ERPNEXT_API_KEY`、`TRADELOOM_ERPNEXT_API_SECRET`。在配置字段读取前仍沿用 `buildChildEnvironment` 的现有 secret 过滤；不改通用过滤器，不向 DSH/Electron 注入这些值。

ERP 场景沿用现有 scene/panel ID；同源访问 status、list、detail GET API。列表覆盖 `Item`、`Customer`、`Supplier`、`Warehouse`、`Bin`、`Sales Order`、`Purchase Order`，默认分页不超过服务端 100 项，使用 `next_offset` 决定是否提供下一页。详情显示 `external_ref` 来源和白名单记录字段；字段按类型安全格式化，不执行 HTML。未配置、加载中、空列表、加载失败和重试均有明确中文状态。HTTP/API 错误不显示原始 body、URL 或 header。

## Files

- `apps/tradeloom-launcher/cli.mjs`：解析 option、加载配置并仅注入 Django env。
- `apps/tradeloom-launcher/erpnext-config.mjs`：私有文件路径/普通文件/JSON schema 校验纯函数。
- `contracts/erpnext-private-config-v1.schema.json`：配置格式契约；launcher 仍自行执行相同严格校验，不增加运行时 JSON Schema 依赖。
- `apps/tradeloom-launcher/tests/`：配置路径、大小、schema、泛化错误和子进程隔离的回归用例；本轮受用户约束不运行。
- `workbench/erpnext/api.py`、`client.py`、`service.py`、`dto.py`：仅当只读 DTO 需安全 `site_url` 时最小扩展；不得改变既有字段白名单或错误脱敏。
- `workbench/tests/test_erpnext_api.py`：只读 status/list/detail DTO 和错误安全回归。
- `packages/tradeloom-shell/client.scenes.js`：扩展已注册 ERP status 面板，复用同源 API、重试和 theme token。
- `packages/tradeloom-shell/tests/`：ERP status/list/detail 加载、空态、错误重试和分页的组件契约用例；本轮不运行。
- `docs/superpowers/plans/2026-10-21-erpnext-live-integration.md`：本计划。

## Steps

- [x] 定位现有适配器、GET 路由、scene 及 launcher 环境隔离入口。
- [x] 定义私有配置 schema 与不泄漏边界。
- [x] 实现 launcher `--erpnext-config-file` 严格读取与 Django-only env 注入；无参数保持未配置。
- [x] status DTO 仅提供从已验证配置派生的无凭据 `site_url`，UI 只显示用户点击的外链。
- [x] 扩展 ERP 面板为 7 类列表、详情、分页及安全重试，复用现有场景和主题。
- [x] 更新 launcher、Django API 与 renderer 回归测试源；按当前用户要求不运行测试套件。
- [x] 静态核对配置键、环境变量作用域、URL DTO 与 UI 请求路径。
- [ ] 由授权测试环境执行 launcher、Django API 和 shell renderer 定向回归；本轮未运行。
- [ ] 配置私有 ERPNext 文件并由用户/管理员启动后，确认真实 HTTP 状态与记录数据；服务当前未由本轮验证。

## Verification boundary

本轮仅源码编辑和静态审查。自动化测试、ERPNext HTTP 连通、实际 GUI、配置持久化与用户点击外链均未执行；不得把已存在的适配器测试或历史 ERP 状态面板冒充本次验收。建议后续在已配置的授权隔离环境执行 `node --test apps/tradeloom-launcher/tests/erpnext-config.test.mjs`、`python manage.py test workbench.tests.test_erpnext_adapter workbench.tests.test_erpnext_api` 和 `node --test packages/tradeloom-shell/tests/scenes.test.js`，再进行真实服务与原生窗口验收。
