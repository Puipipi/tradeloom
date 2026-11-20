# S7-08 隔离运行回执

本回执记录已实证的构建、同路径换版、冷启、设置保全、集中实机回归与正常退出。各项观察按实际执行深度记录。

## 冻结产品与离线校验

- 产品提交 `125850f9d0409537859e2580c7f2e80f352706b8`，tree `81e7fbe225dca10c2a6a05924c17b9257ca6cd39`。构建前工作树干净，354 项源码归档与工作树物理输入逐字节一致。四项既有纯行尾差异及双摘要见机器回执。
- 程序包 `[local-path-redacted]` 为 819,388,733 B，SHA-256 `31c528b25ed5315182f57bdf2f655a4ce2c8184a576d614b53708cd96162a694`。源码包 `[local-path-redacted]` 为 19,640,696 B，SHA-256 `f732413d2bb68d73f47e74e5f27133ca3eaa0dd1a312e7254aa291e0d5ef38db`。
- 官方 rc.3 严格重放及实际完整候选原生文件系统验证通过。固定 SDK 与边界 24/24，正式守卫零问题，官方原件获取 6/6，构建合同 4/4，事务 10/10。额外运行的两项历史 profile 合同因旧 rc.2 运行时路径缺失失败。三波继承限制见 [可维护性说明](maintainability.md)。

## 同路径换版

R3 在独立 `[local-path-redacted]` 冷启，显示工作流五个独立面板。Terra 在 R3 明确选择深色，主窗正常关闭后 [local-diagnostic-redacted] 所有窗口已退出。主控现场复核目标程序进程和三个标准端口均空，DATA 自有标记有效，事务目录尚不存在。R3 观察编号为 `fcdf0e7a`、`f51bd536`、`accc1abe`。

正式事务只运行一次，实际退出 0、状态 `complete`，激活锁释放。原 launcher SHA-256 `b655ecaef1dfd4a57deb056e82f7978a8f33e4c3669af758bda9b41e42bc6bb7` 与同一隔离 DATA 路径保留。R3 和发布候选均有 39,822 个相同路径，其中 24 项字节发生预期变更。已装清单 SHA-256 `b44d251da69a1916bd0dec802aed84683ebc2a0cde2c1732f75fa2463db6fc9b`。回退备份的 39,820 个应用文件、旧启动器及原 launcher 配置全部读回核对。事务日志、24 个路径和备份摘要见 [机器回执](S7-08-runtime.json)。

## 集中实机观察

| 项目 | 实际观察 |
| --- | --- |
| 最终冷启 | 2026-11-18 15:22:32.062Z Host 就绪、15:22:32.664Z 完成认证，15:22:37.056Z 主窗可见（[local-diagnostic-redacted]）。3088/3090/55432 分别由 69868/59424/71268 监听，均属该隔离程序。实际 profile 的业务库存为 77 件、3,037,873 B，SHA-256 `874761fe0739dc091fd2075fa5ed3b7a809fd19a83f4aac63e8fd41dae7a9686`。 |
| 深色设置与工作流面板 | R3 明确设为深色。最终初次冷启图在任何主题操作前已为深色，且工作流仍显示同五个独立面板。证据为 `r3-dark-workflow.png` 与 `final-cold-dark-workflow.png`。 |
| 目标模式 | 入口可达，未提交目标。证据为 `final-goal-mode-visible.png`。 |
| 客户页面 | 页面可达，显示空数据态。本项证据不包含客户修改或持久化。证据为 `final-customers-empty.png`。 |
| 窗口与窄宽 | 已实测独立运行记录窗打开、正常关闭、主窗恢复，随后原主窗窄宽下四块可见并恢复原宽。窗口观察属于端点，未测 FPS。一次滚动操作未确认位移。 |
| 插件 | 本轮未实作切换或重进持久化。 |
| 工作流 | 已核独立工作流面板和运行记录窗；`local_mock` 未见输出节点，未真实执行工作流或下载产物。 |
| 模型与语音 | 模型选择可达，列表为空。未验证外部模型请求与语音。 |
| 网页 | DeepSeek 显示风险页，豆包未登录。未验证网站登录、提问、附件、保存。 |
| 中心助手工具栏与放缩 | 实际刷新前后，左到右均为「刷新、独立窗、技能、放大、更多、关闭」，观察 `5bf14630` / `e257be42`。实际放大和还原端点为 `bc92a246` / `eda2c8db`，未量 FPS。 |
| 原生技能与入口 | 「当前助手技能」显示 archify，观察 `f1bc79c014c543958fcdba575c72770f`。计划项部分可见。权限菜单显示「当前工作区内修改」`139d389b`，模型菜单空 `41a99140`，自动化无启用任务 `a06e176e`。未提交设置、未执行计划或自动化任务。 |
| 业务页与网页独立窗 | 产品页空态 `6c83e2f9`、交付物页 `211088d2`、运行记录 `61b44281` 可达。DeepSeek 独立窗风险页 `c7bb5c0b`，豆包独立窗未登录 `b2259b29`。 |

