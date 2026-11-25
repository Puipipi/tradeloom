import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MAX_MOC_VERSION } from '../src/workshop';
import { WorkshopArchive, strictJson } from '../src/workshop-archive';
import { metadata, PREVIEW_CONTRACT, previewUrl, validPreview, type PreviewSource } from '../src/workshop-common';
import { validatePack } from '../src/workshop-pack';
import { cropPng } from '../src/workshop-png';
import { checkPreviewRequest, derivePreview, validatePublicPng } from '../src/workshop-preview';

// These inputs must come from the real Dart export-contract test. A normal CI
// run without an output directory explicitly skips them, and is not evidence
// of cross-runtime acceptance. A supplied directory never falls back to local
// synthetic ZIP generators when a file is missing or invalid.
const directory = process.env.DSH_WORKSHOP_CONTRACT_OUT;
const fixtures: readonly { stem: string; kind: 'pet' | 'companion'; mode?: PreviewSource; width?: number; height?: number }[] = [
  { stem: 'pet', kind: 'pet' },
  { stem: 'companion', kind: 'companion' },
  { stem: 'pet-unicode', kind: 'pet' },
  { stem: 'companion-unicode', kind: 'companion' },
  { stem: 'pet-idle', kind: 'pet', mode: 'pet-idle', width: 2, height: 1 },
  { stem: 'companion-preview', kind: 'companion', mode: 'companion-preview', width: 2, height: 3 },
];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

for (const fixture of fixtures) it.skipIf(directory === undefined)(`accepts exact Dart export ${fixture.stem}`, async () => {
  expect(directory, 'DSH_WORKSHOP_CONTRACT_OUT must name the App output directory').not.toBe('');
  const bytes = readFileSync(join(directory!, `${fixture.stem}.zip`));
  const meta = metadata(strictJson(readFileSync(join(directory!, `${fixture.stem}.metadata.json`)), 16 * 1024));
  expect(meta.kind).toBe(fixture.kind);
  expect(meta.previewSource).toBe(fixture.mode);
  expect(meta.size).toBe(bytes.length);
  expect(meta.sha256).toBe(digest(bytes));
  checkPreviewRequest(bytes, meta);
  const summary = validatePack(bytes, meta, MAX_MOC_VERSION);
  expect(summary.files).toBeGreaterThan(0);
  const preview = await derivePreview(bytes, meta);
  if (fixture.mode === undefined) {
    expect(preview).toBeUndefined();
  } else {
    expect(preview).toBeDefined();
    const { descriptor, bytes: image } = preview!;
    expect(validPreview(descriptor, meta)).toBe(true);
    expect(descriptor).toEqual({
      path: previewUrl(meta, digest(image)), sha256: digest(image), size: image.length,
      width: fixture.width, height: fixture.height,
    });
    expect(validatePublicPng(image)).toMatchObject({
      width: fixture.width, height: fixture.height, pixels: fixture.width! * fixture.height!,
    });
    const zip = new WorkshopArchive(bytes, fixture.kind === 'pet' ? 256 : 1000);
    if (fixture.kind === 'companion') {
      expect(image).toEqual(zip.read('character/preview.png', PREVIEW_CONTRACT.maxBytes));
    } else {
      expect([...zip.files.keys()].sort()).toEqual(['idle.png', 'pack.json']);
      // The Dart fixture paints a 4x2 sheet and selects frame i=3 (x=2,y=1).
      // The two source pixels below differ from cell 0, so a wrong crop fails.
      expect(cropPng(image, { x: 0, y: 0, width: 2, height: 1 })).toEqual(
        new Uint8Array([100, 80, 43, 255, 140, 80, 44, 255]));
    }
  }
  // A small, non-secret evidence line identifies the bytes actually consumed.
  // It is emitted only after every assertion for this fixture succeeds.
  console.info(`workshop-app-contract ${JSON.stringify({ fixture: fixture.stem,
    archive: { size: bytes.length, sha256: digest(bytes) }, preview: preview?.descriptor ?? null,
    validator: summary.validator })}`);
});
