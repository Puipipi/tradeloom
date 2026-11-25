import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { petMarketProfile, writePetMarketProfile } from '../scripts/build-pet-market-profile.mjs';
import { PET_MARKET_PROFILE } from '../src/generated/pet-market-profile';

const worker = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('rejects drift between the current sources and the built staging profile', () => {
  const current = writePetMarketProfile(worker, true);
  expect(current.fingerprint).toBe(PET_MARKET_PROFILE);
  expect(current.inputs.map(([path]: [string, string]) => path)).toEqual(expect.arrayContaining([
    'src/pet-catalog.ts', 'src/pet-market-io.ts', 'src/pet-market-stage.ts', 'src/pet-market-state.ts', 'src/pet-market.ts',
    'scripts/build-pet-market-profile.mjs', 'scripts/build-site.mjs', 'package-lock.json',
  ]));
});

it('automatically invalidates a receipt profile for validator, IO or newly added helper source changes', () => {
  const copy = mkdtempSync(join(tmpdir(), 'pet-market-profile-'));
  try {
    for (const path of ['src', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json'])
      cpSync(join(worker, path), join(copy, path), { recursive: true });
    const original = writePetMarketProfile(copy).fingerprint;
    for (const path of ['src/pet-catalog.ts', 'src/pet-market-io.ts', 'src/new-validation-helper.ts']) {
      const target = join(copy, path);
      const prior = path.includes('new-validation') ? '' : readFileSync(target, 'utf8');
      writeFileSync(target, prior + '\n// A changed validation input.\n');
      expect(petMarketProfile(copy).fingerprint).not.toBe(original);
      expect(() => writePetMarketProfile(copy, true)).toThrow('profile is stale');
      if (prior) writeFileSync(target, prior);
      else rmSync(target);
    }
    mkdirSync(join(copy, 'src/generated'), { recursive: true });
    writeFileSync(join(copy, 'src/generated/unrelated.ts'), 'export const generated = true;\n');
    expect(writePetMarketProfile(copy, true).fingerprint).toBe(original);
  } finally { rmSync(copy, { recursive: true, force: true }); }
});
