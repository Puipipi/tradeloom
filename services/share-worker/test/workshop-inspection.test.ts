import { expect, it } from 'vitest';
import { inspectPack, inspectionPage } from '../src/workshop-inspection';
import { metaFor, pet, petManifest, zip } from './workshop-fixtures';

it('keeps readable file inventory when full validation stops at a missing referenced member', () => {
  const bytes = zip([['pack.json', Buffer.from(JSON.stringify(petManifest()))]]), meta = metaFor(bytes);
  const result = inspectPack(bytes, meta, 'a'.repeat(32), 6, { cursor: 0, limit: 50 });
  expect(result.status).toBe('invalid'); expect(result.summary).toBeUndefined();
  expect(result.checks).toContainEqual(expect.objectContaining({ level: 'error', code: 'workshop_archive_member_missing' }));
  expect(result.files.map(file => file.path)).toEqual(['pack.json']); expect(result.files[0]!.preview).toBeNull();
});
it('returns the first bounded validator diagnostic when a ZIP inventory cannot be read safely', () => {
  const bytes = pet().subarray(0, -4), result = inspectPack(bytes, metaFor(bytes), 'a'.repeat(32), 6, { cursor: 0, limit: 50 });
  expect(result.status).toBe('invalid'); expect(result.files).toEqual([]); expect(result.nextFileCursor).toBeNull();
  const errors = result.checks.filter(check => check.level === 'error'); expect(errors).toHaveLength(1); expect(errors[0]!.code).toBe('workshop_archive_directory');
});
it('validates the finite file cursor and per-page count independently of the archive', () => {
  expect(inspectionPage(new URL('https://example.org/detail'))).toEqual({ cursor: 0, limit: 50 });
  expect(inspectionPage(new URL('https://example.org/detail?filesCursor=1000&filesLimit=100'))).toEqual({ cursor: 1000, limit: 100 });
  for (const query of ['filesCursor=-1', 'filesCursor=1001', 'filesCursor=01', 'filesLimit=0', 'filesLimit=101']) {
    expect(() => inspectionPage(new URL('https://example.org/detail?' + query))).toThrow();
  }
  const bytes = pet(); expect(() => inspectPack(bytes, metaFor(bytes), 'a'.repeat(32), 6, { cursor: 3, limit: 50 })).toThrow('bad_file_cursor');
});
