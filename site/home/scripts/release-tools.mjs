import { readFile, stat, readdir, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import utils from '../dist/config-utils.js';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const { safeUrl } = utils;
const text = value => typeof value === 'string' ? value.trim() : '';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const pending = value => /待填写|待公布|即将公布|请填写/.test(text(value));

export async function readConfig(root = projectRoot) {
  const source = await readFile(resolve(root, 'dist/site-config.js'), 'utf8');
  // Run the project's configuration with no Node filesystem/network bindings.
  const json = new Script(`${source}\nJSON.stringify(window.DSH_GO_CONFIG)`, { filename: 'site-config.js' })
    .runInNewContext({ window: {} }, { timeout: 1000 });
  if (!json) throw new Error('site-config.js 没有定义 window.DSH_GO_CONFIG。');
  return JSON.parse(json);
}

export async function validateConfig(config, distRoot = resolve(projectRoot, 'dist')) {
  const errors = [], warnings = [];
  const error = (field, message) => errors.push(`${field}：${message}`);
  const warn = (field, message) => warnings.push(`${field}：${message}`);
  if (!record(config)) return { errors: ['配置必须是一个对象。'], warnings };
  const sections = {};
  for (const key of ['author', 'download', 'repository', 'metadata']) {
    if (!record(config[key])) error(key, '缺少配置对象，请参照填写说明补齐。');
    sections[key] = record(config[key]) ? config[key] : {};
  }
  const { author, download, repository, metadata } = sections;

  function requiredText(value, field) {
    if (!text(value)) error(field, '未填写文字。');
    else if (pending(value)) error(field, '仍有待填写/待公布的占位文字，请换成实际内容。');
  }
  function link(value, field, required = false) {
    if (value === '' || value === undefined || value === null) {
      if (required) error(field, '未填写正式链接。');
      return '';
    }
    const url = safeUrl(value);
    if (!url) error(field, '应为完整 HTTP(S) 地址，不能包含用户名或密码。');
    else if (url.startsWith('http:')) warn(field, '当前为 HTTP，上线时优先使用 HTTPS。');
    return url;
  }
  async function image(value, field) {
    if (value === '' || value === undefined || value === null) return '';
    const url = safeUrl(value, true);
    if (!url) {
      error(field, '本地图片应以 assets/ 开头，不加 dist/、../ 或 ?v=；也可填完整 HTTP(S) 图片地址。');
      return '';
    }
    if (!url.startsWith('assets/')) {
      link(url, field);
      warn(field, '远程图片未联网验证，请在发布后的页面确认能正常显示。');
      return url;
    }
    const relative = decodeURIComponent(url);
    const file = resolve(distRoot, relative);
    try {
      const base = await realpath(distRoot);
      const actual = await realpath(file);
      if (!actual.startsWith(base + sep) || !(await stat(actual)).isFile()) throw new Error('not a local asset');
      // Windows can hide case mistakes that would break on a Linux static host.
      let folder = distRoot;
      for (const part of relative.split('/')) {
        if (!(await readdir(folder)).includes(part)) {
          error(field, '路径大小写与磁盘文件不一致，上传后可能无法加载。');
          return '';
        }
        folder = resolve(folder, part);
      }
    } catch {
      error(field, '本地文件不存在、不是文件或位于 dist 之外，请确认图片已放入交付目录。');
      return '';
    }
    return url;
  }

  requiredText(author.id, 'author.id');
  if (['DSH-GO 作者', 'DSH Go 作者'].includes(text(author.id))) error('author.id', '仍为默认占位 ID，请填写软件作者自己的 ID。');
  await image(author.avatar, 'author.avatar'); // Empty/default brand avatar is allowed.
  if (!text(author.message)) warn('author.message', '作者自述为空；如不打算留空，可保留原介绍。');
  requiredText(repository.label, 'repository.label');
  link(repository.url, 'repository.url', true);
  for (const field of ['label', 'platform', 'title', 'description']) requiredText(download[field], `download.${field}`);
  const downloadUrl = link(download.url, 'download.url');
  link(download.altUrl, 'download.altUrl'); // Optional second link, e.g. GitHub Releases.
  const qr = await image(download.qrImage, 'download.qrImage');
  if (!downloadUrl && !qr) error('download', '至少提供一种下载方式：有效的 url 或 qrImage。');
  // A valid direct URL alone is complete; an absent QR is not a warning.

  requiredText(metadata.title, 'metadata.title');
  requiredText(metadata.description, 'metadata.description');
  const siteUrl = link(metadata.siteUrl, 'metadata.siteUrl');
  if (!siteUrl) {
    if (!text(metadata.siteUrl)) warn('metadata.siteUrl', '正式页面地址留空，暂不生成 canonical/og:url；确定部署地址后再填写。');
  } else if (new URL(siteUrl).hash || new URL(siteUrl).search) error('metadata.siteUrl', '正式页面地址不要包含查询参数或 # 锚点。');
  const share = await image(metadata.shareImage, 'metadata.shareImage');
  if (!text(metadata.shareImage)) warn('metadata.shareImage', '未提供分享封面，将生成标题和描述，不生成图片标签。');
  if (share && !/\.(png|jpe?g)$/i.test(new URL(share, 'https://local.invalid/').pathname)) error('metadata.shareImage', '分享封面请使用 PNG 或 JPEG 文件。');
  if (share.startsWith('assets/') && !siteUrl) error('metadata.siteUrl', '本地分享封面需要正式页面地址，才能生成公开的绝对图片地址。');
  if (share && !text(metadata.shareImageAlt)) warn('metadata.shareImageAlt', '建议补充分享图片的文字描述。');

  if (!Array.isArray(config.contributors)) error('contributors', '应为数组；没有贡献者时填 []，允许留空。');
  else for (const [index, person] of config.contributors.entries()) {
    const key = `contributors[${index}]`;
    if (!record(person)) { error(key, '每项应为一个贡献者对象。'); continue; }
    let displayed = Boolean(text(person.name));
    for (const kind of ['github', 'bilibili']) {
      if (person[kind] === undefined) continue;
      const profile = person[kind];
      if (!record(profile)) { error(`${key}.${kind}`, '应包含 label 和可选 url。'); continue; }
      requiredText(profile.label, `${key}.${kind}.label`);
      displayed ||= Boolean(text(profile.label));
      link(profile.url, `${key}.${kind}.url`); // Missing platform URL means a plain text chip.
    }
    if (!displayed) error(key, '没有可显示的名字或平台 ID；要留空位请删除此项。');
    if (person.row !== undefined && ![1, 2, 3].includes(person.row)) error(`${key}.row`, '仅接受数字 1、2、3，也可以省略。');
  }
  return { errors, warnings };
}

const escapeHtml = value => text(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export function metadataBlock(metadata) {
  const lines = ['  <!-- DSH-GO metadata:start -->', `  <title>${escapeHtml(metadata.title)}</title>`];
  const meta = (kind, name, value) => lines.push(`  <meta ${kind}="${name}" content="${escapeHtml(value)}">`);
  meta('name', 'description', metadata.description);
  meta('property', 'og:type', 'website');
  meta('property', 'og:site_name', 'DSH Go');
  meta('property', 'og:locale', 'zh_CN');
  meta('property', 'og:title', metadata.title);
  meta('property', 'og:description', metadata.description);
  const site = safeUrl(metadata.siteUrl);
  const image = safeUrl(metadata.shareImage, true);
  const absoluteImage = image.startsWith('assets/') ? (site ? new URL(image, site).href : '') : image;
  if (site) {
    lines.push(`  <link rel="canonical" href="${escapeHtml(site)}">`);
    meta('property', 'og:url', site);
  }
  if (absoluteImage) {
    meta('property', 'og:image', absoluteImage);
    meta('property', 'og:image:alt', metadata.shareImageAlt);
  }
  meta('name', 'twitter:card', absoluteImage ? 'summary_large_image' : 'summary');
  meta('name', 'twitter:title', metadata.title);
  meta('name', 'twitter:description', metadata.description);
  if (absoluteImage) {
    meta('name', 'twitter:image', absoluteImage);
    meta('name', 'twitter:image:alt', metadata.shareImageAlt);
  }
  lines.push('  <!-- DSH-GO metadata:end -->');
  return lines.join('\n');
}
const metadataRegion = /^  <!-- DSH-GO metadata:start -->[\s\S]*?  <!-- DSH-GO metadata:end -->/m;
export function applyMetadata(html, metadata) {
  if (!metadataRegion.test(html)) throw new Error('index.html 缺少元信息标记，请恢复 metadata:start / metadata:end 区块。');
  const newline = html.includes('\r\n') ? '\r\n' : '\n';
  return html.replace(metadataRegion, () => metadataBlock(metadata).replace(/\n/g, newline));
}
export function printReport({ errors, warnings }) {
  for (const message of errors) console.error(`[错误] ${message}`);
  for (const message of warnings) console.warn(`[提醒] ${message}`);
  console.log(`内容自检：${errors.length} 项错误，${warnings.length} 项提醒。`);
  if (errors.length) console.log('当前尚未达到正式发布要求。交付模板保留待填资料时出现这些错误是预期的，请勿把语法通过当作资料已填好。');
  else console.log('本地配置检查通过。请逐项确认提醒，再实测下载、二维码、外链和实际分享效果；本检查不联网，也不识别二维码。');
}
