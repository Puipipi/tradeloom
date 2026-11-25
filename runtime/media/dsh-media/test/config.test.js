import test from 'node:test';
import assert from 'node:assert/strict';
import z from '@deepseek-ai/schemastery';
import { redactSecrets } from '@deepseek-ai/dsh-settings';
import {
  Config, CATALOG, CATALOG_META_KEY, CREDENTIAL_SLOTS, DEFAULT_FIELD_NAMES, runtimeSnapshot,
  validateCatalogHeaderModel, validatePresets,
} from '../src/config.js';

const service = overrides => ({
  id: 'office', enabled: true, keyRef: CREDENTIAL_SLOTS[0],
  ...overrides,
});

test('empty setup has no service and every writable secret has a fixed target', () => {
  const config = Config({});
  assert.deepEqual(runtimeSnapshot(config).services, []);
  const slots = config.credentials.get();
  for (let i = 0; i < CREDENTIAL_SLOTS.length; i += 1) {
    assert.equal(slots['slot' + (i + 1)].credentialRef, CREDENTIAL_SLOTS[i]);
    assert.equal(slots['slot' + (i + 1)].apiKey, '');
  }
  assert.throws(() => Config({
    credentials: { slot1: { credentialRef: CREDENTIAL_SLOTS[1] } },
  }));
});

test('ordinary settings reject a misplaced secret without echoing its value', () => {
  const misplaced = 'test-secret-MUST-NOT-APPEAR-IN-ERROR';
  assert.throws(() => Config({
    credentials: { slot1: { apiKey: misplaced } },
  }), error => {
    assert.equal(error.message, '密钥只能通过凭据服务写入。');
    assert.equal(error.message.includes(misplaced), false);
    return true;
  });
});

test('real secret redaction removes sentinel fields but keeps constant target references', () => {
  const config = Config({});
  const result = redactSecrets(Config, { credentials: config.credentials.get() });
  assert.equal(result.secrets.length, 4);
  for (let i = 0; i < CREDENTIAL_SLOTS.length; i += 1) {
    const key = 'slot' + (i + 1);
    assert.equal(result.value.credentials[key].credentialRef, CREDENTIAL_SLOTS[i]);
    assert.equal(Object.hasOwn(result.value.credentials[key], 'apiKey'), false);
    assert.ok(result.secrets.some(slot => slot.path.join('.') === 'credentials.' + key + '.apiKey'));
  }
});

test('schema serialization preserves extra catalog without creating a catalog value', () => {
  const restored = new z(Config.toJSON());
  const metadata = restored.dict.services.meta.extra[CATALOG_META_KEY];
  assert.deepEqual(metadata, CATALOG);
  assert.deepEqual(metadata.presets, CATALOG.presets);
  assert.equal(metadata.presets.length, 8);
  assert.equal(restored.dict.services.meta.volatile, true);
  assert.equal(Object.hasOwn(restored.dict, 'catalog'), false);
  assert.equal(Object.hasOwn(restored.dict, 'presets'), false);
  const config = Config({ services: [service()] });
  assert.equal(Object.hasOwn(runtimeSnapshot(config), 'catalog'), false);
  assert.equal(JSON.stringify(config.services.get()).includes(CATALOG_META_KEY), false);
  // f87 schemaSections routes intersect/object nodes to groups before leaf roles.
  // Keep the secret as a leaf so kindOf sees its secret role.
  for (const slot of Object.values(restored.dict.credentials.dict)) {
    const secret = slot.dict.apiKey;
    assert.equal(secret.meta.role, 'secret');
    let effective = secret;
    while (effective.type === 'transform' || effective.type === 'lazy') effective = effective.inner;
    assert.equal(['object', 'intersect'].includes(effective.type), false);
  }
});

test('service IDs are unique; an explicit key reference is mandatory', () => {
  assert.throws(() => Config({ services: [service(), service()] }));
  assert.throws(() => Config({ services: [service({ id: 'office-east' })] }));
  assert.throws(() => Config({ services: [service({ id: 'Office' })] }));
  assert.throws(() => Config({ services: [{ id: 'office', enabled: true }] }));
  const config = Config({ services: [service(), service({ id: 'studio' })] });
  const parsed = runtimeSnapshot(config).services;
  // Sharing exists only because the two entries explicitly choose the same ref.
  assert.deepEqual(parsed.map(row => row.keyRef), [CREDENTIAL_SLOTS[0], CREDENTIAL_SLOTS[0]]);
  assert.equal(runtimeSnapshot(Config({ services: [service({ id: 'renamed' })] }))
    .services[0].keyRef, CREDENTIAL_SLOTS[0]);
});

