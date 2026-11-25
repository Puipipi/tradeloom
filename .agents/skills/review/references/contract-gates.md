# dsh-Go 契约门禁
真源：`runtime/bridge/dsh-go-bridge/`（HTTP 路由）、`packages/dsh_client` 的公开 API、`app/lib/state` 的能力状态、`runtime/patches/pins.json`、`app/lib/l10n/parts/*.arb`、`sdk/plugin-kit`、CONTRIBUTING.md。本文件仅检查顺序，不存日期化常量；契约变更缺兼容策略/迁移/验证默认阻断。

## 门 1｜桥接 HTTP 契约
`/dsh-go/v1/*` 路由：路径、方法、鉴权（`connection.requestRejection` 之类的请求拒绝）、状态码、JSON 形状与版本字段、错误码（如 `unavailable`）。
阻断：单端改路由/形状/错误码而另一端未同步；无版本迁移；测试未覆盖拒绝、未连接与主机拒绝路径。

## 门 2｜客户端公开 API
`packages/dsh_client` 的公共导出（carrier、mux、SessionDeletionApi 等）签名/语义变化需兼容或迁移；新增能力须有对应测试；不得因 App 端需要而绕过 carrier 直接开新 HTTP 客户端。

## 门 3｜能力状态三态
会话删除等主机能力必须区分 unknown / supported / unsupported：未连接、mux 未 ready 是 unknown，不得压成 bool；UI 文案穷尽映射；仅主机明确回答才显示"不支持"；mux ready 后要能重探。

## 门 4｜runtime 补丁与 pins
`runtime/patches/` 补丁与 `pins.json` 同步；引擎版本变化后补丁仍可应用；补丁引入的写入、锁、墓碑与派生状态清理有 node 测试覆盖。

## 门 5｜l10n 与文档同步
`app/lib/l10n/parts/*.arb` 与 `.en.arb` 同步，`l10n_merge.py --check` 通过；`docs/guide/` 与 App 内置技能同步（`guide_sync.py --check`）；README/CONTRIBUTING/SECURITY 中英两版同步。

## 门 6｜插件 SDK 消费面
`sdk/plugin-kit` 的公开 API、skill 输入与生成物同步（`sync-skill.mjs --check`）；类型检查依赖缺失时不得把跳过写成通过。

## 门禁自修改的证明义务
实现与保护 gate 同改须列旧 gate 对坏实现结果、新 gate 扩大/收窄精确集合，以独立 oracle 证未开后门、证 CI/聚合链实执行；脚本存在、CI 绿均不足。
