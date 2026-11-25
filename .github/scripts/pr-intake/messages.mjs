export function closeMessage({ locale, prAuthor, repoUrl }) {
  const zh = [
    `Hi @${prAuthor}，感谢关注 dsh-Go。`,
    '',
    'dsh-Go 目前**不接受任何外部 Pull Request**（代码、文档、配置、模板都不接收），所以这个 PR 会被自动关闭。',
    '你的分支可以自行保留或删除；被关闭只代表仓库政策，不代表否定你的工作。',
    '',
    `有功能建议、改进想法或 bug 反馈，请开 issue：${repoUrl}/issues/new/choose`,
    '写清使用场景与期望的行为；bug 请附 App 版本、Android 版本、机型与可重复的最小步骤。',
    '',
    '维护者明确需要这份实现时会手动 reopen；其他人 reopen 会被再次关闭。',
    '',
    `政策见 ${repoUrl}/blob/main/CONTRIBUTING.md 与 ${repoUrl}/blob/main/AGENTS.md`,
  ]
  const en = [
    `Hi @${prAuthor}, thanks for your interest in dsh-Go.`,
    '',
    'dsh-Go currently does **not accept any external pull requests** (code, docs, configuration or templates), so this PR is being closed automatically.',
    'Your branch is yours to keep or delete; closing only reflects the repository policy.',
    '',
    `For feature ideas, improvements or bug reports, please open an issue: ${repoUrl}/issues/new/choose`,
    'Describe the use case and expected behavior; for bugs include the app version, Android version, device model and minimal reproducible steps.',
    '',
    'If the maintainer explicitly wants this implementation, they can reopen the PR; reopening by anyone else will be closed again.',
    '',
    `Policy: ${repoUrl}/blob/main/CONTRIBUTING.md and ${repoUrl}/blob/main/AGENTS.md`,
  ]
  return (locale === 'zh' ? zh : en).join('\n')
}
