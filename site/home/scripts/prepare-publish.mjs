import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot, readConfig, validateConfig, applyMetadata, printReport } from './release-tools.mjs';
try {
  const config = await readConfig();
  const report = await validateConfig(config);
  printReport(report);
  if (report.errors.length) {
    console.error('发布准备已停止，未修改 index.html。');
    process.exitCode = 1;
  } else {
    const file = resolve(projectRoot, 'dist/index.html');
    const html = await readFile(file, 'utf8');
    await writeFile(file, applyMetadata(html, config.metadata), 'utf8');
    console.log('已将分享标题、描述及已填写的链接/封面写入 dist/index.html。确认提醒和人工验收后，可上传 dist 内全部文件。');
  }
} catch (error) { console.error(`[错误] 发布准备失败：${error.message}`); process.exitCode = 1; }
