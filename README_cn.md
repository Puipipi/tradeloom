# TradeLoom · 织贸助手

[English](README.md) / 简体中文

面向工贸一体制造与外贸团队的 AI 工作台：整理业务资料、保留来源，并准备供人工审核的草稿与交付物。

**第十一届华为 ICT 大赛（2026–2027）· 创新赛 · 赛题1：基于华为云产品打造AI创新应用。**

织贸助手面向制造与贸易工作，产品目录和样品清单是应用示例。生产要求、执行计划与 ERP 接入仍属于草稿框架，待进一步验收。华为云适配仍待验收，当前不宣称已完成比赛要求的云端部署。参见[赛题与目标](docs/00-赛题与目标.md)。

## 下载试用

R75 Windows x64 便携包已完成逐项读回、解压和隔离目录首次启动验证。发布资产将在 [ui18-r75-portable-20261106](https://github.com/Puipipi/tradeloom/releases/tag/ui18-r75-portable-20261106) 页面列出；请以该页面确认可用性。验证摘要、程序树摘要和重建边界见 [R75 验证与重建说明](docs/releases/ui18-r75-validation.md)。

发布资产可完整解压到短路径（例如 `C:/Apps/TradeLoom`），然后双击 `启动工作台.exe`。便携包包含程序运行所需的 Electron、Python、PostgreSQL、Django/backend 及纯程序插件 seed；不包含个人 profile、登录凭据、数据库或聊天记录。ERPNext 等外部服务仍需单独提供。

[desktop16 便携包](https://github.com/Puipipi/tradeloom/releases/tag/desktop16-portable-20261026) 是旧版历史发布，不是当前 R75 包。旧版 SHA-256：`ab973c6bf742979ef3875819a4b7729ef0ba1a3f2018dbc7b28d536cc6b13660`。

## 功能与状态

| 模块 | 用途 | 当前状态 |
|---|---|---|
| 产品资料 | 整理产品事实、发现资料缺项 | 已实现流程有分项验收记录；业务规则仍待验证。 |
| 交付物 | 生成产品目录、样品清单并进行人工审核 | 部分生成、预览与审核流程已验证；报价与完整业务闭环仍在推进。 |
| AI 工作台 | 连接会话、文件与任务工作流 | fresh 角色绑定与限定范围的原生附件预览已验证；业务端到端及更广文件流程仍待验收。 |
| 持久化与执行 | 保存任务历史并恢复工作 | 真实 runner 与 PostgreSQL 重启恢复仍需端到端验收。 |
| 生产与 ERP | 准备生产要求和执行计划 | 草稿框架；真实执行与 ERP 接入待验收。 |
| 华为云 | 支撑赛题1的云上应用 | CodeArts 与云部署属于参赛要求；当前适配与证据待验。 |

## 开发入口

先读[快速开始](docs/quick-start.md)和[运行时准备与升级](docs/upgrade-harness.md)。克隆源码不会附带外置 runtime 或已配置服务。这些文档含早期环境记录，使用命令前请核对适用的 runtime。

发布包与本地源码快照分别管理。R75 源码与程序工件证据见[发布验证记录](docs/releases/ui18-r75-validation.md)；runtime 与 vendor 输入均按版本固定。

## 文档导航

| 入口 | 内容 |
|---|---|
| [赛题与目标](docs/00-赛题与目标.md) | 当前赛题1方向、官方来源与待补证据 |
| [验收矩阵](docs/acceptance-matrix.md) | 分项验证及边界；历史条目保留当时日期 |
| [Agent 开发与接入](docs/agent-development.md) | 接入背景与开发契约 |
| [架构说明](docs/architecture.md) | 技术结构与早期设计背景 |
| [工作报告](docs/work-report.md) | 按日期记录的实现与验证 |
| [R75 便携包验证](docs/releases/ui18-r75-validation.md) | 包身份、隔离首次启动证据与固定重建输入 |
| [历史 README](README_legacy_20261026.md) | 原主页原样保留；旧路径、赛题二表述和状态不作为当前指引 |
| [赛题二历史研究](docs/00-赛题二历史研究.md) | 保留的 AgentArts 研究，作为可选技术参考，不是当前参赛题目 |

## 当前限制

R75 便携包已通过逐项 ZIP 读回、解压和隔离目录首次 C10 启动。fresh profile 未配置账号、未登录或发送消息；这些检查不证明真实模型业务端到端已通过。源码重建使用固定 R74 ASAR/sidecar 与固定 SDK/vendor 快照，不声称完整 DSH SDK TypeScript 可重建。发布可用性以对应 GitHub Release 页面为准。

产品仍在开发。构建成功、模拟工作流或任务已提交，不等于业务结果已完成。比赛最终要求以华为最新官方规则为准。

## 贡献与许可

欢迎提交 Issue 或范围明确的 PR。请注明源码或发布快照、前置环境、复现步骤和实际验证结果；使用演示数据，不提交客户资料或凭据。

当前未提供仓库级许可证文件，请勿默认按 MIT 授权使用；第三方组件遵循各自许可证。
