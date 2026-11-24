# TradeLoom · 织贸助手

[English](README.md) / 简体中文

## Windows Electron 桌面版

**下载 Windows x64 完整桌面版：**[Stage 6.17 发布页](https://github.com/Puipipi/tradeloom/releases/tag/stage6.17-windows-x64) · [完整 ZIP](https://github.com/Puipipi/tradeloom/releases/download/stage6.17-windows-x64/TradeLoom-stage6.17-Windows-x64-full.zip) · [SHA-256 校验文件](https://github.com/Puipipi/tradeloom/releases/download/stage6.17-windows-x64/SHA256SUMS.txt)。

1. 从发布页下载完整 ZIP 和校验文件。
2. 按 `SHA256SUMS.txt` 校验 ZIP，完整解压后运行 `program/启动工作台.exe`。
3. 成功后会打开 Electron 桌面窗口，标题为**「织贸工作台」**，首屏能看到完整工作台和导航。单独的浏览器「产品资料」页不是桌面版。

具体校验命令、数据位置和升级边界见[Windows 桌面部署说明](docs/windows-desktop-deployment.md)。Release 页面是固定下载入口。

## 产品简介

面向工贸一体制造与外贸团队的 AI 工作台：整理业务资料、保留来源，并准备供人工审核的草稿与交付物。**TradeWeave** 是同一项目中 Django 业务网页使用的显示名称，不是另一套桌面安装包；Django「产品资料」页面用于开发或该网页业务流程，团队日常完整部署请使用上方 Electron 桌面版。

**第十一届华为 ICT 大赛（2026–2027）· 创新赛 · 赛题1：基于华为云产品打造AI创新应用。**

织贸助手面向制造与贸易工作，产品目录和样品清单是应用示例。生产要求、执行计划与 ERP 接入仍属于草稿框架，待进一步验收。华为云适配仍待验收，当前不宣称已完成比赛要求的云端部署。参见[赛题与目标](docs/00-赛题与目标.md)。

## 功能与状态

| 模块 | 用途 | 当前状态 |
|---|---|---|
| 产品资料 | 整理产品事实、发现资料缺项 | 已实现流程有分项验收记录；业务规则仍待验证。 |
| 交付物 | 生成产品目录、样品清单并进行人工审核 | 部分生成、预览与审核流程已验证；报价与完整业务闭环仍在推进。 |
| AI 工作台 | 连接会话、文件与任务工作流 | fresh 角色绑定与限定范围的原生附件预览已验证；业务端到端及更广文件流程仍待验收。 |
| 持久化与执行 | 保存任务历史并恢复工作 | 真实 runner 与 PostgreSQL 重启恢复仍需端到端验收。 |
| 生产与 ERP | 准备生产要求和执行计划 | 草稿框架；真实执行与 ERP 接入待验收。 |
| 华为云 | 支撑赛题1的云上应用 | CodeArts 与云部署属于参赛要求；当前适配与证据待验。 |

## 外部服务与用户数据

桌面包自带应用运行环境，但不包含 ERPNext 服务、模型服务账号、凭据，也不提供这些外部服务的网络访问。使用相应功能前需单独配置服务。Stage 6.17 将 profile 数据保存在解压目录中与 `program` 同级的 `profile-data-f630-s6-20261122-17`。此包不会自动读取 `%LOCALAPPDATA%\TradeLoom` 中的旧数据；升级时保留旧程序目录和旧数据目录，具体迁移边界见部署说明。

## 开发入口

企业服务首装、启停入口在仓库根目录：`Install-EnterpriseServer.ps1`、`Start-EnterpriseServer.ps1`、`Stop-EnterpriseServer.ps1`；客户端地址为 `http://127.0.0.1:27417/enterprise/`。详见[Windows 企业服务器安装](docs/enterprise-service.md)。

GitHub 仓库提供源码；克隆源码不会自动安装或启动 Electron 桌面版。源码开发请从[快速开始](docs/quick-start.md)和[运行时准备与升级](docs/upgrade-harness.md)开始。部署包请从[Stage 6.17 Release](https://github.com/Puipipi/tradeloom/releases/tag/stage6.17-windows-x64)获取，不要将 Django 开发网页当作桌面安装入口。

## 文档导航

| 入口 | 内容 |
|---|---|
| [Windows 桌面部署说明](docs/windows-desktop-deployment.md) | 完整包下载、校验、启动、数据和升级步骤 |
| [Django 企业服务](docs/enterprise-service.md) | 登录、账号/用户组、loopback 本机和 HTTPS 远端部署 |
| [赛题与目标](docs/00-赛题与目标.md) | 当前赛题1方向、官方来源与待补证据 |
| [验收矩阵](docs/acceptance-matrix.md) | 分项验证及边界；历史条目保留当时日期 |
| [Agent 开发与接入](docs/agent-development.md) | 接入背景与开发契约 |
| [架构说明](docs/architecture.md) | 技术结构与早期设计背景 |
| [工作报告](docs/work-report.md) | 按日期记录的实现与验证 |
| [R75 便携包验证](docs/releases/ui18-r75-validation.md) | 历史包身份与隔离首次启动证据 |
| [历史 README](README_legacy_20261026.md) | 保留的旧主页；其中安装路径与状态不作为当前指引 |
| [赛题二历史研究](docs/00-赛题二历史研究.md) | 保留的 AgentArts 研究，作为可选技术参考，不是当前参赛题目 |

## 历史验证记录

R76 与 desktop16 是历史包和验证记录，不是当前下载入口。[R76 验证说明](docs/releases/ui18-r76-validation.md)记载当时的归档检查、隔离 QA profile 和重建边界；R75 是历史首次启动基线，其 GitHub Release 当时仍是草稿。历史验证不代表 Stage 6.17 已通过运行时或业务验收。

较早的 [desktop16 便携包](https://github.com/Puipipi/tradeloom/releases/tag/desktop16-portable-20261026) SHA-256 为 `ab973c6bf742979ef3875819a4b7729ef0ba1a3f2018dbc7b28d536cc6b13660`，仅用于识别该历史包。

产品仍在开发。构建成功、模拟工作流或任务已提交，不等于业务结果已完成。比赛最终要求以华为最新官方规则为准。

## 贡献与许可

欢迎提交 Issue 或范围明确的 PR。请注明源码或发布快照、前置环境、复现步骤和实际验证结果；使用演示数据，不提交客户资料或凭据。

当前未提供仓库级许可证文件，请勿默认按 MIT 授权使用；第三方组件遵循各自许可证。