test('unsupported model, protocol parameter, insecure URL and excessive limits are rejected', () => {
  for (const overrides of [
    { models: 'invented-model' },
    { models: 'gpt-image-2,gpt-image-2' },
    { responseFormat: 'url' },
    { profile: 'openai-compatible' },
    { baseUrl: 'http://example.test/v1' },
    { baseUrl: 'https://name:password@example.test/v1' },
    { baseUrl: 'https://example.test/v1?key=not-a-real-key' },
  ]) assert.throws(() => Config({ services: [service(overrides)] }));
  assert.throws(() => Config({ limits: { maxImages: 5 } }));
  assert.throws(() => Config({ limits: { maxImages: 1.5 } }));
  const lowered = runtimeSnapshot(Config({ limits: { maxImages: 1 } }));
  assert.equal(lowered.limits.maxImages, 1);
});

test('catalog entries have explicit evidence, conservative supported dimensions and no guessed price', () => {
  for (const model of CATALOG.models) {
    assert.ok(['image', 'video'].includes(model.kind));
    assert.ok(model.maxRefs >= 0 && model.maxRefs <= 1);
    assert.equal(typeof model.edit, 'boolean');
    assert.equal(Object.hasOwn(model, 'price'), false);
    assert.ok(model.sources.length > 0);
    for (const id of model.sources) {
      const source = CATALOG.sources.find(item => item.id === id);
      assert.ok(source);
      assert.equal(source.level, 'official-page-read');
      assert.match(source.retrieved ?? source.verifiedAt, /^2026-10-(28|30)$/);
    }
    for (const [ratio, size] of Object.entries(model.aspectSizes)) {
      const [a, b] = ratio.split(':').map(Number);
      const [w, h] = size.split('x').map(Number);
      assert.equal(w * b, h * a);
      assert.ok(model.sizes.includes(size));
    }
  }
  assert.throws(() => CATALOG.models.push({ id: 'mutation' }));
});

test('documented Gemini compatibility configuration reaches the installed model', () => {
  const config = Config({ services: [service({
    id: 'gemini', provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    profile: 'openai-compatible', responseFormat: 'b64_json',
    models: 'gemini-2.5-flash-image', keyRef: CREDENTIAL_SLOTS[1],
  })] });
  const selected = runtimeSnapshot(config).services[0];
  assert.equal(selected.profile, 'openai-compatible');
  assert.equal(selected.responseFormat, 'b64_json');
  assert.deepEqual(selected.modelIds, ['gemini-2.5-flash-image']);
  assert.equal(selected.keyRef, CREDENTIAL_SLOTS[1]);
  const model = CATALOG.models.find(item => item.id === selected.modelIds[0]);
  assert.equal(model.maxN, 1);
  assert.deepEqual(model.responseFormats, ['b64_json']);
  assert.deepEqual(model.sizes, []);
  assert.deepEqual(model.qualities, []);
  assert.deepEqual(model.ratios, []);
  assert.deepEqual(model.aspectSizes, {});
});

test('Gemini requires the evidenced explicit response format and cannot mix protocol models', () => {
  const gemini = service({
    id: 'gemini', provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    profile: 'openai-compatible', responseFormat: 'b64_json',
    models: 'gemini-2.5-flash-image', keyRef: CREDENTIAL_SLOTS[1],
  });
  for (const overrides of [
    { responseFormat: '' },
    { responseFormat: undefined },
    { responseFormat: 'url' },
    { profile: 'openai-gpt-image', responseFormat: '' },
    { models: 'gemini-2.5-flash-image,gpt-image-2' },
  ]) assert.throws(() => Config({ services: [{ ...gemini, ...overrides }] }));
  const both = runtimeSnapshot(Config({ services: [service(), gemini] }));
  assert.deepEqual(both.services.map(item => item.profile),
    ['openai-gpt-image', 'openai-compatible']);
  assert.deepEqual(both.services.map(item => item.keyRef),
    [CREDENTIAL_SLOTS[0], CREDENTIAL_SLOTS[1]]);
});


test('every advertised catalog value can be written with the shared header grammar', () => {
  for (const model of CATALOG.models) assert.equal(validateCatalogHeaderModel(model), model);
  // Syntax-only future-video fixture; the installed M0 catalog remains image-only.
  const video = { kind: 'video', label: 'Video model', id: 'video/model:1',
    ratios: ['1:1', '16:9', '99:99'], resolutions: ['100p', '720p', '9999p'] };
  assert.equal(validateCatalogHeaderModel(video), video);
  assert.equal(CATALOG.capabilities.video, true);
  assert.equal(CATALOG.models.some(model => model.kind === 'video'), true);
});

