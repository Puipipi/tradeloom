import { PET_LIMITS } from './generated/workshop-data';
import { WorkshopArchive } from './workshop-archive';
import { encoder, requireWorkshop as need, WorkshopError, type SubmissionMeta } from './workshop-common';
import { isPreviewImage, previewImage, type PreviewInfo } from './workshop-image';
import { validatePack, VALIDATOR_VERSION, type PackSummary } from './workshop-pack';

const FILE_PAGE_BYTES = 512 * 1024;
export interface InspectionCheck { level: 'pass' | 'error' | 'info'; code: string; message: string }
export interface InspectionFile {
  index: number; path: string; size: number; compressedSize: number;
  preview: (PreviewInfo & { url: string }) | null;
  previewIssue: { code: string; message: string } | null;
}
export interface Inspection {
  status: 'valid' | 'invalid' | 'not_uploaded'; validator: string; summary?: PackSummary;
  checks: InspectionCheck[]; files: InspectionFile[]; nextFileCursor: string | null;
}
function previewIssue(error: WorkshopError): { code: string; message: string } {
  const messages: Record<string, string> = {
    preview_size: '图片文件须非空且不超过8MiB。',
    preview_dimensions: '图片须在4096×4096边长内，且宽×高×4不超过16MiB。',
    preview_format: '图片结构、尺寸声明或文件结束位置不符合预览规则。',
    preview_unsupported: '这个图片编码或扩展不在审核台的预览支持范围内。',
    preview_animated: '审核台不预览动画图片。',
    png_animated: '审核台不预览动画图片。',
  };
  return { code: `workshop_${error.code}`, message: messages[error.code] ??
    (error.code.startsWith('png_') || error.code.startsWith('zlib_') || error.code.startsWith('inflate_') ? 'PNG完整校验未通过。' : '图片成员读取或校验未通过。') };
}
export function emptyInspection(): Inspection {
  return { status: 'not_uploaded', validator: VALIDATOR_VERSION, checks: [
    { level: 'info', code: 'archive_not_uploaded', message: '该投稿尚未上传经过校验的包。' },
  ], files: [], nextFileCursor: null };
}
export function inspectionPage(url: URL): { cursor: number; limit: number } {
  const cursor = url.searchParams.get('filesCursor') ?? '0', limit = url.searchParams.get('filesLimit') ?? '50';
  need(/^(?:0|[1-9][0-9]{0,3})$/.test(cursor) && Number(cursor) <= 1000, 'bad_file_cursor');
  need(/^[1-9][0-9]{0,2}$/.test(limit) && Number(limit) <= 100, 'bad_limit');
  return { cursor: Number(cursor), limit: Number(limit) };
}
export function sortedFiles(zip: WorkshopArchive) {
  return [...zip.files.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export function inspectPack(bytes: Uint8Array, meta: SubmissionMeta, sid: string, maxMocVersion: number, page: { cursor: number; limit: number }): Inspection {
  const result: Inspection = { status: 'valid', validator: VALIDATOR_VERSION, checks: [], files: [], nextFileCursor: null };
  // Do not keep an archive index or authority envelope alive during the full
  // package validator. That validator already releases member buffers in turn.
  try {
    result.summary = validatePack(bytes, meta, maxMocVersion);
    result.checks.push({ level: 'pass', code: 'package_validation_passed', message: '当前完整包校验器复核通过；校验器标识与结果见摘要。' });
  } catch (error) {
    if (!(error instanceof WorkshopError) || error.status >= 500) throw error;
    result.status = 'invalid'; result.checks.push({ level: 'error', code: `workshop_${error.code}`, message: '完整包复核在此错误处停止；这不是全部潜在问题的清单。' });
  }
  result.checks.push(
    { level: 'info', code: 'preview_validation_scope', message: 'PNG逐像素校验；JPEG/WebP只检查受限结构与尺寸，仍可能在浏览器解码失败。预览不改变包是否通过校验。' },
    { level: 'info', code: 'manual_review_required', message: '许可、来源与内容需人工审核；MOC版本头通过不证明Core一致性或设备显示效果。此页不执行脚本或模型。' },
  );
  let zip: WorkshopArchive;
  try { zip = new WorkshopArchive(bytes, 1000); }
  catch (error) {
    if (!(error instanceof WorkshopError) || error.status >= 500) throw error;
    result.status = 'invalid';
    if (!result.checks.some(check => check.code === `workshop_${error.code}`)) result.checks.push({ level: 'error', code: `workshop_${error.code}`, message: '无法安全读取ZIP文件清单。' });
    return result;
  }
  const members = sortedFiles(zip); need(page.cursor <= members.length, 'bad_file_cursor');
  let totalBytes = 2, next = page.cursor;
  for (; next < members.length && result.files.length < page.limit; next++) {
    const member = members[next]!;
    const item: InspectionFile = { index: next, path: member.name, size: member.size, compressedSize: member.packed, preview: null, previewIssue: null };
    if (isPreviewImage(member.name)) {
      try {
        need(member.size > 0 && member.size <= PET_LIMITS.sheetBytes, 'preview_size');
        const info = previewImage(zip.read(member.name, PET_LIMITS.sheetBytes), member.name);
        item.preview = { ...info, url: `/api/workshop/v1/admin/submissions/${sid}/preview?file=${next}` };
      } catch (error) {
        if (!(error instanceof WorkshopError) || error.status >= 500) throw error;
        item.previewIssue = previewIssue(error);
      }
    }
    const size = encoder.encode(JSON.stringify(item)).length + (result.files.length ? 1 : 0);
    if (totalBytes + size > FILE_PAGE_BYTES) {
      // ZIP name length is uint16; even control-character JSON escaping keeps
      // one row below this cap. Do not silently truncate a path or skip a row.
      need(result.files.length > 0, 'inspection_page_size', 503); break;
    }
    result.files.push(item); totalBytes += size;
  }
  result.nextFileCursor = next < members.length ? String(next) : null;
  return result;
}
export function readPreview(bytes: Uint8Array, index: string | null): { bytes: Uint8Array; info: PreviewInfo } {
  need(index !== null && /^(?:0|[1-9][0-9]{0,2})$/.test(index), 'bad_file_cursor');
  const zip = new WorkshopArchive(bytes, 1000), member = sortedFiles(zip)[Number(index)];
  need(member, 'not_found', 404); need(isPreviewImage(member.name), 'preview_unsupported');
  need(member.size > 0 && member.size <= PET_LIMITS.sheetBytes, 'preview_size');
  const data = zip.read(member.name, PET_LIMITS.sheetBytes), info = previewImage(data, member.name);
  return { bytes: data, info };
}
