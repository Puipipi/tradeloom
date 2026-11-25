import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot, readConfig, validateConfig, applyMetadata, printReport } from './release-tools.mjs';
try {
  const config = await readConfig();
  const report = await validateConfig(config);
  if (!report.errors.length) {
    const html = await readFile(resolve(projectRoot, 'dist/index.html'), 'utf8');
    if (applyMetadata(html, config.metadata) !== html) report.warnings.push('metadata：静态 HTML 尚未同步配置，请在上传前执行 npm run prepare:publish。');
  }
  printReport(report);
  process.exitCode = report.errors.length ? 1 : 0;
} catch (error) { console.error(`[错误] 无法检查配置：${error.message}`); process.exitCode = 1; }