test('catalog rejects values or identities the header cannot faithfully express', () => {
  const image = { kind: 'image', label: 'Image model', id: 'image/model:1',
    ratios: ['1:1'], qualities: ['high'] };
  const invalidImages = [
    { ratios: ['0:1'] }, { ratios: ['01:1'] }, { ratios: ['100:1'] },
    { ratios: ['1:1 · 2 张'] }, { ratios: [1] }, { ratios: null },
    { qualities: ['high quality'] }, { qualities: ['质量=high'] },
    { qualities: ['a'.repeat(33)] }, { qualities: [null] },
    { label: '' }, { label: '模型 '.repeat(54) }, { label: ' Image model' },
    { label: '1.5p' }, { label: '-3:4' }, { label: '2张' },
    { label: '质量=high' }, { label: 'Model〈office/id〉' },
    { label: 'bad' + String.fromCharCode(0x85) },
    { label: String.fromCharCode(0xd800) },
    { id: 'bad id' }, { id: 'a'.repeat(161) }, { id: '/leading' },
    { kind: 'audio' },
  ];
  for (const patch of invalidImages) {
    assert.throws(() => validateCatalogHeaderModel({ ...image, ...patch }),
      { message: '图像服务配置无效，请检查服务、模型和凭据引用。' });
  }
  const video = { kind: 'video', label: 'Video model', id: 'video/model', ratios: [] };
  for (const value of ['4k', '720P', '99p', '0100p', '10000p', '720p · Inject', null]) {
    assert.throws(() => validateCatalogHeaderModel({ ...video, resolutions: [value] }));
  }
});

