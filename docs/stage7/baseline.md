# 阶段 7 冻结基线

2026-11-18，独立 Git 仓库位于本文件上两级的源码根。分支 stage7-s5-final，初始工作树 clean，902 个 Git 跟踪路径。阶段 5 的旧工作区和历史 dirty 仍由原持有人保管。隔离基线使用已验收合并，省去从历史工作区提取 dirty。

| 项目 | 核验值 |
| --- | --- |
| 本地 HEAD 与 GitHub main | 0d4c15afe32d85364c2b323771cdbb31e5ac940b |
| 合并 tree | b3c3d8e379816a7f6b18e2b5f7e454656e8dd2f2 |
| PR #22 head 与合并第二父 | a41027608cb5aa2f63da065e9d397c76237fb82d |
| 远端仓库 | Puipipi/tradeloom，公开 |
| 交付 | GitHub 草稿 449755431，资产 762943901 为 uploaded，文件名 TradeLoom-stage5-Windows-x64-portable.zip |
| 本地与 GitHub ZIP | 817738881 B，SHA-256 fd6c4e66171f1c3d93251e581909fcb31c54a487fdbd92428e7a037895c40eed |
| 正式 ASAR | app/resources/app.asar，227946971 B，SHA-256 9ffc96c6178ab7634435860d37bf8fcc384f01362737f9564210eb77feaa3f82 |

本地 ZIP 在 ICT 根下 stage5-build-artifacts-20261113/s5-14-delivery-ah42/stage5-formal-package01/TradeLoom-stage5-AA35-AJ44-formal-candidate.zip。PACKAGE-READY.json 记录从 PR #21 合并对应的 c08012a7… ZIP 到正式 ZIP 的实物映射，39836 个成员仅替换 ASAR。PR #22 相对第一父的变更是 source06 的 source-shell-controller.mjs、business-bridge.js 与 SOURCE-MANIFEST.json，记录同一正式覆盖来源。source06 清单分开记录 ASAR、business、backend、程序恢复与 seed 的精确来源及摘要。旧版本 replay 的两个 preimage pin 仍有限制，见 source06/LEGACY-INPUT-LIMITS.json。这里冻结实际交付物和源身份，沿用既有构建与实机证据。

FORMAL-COLDSTART-AND-EXIT.json 指向同 SHA 正式 ZIP 在短路径用标准 wrapper 和空隔离 DATA 首启；Host ready、认证、窗口显示、刷新、放大、还原、X 退出均有记录。09:11:28 UTC 独立读回包路径进程零，标准三端口无监听；保留一次非阻断 sidebar-status 错误。A/B 录像与 ETW 限制见功能矩阵。S7-00 没有运行程序、升级、重新构包或执行产品测试。

计划 PLAN.md 复核 SHA-256 为 1b6e316fb6320eb5a2740f11750162338a2bc124b965814e02bdb377094a6197。根阶段 5 交接首段与机器索引 current_tasks 的当前总账优先于其旧检查点；名为 FinalAuthorizedScope20261118 的嵌套记录仍指 PR #21 与旧 ZIP，保留为历史证据。

[已合并 PR #22](https://github.com/Puipipi/tradeloom/pull/22) · [合并提交](https://github.com/Puipipi/tradeloom/commit/0d4c15afe32d85364c2b323771cdbb31e5ac940b) · [草稿交付入口](https://github.com/Puipipi/tradeloom/releases/tag/untagged-2e8cf67854b5eb62a7f4)


只读核验命令均退出 0。git ls-remote、gh api 与 git rev-parse 核远端 main、PR 与本地 tree；Get-FileHash 核 ZIP；Python 使用 zipfile 打开包内唯一 ASAR 成员并流式计算 SHA-256；python -B apps/tradeloom-launcher/stage5-source06/verify.py --git-blobs 校验 348 条精确 postimage 及 Git blob，并证正常源码的 9 个退役模块缺席。该工具保留 legacyRecipePinsAllPassed=false，未执行严格 replay。Git 最终状态仅列出本目录 5 个新文档，未提交。
