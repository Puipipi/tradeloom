---
name: pr
description: Open or update an internal pull request in ccch1mneyyy/dsh-Go, including writing or rewriting its description. Use for every PR the maintainer creates or edits here, and for /pr. External pull requests are not accepted (see AGENTS.md).
---

Ship the current change as an internal pull request a reviewer can understand from the description alone: why it exists, the shape of the implementation, and what was actually verified. 外部 PR 一律不接受，本技能只用于维护者自己的分支。

1. 一个 PR 一个主题。确认改动有明确目标；不要因为某个 issue 存在就自动把实现包装成 PR。关联 issue（如有）。
2. 提交并推送分支，分支 upstream 是它自己，绝不推 `main`。提交信息用 `type(scope): summary`（conventional commits，中文或英文与周边一致）。只暂存明确路径。
3. 读完整 diff 与相关代码，确认能解释所有权与行为；收集实际跑过的验证。
4. 用仓库内的 [PR 模板](../../../.github/PULL_REQUEST_TEMPLATE.md) 写正文：
   - **Why the change**：一句话。
   - **Special things to note**：1–3 条 reviewer 提醒；未运行的检查也写这里。
   - **Change outline**：最少的图（文件树/调用链/关键形状），每图一句说明，不写逐文件流水账。
   - **Verification**：实际执行的命令与结果；真机/桌面区分写清。
   正文用中文，一个人对另一个人说话。
5. 用 `gh pr create --body-file` / `gh pr edit --body-file` 发布，再 `gh pr view` 确认渲染结果；报告 PR URL、关联 issue 和 CI 状态。
