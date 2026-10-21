# 开源工作台参考：对 TradeLoom 的适配边界

## 来源与许可

参考仓库：[mashanglinyu/luanyujia-workbench](https://github.com/mashanglinyu/luanyujia-workbench)，固定于 commit [`49f232cccf711fd412b46971beec8e88f1bb4358`](https://github.com/mashanglinyu/luanyujia-workbench/commit/49f232cccf711fd412b46971beec8e88f1bb4358)，commit 日期为 2026-09-30；只读研究日期为 2026-10-19。研究使用独立 workspace 中该 commit 的精选 22 文件快照，包含 `LICENSE`，不含图片与 `.git`，未运行代码。源码留在 `<LOCAL_RESEARCH_ROOT>\references\luanyujia-workbench\49f232cccf711fd412b46971beec8e88f1bb4358\`，没有复制进 TradeLoom。

该仓库根目录许可证为 MIT。若以后复制或分发其中代码，需保留原版权和许可声明，并包含免责声明；本笔记只记录模式，没有复制源码。详见[固定版本 LICENSE](https://github.com/mashanglinyu/luanyujia-workbench/blob/49f232cccf711fd412b46971beec8e88f1bb4358/LICENSE)。

## 可借鉴的模式

研究对象主要是方法文档和纯壳模板，不是可直接安装的完整宿主或插件运行时。可借鉴三点：场景配置描述身份/布局，renderer 按类型负责显示；renderer 在卸载或重建时返回 cleanup，清理监听器和定时器；场景、会话、面板及数据来源使用显式身份，减少上下文串台。它们是设计模式参考，不表示 TradeLoom 已有场景面板、插件机制或 UI 生命周期实现。

## 与 TradeLoom 的边界

适配判断分三项：

1. **配置与 renderer 分离**：当前角色注册和任务编排位于 `WorkflowRoleRegistry`、`WorkflowOrchestrator`；页面使用 Django views/templates，尚无面板插件 registry。若用户确认需要可组合的 Agent 状态面板，再评估现有页面架构内的 renderer 边界。
2. **cleanup 生命周期**：当前 orchestrator 管服务端持久状态与事件，不实现客户端 renderer 卸载。若未来面板订阅/轮询状态，应在面板关闭时清理监听器和计时器；该 UI 行为尚未实现。
3. **显式身份与来源隔离**：当前已有 `WorkflowTask`、batch、`source_refs` 与 ORM 引用校验。未来 UI 可按 workflow/panel 身份隔离展示状态，但任何 UI 键都不能替代服务端查询范围和权限约束。

具体角色职责、面板字段与用户流程仍待访谈确认。

参考仓库的 Electron/WebView 会话绑定、浏览器 partition、本地 MCP 桥或免费网页 AI 桥不应搬入本项目作为 AgentArts、模型 API 或工作流替代品；该固定版本没有完整宿主实现，也不构成与 Django/PostgreSQL 的兼容证明。当前只吸收责任分离、cleanup 生命周期和显式身份/来源隔离的思路，不声称已实现面板插件。
