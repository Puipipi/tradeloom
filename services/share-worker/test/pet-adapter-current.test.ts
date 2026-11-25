import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { validateAdapter, validatePetCatalog } from '../src/pet-catalog';

const moc = 'a'.repeat(64);
const checked = (extra: object) => validateAdapter({ adapter: 1, moc, ...extra }, moc);

it('preserves current stage id lists, pose and horizontal touch zones', () => {
  expect(checked({
    params: { ParamEyeLOpen: { id: ['EyeL', 'EyeL2'], scale: -1000, offset: 1000 } },
    emotions: { shy: { expression: '笑顔', face: { ParamAngleZ: 30, 眉: -1000 } } },
    actions: { wave: { motion: '挥手' } },
    zones: [{ id: 'head', from: 0, to: 0.3, xFrom: -1.5, xTo: 1.5 }],
    framing: { zoom: 0.3, y: -1 }, tail: ['Tail'], pose: { Watermark: 0 },
  })).toBe(true);
});

it('accepts exactly the semantic vocabularies already checked by the c76 App', () => {
  const source = readFileSync(new URL('../../../app/lib/companion/companion_adapt_contract.dart', import.meta.url), 'utf8');
  const block = (name: string) => source.split(`const ${name} = `)[1]!.split(';')[0]!;
  const names = (name: string) => [...block(name).matchAll(name === 'companionAdaptParams' ? /'([^']+)'\s*:/g : /'([^']+)'/g)].map(m => m[1]!);
  expect(['companionAdaptParams', 'companionAdaptEmotions', 'companionAdaptActions', 'companionAdaptZones'].map(name => names(name).length)).toEqual([18, 10, 12, 5]);
  for (const name of names('companionAdaptParams')) expect(checked({ params: { [name]: { id: 'ModelId' } } })).toBe(true);
  for (const name of names('companionAdaptEmotions')) expect(checked({ emotions: { [name]: { expression: 'ModelExpression' } } })).toBe(true);
  for (const name of names('companionAdaptActions')) expect(checked({ actions: { [name]: { motion: 'ModelMotion' } } })).toBe(true);
  for (const name of names('companionAdaptZones')) expect(checked({ zones: [{ id: name, from: 0, to: 1 }] })).toBe(true);
  for (const extra of [{ params: { unknown: { id: 'ModelId' } } }, { emotions: { joy: { expression: 'Smile' } } },
    { actions: { unknown: { motion: 'Wave' } } }, { zones: [{ id: 'ear', from: 0, to: 1 }] }, { toggles: { hide: ['Watermark'] } }])
    expect(checked(extra)).toBe(false);
});

it('rejects values that would silently default or clamp in the current stage profile', () => {
  for (const extra of [
    { params: { ParamAngleX: { id: [] } } }, { params: { ParamAngleX: { id: 'Eye', scale: 0 } } },
    { params: { ParamAngleX: { id: 'Eye', scale: 1000.1 } } },
    { zones: [{ id: 'head', from: 0, to: 1, xFrom: 0.5, xTo: -0.5 }] },
    { zones: [{ id: 'head', from: 0, to: 1, xFrom: -1.51 }] },
    { framing: { zoom: 0.299 } }, { framing: { zoom: 3.001 } }, { framing: { y: 1.001 } },
    { pose: [] }, { pose: { Switch: 1000.1 } },
  ]) expect(checked(extra)).toBe(false);
});

it('matches the Python producer Unicode nonempty rule and rejects isolated surrogates', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/pet-market-builder.json', import.meta.url), 'utf8'));
  fixture.pets.pets[0].author = '\ufeff';
  expect(validatePetCatalog(fixture.pets, 'pets')).toBe(true);
  for (const author of ['\u0085', '\u001c', '\ud800']) {
    fixture.pets.pets[0].author = author;
    expect(validatePetCatalog(fixture.pets, 'pets')).toBe(false);
  }
  expect(checked({ notes: '🐳'.repeat(4000) })).toBe(true);
  expect(checked({ notes: '🐳'.repeat(4001) })).toBe(false);
});

it('does not treat grammar acceptance as target identity or model verification', () => {
  expect(checked({ params: { ParamAngleX: { id: 'UnknownUntilTheAppProbesTheModel' } } })).toBe(true);
  expect(validateAdapter({ adapter: 1, moc: 'b'.repeat(64) }, moc)).toBe(false);
  expect(validateAdapter({ adapter: 1, moc: 'not-a-hash' }, 'not-a-hash')).toBe(false);
  expect(checked({ script: 'fetch("https://example.org")' })).toBe(false);
});