test('catalog publishes exactly the eight provider presets the settings page offers', () => {
  const expected = [
    ['ark-image', '火山方舟 · 图片', 'Volcengine Ark · Image', 'ark', 'ark-image',
      'https://ark.cn-beijing.volces.com', '', ['doubao-seedream-5-0-pro-260628'], 'image', 'ark'],
    ['ark-video', '火山方舟 · 视频', 'Volcengine Ark · Video', 'ark', 'ark-video',
      'https://ark.cn-beijing.volces.com', '', ['doubao-seedance-2-5-260628'], 'video', 'ark'],
    ['aliyun-image', '阿里云百炼 · 图片', 'Alibaba Model Studio · Image', 'aliyun', 'ali-wan-image',
      'https://dashscope.aliyuncs.com', '', ['wan2.7-image'], 'image', 'aliyun'],
    ['aliyun-video', '阿里云百炼 · 视频', 'Alibaba Model Studio · Video', 'aliyun', 'ali-video',
      'https://dashscope.aliyuncs.com', '', ['wan2.7-t2v-2026-06-12', 'wan2.7-i2v-2026-04-25'], 'video', 'aliyun'],
    ['siliconflow-image', '硅基流动 · 图片', 'SiliconFlow · Image', 'siliconflow', 'silicon-image',
      'https://api.siliconflow.cn', '', ['Qwen/Qwen-Image', 'Qwen/Qwen-Image-Edit-2509'], 'image', 'siliconflow'],
    ['siliconflow-video', '硅基流动 · 视频', 'SiliconFlow · Video', 'siliconflow', 'silicon-video',
      'https://api.siliconflow.cn', '', ['Wan-AI/Wan2.2-T2V-A14B', 'Wan-AI/Wan2.2-I2V-A14B'], 'video', 'siliconflow'],
    ['openai-image', 'OpenAI · 图片', 'OpenAI · Image', 'openai', 'openai-gpt-image',
      'https://api.openai.com/v1', '', ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'], 'image', 'openai'],
    ['gemini-image', 'Gemini · 图片', 'Gemini · Image', 'gemini', 'openai-compatible',
      'https://generativelanguage.googleapis.com/v1beta/openai', 'b64_json', ['gemini-2.5-flash-image'], 'image', 'gemini'],
  ];
  assert.deepEqual(CATALOG.presets.map(preset => [
    preset.id, preset.label, preset.labelEn, preset.provider, preset.profile,
    preset.baseUrl, preset.responseFormat, preset.models, preset.kind, preset.keyGroup,
  ]), expected);
  const fields = ['id', 'label', 'labelEn', 'provider', 'profile', 'baseUrl',
    'responseFormat', 'models', 'kind', 'keyGroup'];
  for (const preset of CATALOG.presets) {
    assert.deepEqual(Object.keys(preset).sort(), [...fields].sort());
    for (const id of preset.models) {
      const model = CATALOG.models.find(item => item.id === id);
      assert.ok(model);
      assert.equal(model.profile, preset.profile);
      assert.equal(model.kind, preset.kind);
    }
  }
  assert.throws(() => CATALOG.presets.push({}), TypeError);
});

test('preset validation rejects templates the App could not safely instantiate', () => {
  const preset = overrides => ({ ...structuredClone(CATALOG.presets[0]), ...overrides });
  const invalidMessage = { message: '图像服务配置无效，请检查服务、模型和凭据引用。' };
  assert.deepEqual(validatePresets([]), []);
  assert.equal(validatePresets(structuredClone(CATALOG.presets)).length, 8);
  for (const build of [
    () => validatePresets({}),
    () => validatePresets(Array.from({ length: 17 }, (_, index) => preset({ id: 'preset-' + index }))),
    () => validatePresets([preset(), preset()]),
    () => validatePresets([preset({ id: 'Ark' })]),
    () => validatePresets([preset({ id: 'ark_image' })]),
    () => validatePresets([preset({ id: 'a'.repeat(33) })]),
    () => validatePresets([preset({ label: '' })]),
    () => validatePresets([preset({ label: 'a'.repeat(81) })]),
    () => validatePresets([preset({ labelEn: '' })]),
    () => validatePresets([preset({ labelEn: 'a'.repeat(81) })]),
    () => validatePresets([preset({ provider: '' })]),
    () => validatePresets([preset({ provider: 'a'.repeat(81) })]),
    () => validatePresets([preset({ provider: 'ark' + String.fromCharCode(0) })]),
    () => validatePresets([preset({ profile: 'openai-gpt-image' })]),
    () => validatePresets([preset({ baseUrl: 'http://ark.cn-beijing.volces.com' })]),
    () => validatePresets([preset({ baseUrl: 'https://user:pass@ark.cn-beijing.volces.com' })]),
    () => validatePresets([preset({ baseUrl: 'https://ark.cn-beijing.volces.com?key=not-a-key' })]),
    () => validatePresets([preset({ baseUrl: 'https://ark.cn-beijing.volces.com#fragment' })]),
    () => validatePresets([preset({ baseUrl: 'https://example.test' })]),
    () => validatePresets([preset({ responseFormat: 'json' })]),
    () => validatePresets([preset({ responseFormat: 'url' })]),
    () => validatePresets([preset({
      id: 'gemini-bad-format',
      provider: 'gemini',
      profile: 'openai-compatible',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      responseFormat: 'url',
      models: ['gemini-2.5-flash-image'],
      kind: 'image',
      keyGroup: 'gemini',
    })]),
    () => validatePresets([preset({ models: [] })]),
    () => validatePresets([preset({ models: ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-pro-260628'] })]),
    () => validatePresets([preset({ models: Array(17).fill('doubao-seedream-5-0-pro-260628') })]),
    () => validatePresets([preset({ models: ['invented-model'] })]),
    () => validatePresets([preset({ models: ['wan2.7-image'] })]),
    () => validatePresets([preset({ models: ['doubao-seedance-2-5-260628'] })]),
    () => validatePresets([preset({ kind: 'audio' })]),
    () => validatePresets([preset({ keyGroup: 'Ark' })]),
    () => validatePresets([preset({ keyGroup: 'ark_image' })]),
  ]) assert.throws(build, invalidMessage);
});

test('per-kind defaults are optional strings and reach the runtime snapshot unchanged', () => {
  assert.deepEqual(DEFAULT_FIELD_NAMES,
    ['serviceId', 'modelId', 'imageServiceId', 'imageModelId', 'videoServiceId', 'videoModelId']);
  assert.deepEqual(runtimeSnapshot(Config({})).defaults, {
    serviceId: '', modelId: '', imageServiceId: '', imageModelId: '', videoServiceId: '', videoModelId: '',
  });
  const chosen = {
    imageServiceId: 'ark_image', imageModelId: 'doubao-seedream-5-0-pro-260628',
    videoServiceId: 'ark_video', videoModelId: 'doubao-seedance-2-5-260628',
  };
  assert.deepEqual(runtimeSnapshot(Config({ defaults: chosen })).defaults,
    { serviceId: '', modelId: '', ...chosen });
  assert.throws(() => Config({ defaults: { imageServiceId: 1 } }));
  assert.throws(() => Config({ defaults: { imageModelId: {} } }));
  assert.throws(() => Config({ defaults: { imageServiceId: 'a'.repeat(33) } }));
  assert.throws(() => Config({ defaults: { videoModelId: 'm'.repeat(161) } }));
});

test('settings copy names arbitrary credentials while keeping the legacy slots', () => {
  const { keyRef } = Config.dict.services.inner.inner.dict;
  assert.match(keyRef.meta.description, /任意已配置的凭据/);
  assert.match(keyRef.meta.description, /DSH_MEDIA_ARK_API_KEY/);
  assert.match(keyRef.meta.description, /旧版固定槽仍可用/);
  assert.match(Config.dict.services.meta.description, /图片或视频/);
  assert.match(Config.dict.credentials.meta.description, /旧版固定密钥槽/);
  assert.match(Config.dict.credentials.meta.description, /按服务自动创建凭据/);
});
