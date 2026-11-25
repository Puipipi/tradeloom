import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot, readConfig, validateConfig, metadataBlock, applyMetadata, safeUrl } from '../scripts/release-tools.mjs';

const original = await readConfig();
const dist = resolve(projectRoot, 'dist');
/** The handoff template's placeholders (the live config is filled in). */
function template() {
  const config = structuredClone(original);
  config.author = { ...config.author, avatar: 'assets/dsh-go.svg', id: 'DSH Go 作者' };
  config.download = { ...config.download, description: '公测已经开始，下载信息即将公布。', qrImage: '', url: '', altUrl: '' };
  config.repository = { label: 'github / 仓库即将公布', url: '' };
  config.metadata = { ...config.metadata, siteUrl: '', shareImage: '' };
  config.contributors = [];
  return config;
}
function filled() {
  const config = template();
  config.author.id = '测试作者';
  config.repository = { label: 'github / 测试仓库', url: 'https://example.com/repository' };
  config.download.description = '下载 Android 安装包';
  config.download.url = 'https://example.com/app.apk';
  config.metadata.siteUrl = 'https://example.com/dsh/';
  return config;
}

test('交付模板阻止正式发布，并明确指出未填字段', async () => {
  const report = await validateConfig(template(), dist);
  for (const field of ['author.id', 'repository.url', 'repository.label', 'download']) assert(report.errors.some(item => item.startsWith(field)));
});
test('当前配置可以正式发布，二维码文件存在', async () => {
  const report = await validateConfig(original, dist);
  assert.deepEqual(report.errors, []);
  assert.equal(original.download.qrImage, 'assets/author/download-qr-v2.png');
});
test('只填下载直链、品牌头像和空贡献者都合法，不要求二维码', async () => {
  const report = await validateConfig(filled(), dist);
  assert.deepEqual(report.errors, []);
  assert(!report.warnings.some(item => /qrImage|author.avatar|contributors/.test(item)));
});
test('二维码单独存在也可用，但检查器不假装验证扫码内容', async () => {
  const config = filled();
  config.download.url = '';
  config.download.qrImage = 'assets/dsh-go.svg'; // Test file existence only, never a real download QR.
  assert.deepEqual((await validateConfig(config, dist)).errors, []);
});
test('第二个下载链接可选，填了就要是有效地址', async () => {
  const config = filled();
  config.download.altUrl = 'https://github.com/example/app/releases/latest';
  assert.deepEqual((await validateConfig(config, dist)).errors, []);
  config.download.altUrl = 'javascript:alert(1)';
  assert((await validateConfig(config, dist)).errors.some(item => item.startsWith('download.altUrl')));
});
test('有有效下载直链时，另一个已填但错误的二维码仍需修正或清空', async () => {
  const config = filled();
  config.download.qrImage = 'dist/assets/qr.png';
  assert((await validateConfig(config, dist)).errors.some(item => item.startsWith('download.qrImage')));
});
test('本地图片缺失和大小写错误都能指出', async () => {
  for (const path of ['assets/author/missing.png', 'assets/DSH-GO.svg']) {
    const config = filled();
    config.author.avatar = path;
    assert((await validateConfig(config, dist)).errors.some(item => item.startsWith('author.avatar')));
  }
});
test('页面与自检共享 URL 规则，拒绝脚本、凭据和编码后的路径越界', () => {
  for (const url of ['javascript:alert(1)', 'https://user:pass@example.com', 'assets/../private.png', 'assets/%2e%2e/private.png', 'assets/%252e%252e/private.png', 'assets/avatar.png?v=2', 'dist/assets/avatar.png']) assert.equal(safeUrl(url, true), '');
  assert.equal(safeUrl('assets/avatar-v2.png', true), 'assets/avatar-v2.png');
  assert.equal(safeUrl('https://example.com/avatar.png?v=2', true), 'https://example.com/avatar.png?v=2');
});
test('四种贡献者格式与无链接平台 ID 均合法；非法行号被报告', async () => {
  const config = filled();
  config.contributors = [{ name: '名字', row: 1 }, { github: { label: 'ID', url: '' } }, { bilibili: { label: '昵称', url: 'https://example.com/profile' } }, { github: { label: 'ID', url: 'https://example.com' }, bilibili: { label: '昵称', url: '' } }];
  assert.deepEqual((await validateConfig(config, dist)).errors, []);
  config.contributors[0].row = 4;
  assert((await validateConfig(config, dist)).errors.some(item => item.includes('.row')));
});
test('畸形配置产生可读错误，不崩溃', async () => {
  assert((await validateConfig(null, dist)).errors.length);
  const config = filled();
  config.author = [];
  config.contributors = {};
  assert((await validateConfig(config, dist)).errors.some(item => item.startsWith('contributors')));
});
test('本地分享封面必须存在且可解析为正式域名下的 PNG/JPEG', async t => {
  const root = await fixture(t);
  const config = filled();
  config.metadata.shareImage = 'assets/author/share.png';
  await writeFile(resolve(root, 'dist/assets/author/share.png'), 'fixture');
  assert.deepEqual((await validateConfig(config, resolve(root, 'dist'))).errors, []);
  assert(metadataBlock(config.metadata).includes('https://example.com/dsh/assets/author/share.png'));
  config.metadata.siteUrl = '';
  assert((await validateConfig(config, resolve(root, 'dist'))).errors.some(item => item.startsWith('metadata.siteUrl')));
});
test('生成静态分享标签并转义内容，删除封面不会遗留旧图片标签', () => {
  const metadata = { ...filled().metadata, title: '<script> & "标题" $&', shareImage: 'https://example.com/share.jpg' };
  const block = metadataBlock(metadata);
  assert(block.includes('&lt;script&gt; &amp; &quot;标题&quot; $&'));
  assert(block.includes('summary_large_image'));
  assert(!block.includes('<script>'));
  const html = `<!doctype html>\n<head>\n${block}\n</head><body>不改正文</body>`;
  const updated = applyMetadata(html, { ...metadata, shareImage: '' });
  assert(!updated.includes('og:image'));
  assert(!updated.includes('twitter:image'));
  assert(updated.endsWith('<body>不改正文</body>'));
  assert.equal(applyMetadata(updated, { ...metadata, shareImage: '' }), updated);
});
test('交付首页元信息与默认配置一致，Star 气泡是指向仓库的链接', async () => {
  const html = await readFile(resolve(dist, 'index.html'), 'utf8');
  assert.equal(applyMetadata(html, original.metadata), html);
  assert(html.includes('<a class="star-callout" aria-disabled="true">'));
  assert(html.includes('<span class="callout-count" id="star-count" hidden></span>'));
});

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-go-release-test-'));
  t.after(async () => {
    // Verify the generated absolute target before recursive test-directory cleanup.
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-go-release-test-')) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(resolve(root, 'dist/assets/author'), { recursive: true });
  await mkdir(resolve(root, 'scripts'));
  for (const name of ['release-tools.mjs', 'check-content.mjs', 'prepare-publish.mjs']) await copyFile(resolve(projectRoot, 'scripts', name), resolve(root, 'scripts', name));
  for (const name of ['config-utils.js', 'index.html']) await copyFile(resolve(dist, name), resolve(root, 'dist', name));
  await copyFile(resolve(dist, 'assets/dsh-go.svg'), resolve(root, 'dist/assets/dsh-go.svg'));
  return root;
}
async function saveConfig(root, config) {
  await writeFile(resolve(root, 'dist/site-config.js'), `window.DSH_GO_CONFIG = ${JSON.stringify(config)};`);
}
test('命令行：缺失资料退出 1，发布准备不会改写页面', async t => {
  const root = await fixture(t);
  await saveConfig(root, template());
  const before = await readFile(resolve(root, 'dist/index.html'));
  for (const script of ['check-content.mjs', 'prepare-publish.mjs']) {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts', script)], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert(result.stderr.includes('author.id'));
  }
  assert.deepEqual(await readFile(resolve(root, 'dist/index.html')), before);
});
test('命令行：填写完整后通过，提醒同步元信息，发布生成静态 HTML 且可重复运行', async t => {
  const root = await fixture(t);
  const config = filled();
  config.metadata.title = '作者提供的分享标题';
  await saveConfig(root, config);
  const check = spawnSync(process.execPath, [resolve(root, 'scripts/check-content.mjs')], { encoding: 'utf8' });
  assert.equal(check.status, 0);
  assert(check.stderr.includes('尚未同步'));
  const command = () => spawnSync(process.execPath, [resolve(root, 'scripts/prepare-publish.mjs')], { encoding: 'utf8' });
  assert.equal(command().status, 0);
  const html = await readFile(resolve(root, 'dist/index.html'), 'utf8');
  assert(html.includes('<title>作者提供的分享标题</title>'));
  assert(html.includes('<link rel="canonical" href="https://example.com/dsh/">'));
  assert.equal(command().status, 0);
  assert.equal(await readFile(resolve(root, 'dist/index.html'), 'utf8'), html);
});
test('命令行：配置语法错误可诊断', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'dist/site-config.js'), 'window.DSH_GO_CONFIG = {');
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/check-content.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert(result.stderr.includes('无法检查配置'));
});