### 独立窗与窄宽的异常及恢复

运行记录独立窗 [local-diagnostic-redacted] 在前时，原主窗 [local-diagnostic-redacted] 连续三次 WGC 只见深色背景和原生标题按钮。应用仍有响应，实时授权活动持续，UIA 留有文档树。关闭该独立窗后，同一主窗恢复，观察 `7ca62d6a1df9418ebab87737089b8876`。再次从恢复的主窗缩到外框 1100×1000、DWM 1082×991、DPI 144，实际显示四块界面，观察 `4b723d9cceab45aea48cf1b9b346054d`。滚动观察 `ee2ff4fc` 无法确认位移，恢复原宽观察 `0f67de7fdedf4b9282fcf74cf25a6ff7` 正常。原因未确定。

R3 与最终 ASAR 的 21,788 个逻辑路径一致，唯一逻辑内容变化为 `lib/tradeloom/bootstrap-core.mjs`。实际原生 Main、source-shell controller、preload、surface-owner、replica renderer/bridge/style 的字节摘要相同。原生场景独立窗由 renderer 经 bridge、preload、controller 创建并重新挂接 WebContentsView。该固定链、标题栏和原生窄宽相关代码均保持既有字节；本次 Dockview 私有整理涉及布局记录和面板返回，属于另一条路径。字节比对仅提供旁证，保留这次实际显示异常。

八张固定截图保存于 `[local-path-redacted]`。恢复后的图为 `final-main-recovered.png`，窄宽图为 `final-main-narrow-visible.png`，放大与还原图为 `final-assistant-expanded.png`、`final-assistant-restored.png`。完整 SHA-256 和原始观察来源见 [机器回执](S7-08-runtime.json)。

## 正常退出与交付边界

最终主窗正常 X 退出。[local-diagnostic-redacted] 的全部窗口（含两个网页窗）归零，Host `host-close/end` 在 15:41:35.916Z。15:42:01.816Z 独立输入终态为 owner 空、occupied 0、desktopPaused false。主控在 15:43:54.070Z 独立核对 Q/p 相关程序进程为 0，3088/3090/55432 监听均为 0，独立 DATA 自有标记有效，事务仍为 `complete`，锁已释放，隔离 Q 无新崩溃文件。

阶段 5 历史交付身份保持冻结，阶段 7 本次交付为本地固定程序及源码包。S7-08 将 R3 升至最终版并实测了旧文件完整备份，未执行此次换版的回退。S7-01 的两次回退均已实际执行，其中先后两次同路径程序替换成功后各自在实机冷启失败，回退恢复旧程序并正常冷启。详见 [S7-01 运行回执](S7-01-runtime.md)。已执行、可达与仍未验项目均按本回执记录。
