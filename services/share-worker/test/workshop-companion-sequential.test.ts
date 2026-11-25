// Small original synthetic data only. These are semantic regression tests,
// not a heap-limit test, real Cubism models, or a concurrent workload.
import { describe, expect, it } from 'vitest';
import { WorkshopArchive } from '../src/workshop-archive';
import { validateCompanion } from '../src/workshop-pack';
import { BASE_META, metaFor, png, zip } from './workshop-fixtures';

type Members = [string, Uint8Array][];
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function modelManifest() {
  return { Version: 3, FileReferences: {
    Moc: 'sample.moc3', Textures: ['texture.png'],
    Physics: 'physics.json', Pose: 'pose.json', UserData: 'userdata.json', DisplayInfo: 'display.json',
    Expressions: [{ Name: 'Synthetic smile', File: 'expression.json' }],
    Motions: { Idle: [{ File: 'motion.json', Sound: 'sound.wav' }] },
  } };
}
type References = ReturnType<typeof modelManifest>['FileReferences'];
function modelMembers(home: string): Members {
  return [
    [`${home}sample.model3.json`, json(modelManifest())],
    [`${home}sample.moc3`, Buffer.from([77, 79, 67, 51, 6, 0, 0, 0])],
    [`${home}texture.png`, png(2, 2)],
    ...['physics', 'pose', 'userdata', 'display', 'expression', 'motion'].map(name =>
      [`${home}${name}.json`, json({ Version: 3, Parameters: [{ Id: `Synthetic-${name}`, Value: 0 }] })] as [string, Uint8Array]),
    [`${home}sound.wav`, Buffer.from('synthetic nonempty audio placeholder')],
  ];
}
function members(): Members {
  return [
    ['character/character.json', json({ schema: 1, name: 'Synthetic model', model: 'primary/sample.model3.json',
      author: BASE_META.author, license: BASE_META.license, source: BASE_META.source })],
    ...modelMembers('character/primary/'), ...modelMembers('character/secondary/'),
    ...Array.from({ length: 6 }, (_, i) => [`character/data-${i}.json`, json({ Values: [i, i + 1], Notes: 'Ordinary optional data' })] as [string, Uint8Array]),
  ];
}
function replaceJson(files: Members, path: string, update: (value: any) => void): void {
  const entry = files.find(([name]) => name === path)!;
  const value = JSON.parse(Buffer.from(entry[1]).toString('utf8')); update(value); entry[1] = json(value);
}
function validate(bytes: Uint8Array) { return validateCompanion(bytes, metaFor(bytes, { kind: 'companion' }), 6); }

describe('companion per-member JSON validation', () => {
  const orders: [string, (files: Members) => Members][] = [
    ['character and models before referenced data', files => files],
    ['character after referenced models and data', files => files.reverse()],
    ['all JSON before binary members', files => files.sort(([a], [b]) => Number(b.endsWith('.json')) - Number(a.endsWith('.json')))],
    ['all binary members before JSON', files => files.sort(([a], [b]) => Number(a.endsWith('.json')) - Number(b.endsWith('.json')))],
  ];
  for (const compressed of [false, true]) {
    it.each(orders)(`accepts %s (${compressed ? 'deflated' : 'stored'})`, (_name, order) => {
      const files = order(members()), bytes = zip(files, compressed);
      expect(validate(bytes)).toMatchObject({ files: files.length,
        expandedBytes: files.reduce((sum, [, data]) => sum + data.length, 0), mocVersions: [6] });
    });
  }

  const badReferences: [string, (refs: References) => void][] = [
    ['Moc', refs => { refs.Moc = 'missing.moc3'; }],
    ['Textures', refs => { refs.Textures = ['missing.png']; }],
    ['Physics', refs => { refs.Physics = 'missing.json'; }],
    ['Pose', refs => { refs.Pose = 'missing.json'; }],
    ['UserData', refs => { refs.UserData = 'missing.json'; }],
    ['DisplayInfo', refs => { refs.DisplayInfo = 'missing.json'; }],
    ['Expressions', refs => { refs.Expressions[0]!.File = 'missing.json'; }],
    ['Motions', refs => { refs.Motions.Idle[0]!.File = 'missing.json'; }],
    ['motion Sound', refs => { refs.Motions.Idle[0]!.Sound = 'missing.wav'; }],
  ];
  it.each(badReferences)('checks %s in an unselected model', (_name, update) => {
    const files = members();
    replaceJson(files, 'character/secondary/sample.model3.json', value => update(value.FileReferences));
    expect(() => validate(zip(files))).toThrow('companion_reference');
  });
  it('checks the version of an unselected model', () => {
    const files = members();
    replaceJson(files, 'character/secondary/sample.model3.json', value => { value.Version = 2; });
    expect(() => validate(zip(files))).toThrow('companion_model');
  });
  it('requires a validated character manifest', () => {
    expect(() => validate(zip(members().filter(([name]) => name !== 'character/character.json')))).toThrow('companion_metadata');
  });
  it('requires the selected JSON to be a model3 file', () => {
    const files = members();
    replaceJson(files, 'character/character.json', value => { value.model = 'data-0.json'; });
    expect(() => validate(zip(files))).toThrow('companion_model');
  });
  it.each([
    ['duplicate keys', '{"value":1,"value":2}', 'json_duplicate_key'],
    ['unfinished JSON', '{"value":', 'json_syntax'],
    ['a non-object JSON value', '[]', 'companion_json'],
  ])('fully validates late, unreferenced JSON with %s', (_name, data, code) => {
    const files = members(); files.push(['character/late.json', Buffer.from(data!)]);
    expect(() => validate(zip(files))).toThrow(code!);
  });
  it('still checks CRC on a late ordinary data member', () => {
    const files = members(); files.push(['character/late.txt', Buffer.from('ordinary synthetic text')]);
    const bytes = zip(files, false), member = new WorkshopArchive(bytes, 1000).files.get('character/late.txt')!;
    bytes[member.start] = bytes[member.start]! ^ 1;
    expect(() => validate(bytes)).toThrow('archive_member_crc');
  });
  it('still validates a late PNG after all JSON semantics pass', () => {
    const files = members(), late = png(); late[0] = 0;
    files.push(['character/late.png', late]);
    expect(() => validate(zip(files))).toThrow('png_header');
  });
  it('still checks the moc ceiling on a late member', () => {
    const files = members(); files.push(['character/late.moc3', Buffer.from([77, 79, 67, 51, 7])]);
    expect(() => validate(zip(files))).toThrow('companion_moc_version');
  });
});
