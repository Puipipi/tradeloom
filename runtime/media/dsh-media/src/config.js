import { readFileSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { cnyMicros } from './budget-ledger.js';
import { formatGenerationMessage } from './header.js';

export const CATALOG_META_KEY = 'dsh-go/media/catalog';
export const CREDENTIAL_SLOTS = Object.freeze([
  'DSH_MEDIA_SLOT_1_API_KEY',
  'DSH_MEDIA_SLOT_2_API_KEY',
  'DSH_MEDIA_SLOT_3_API_KEY',
  'DSH_MEDIA_SLOT_4_API_KEY',
]);
export const HARD_LIMITS = Object.freeze({
  maxImages: 4,
  maxImageBytes: 20 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxTotalImageBytes: 64 * 1024 * 1024,
  maxVideoBytes: 300 * 1024 * 1024,
});
// Legacy general defaults stay first so old configs keep their exact meaning;
// the image/video pairs are chosen by selectedRequest per tool kind.
export const DEFAULT_FIELD_NAMES = Object.freeze([
  'serviceId', 'modelId', 'imageServiceId', 'imageModelId', 'videoServiceId', 'videoModelId',
]);

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function invalid() {
  throw new Error('图像服务配置无效，请检查服务、模型和凭据引用。');
}

// Reuse the message formatter so catalog values cannot advertise parameters
// that the shared v1 grammar cannot represent. This is syntax validation only;
// validating a video row here does not enable a video provider or tool.
export function validateCatalogHeaderModel(model) {
  try {
    const value = { kind: model.kind, prompt: '目录校验', model: { label: model.label } };
    // Check the label without a marker as well: a marker must not hide a label
    // that the grammar classifies as an aspect, count, duration or resolution.
    formatGenerationMessage(value);
    formatGenerationMessage({ ...value,
      model: { ...value.model, serviceId: 'catalog', id: model.id },
    });
    const fields = [
      ['ratios', 'aspect'],
      [model.kind === 'image' ? 'qualities' : 'resolutions', 'quality'],
    ];
    for (const [field, parameter] of fields) {
      if (model[field] === undefined) continue;
      if (!Array.isArray(model[field])) invalid();
      for (const item of model[field]) formatGenerationMessage({ ...value, [parameter]: item });
    }
  } catch { invalid(); }
  return model;
}

const rawCatalog = JSON.parse(readFileSync(
  new URL('../data/models.json', import.meta.url), 'utf8',
));
if (rawCatalog.v !== 1 || !Array.isArray(rawCatalog.models)) invalid();
export const PROFILES = Object.freeze(['openai-compatible', 'openai-gpt-image', ...Object.keys(rawCatalog.profiles)]);
const catalogIds = new Set();
for (const model of rawCatalog.models) {
  if (!model || typeof model.id !== 'string' || catalogIds.has(model.id)
    || !['image', 'video'].includes(model.kind) || typeof model.label !== 'string'
    || !PROFILES.includes(model.profile)
    || !Array.isArray(model.sizes) || !Array.isArray(model.qualities)
    || !Number.isSafeInteger(model.maxN) || model.maxN < 1 || model.maxN > 4) invalid();
  validateCatalogHeaderModel(model);
  if (model.responseFormats !== undefined
    && (!Array.isArray(model.responseFormats) || model.responseFormats.length === 0
      || new Set(model.responseFormats).size !== model.responseFormats.length
      || model.responseFormats.some(value => !['url', 'b64_json'].includes(value)))) invalid();
  for (const [aspect, size] of Object.entries(model.aspectSizes ?? {})) {
    if (!/^[1-9]\d?:[1-9]\d?$/.test(aspect) || !model.sizes.includes(size)) invalid();
    const [a, b] = aspect.split(':').map(Number);
    const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(size);
    if (!match || Number(match[1]) * b !== Number(match[2]) * a) invalid();
  }
  catalogIds.add(model.id);
}
// Presets are optional for backwards-compatible catalogues (0.2.x had none).
if (rawCatalog.presets !== undefined) validatePresets(rawCatalog.presets);
export const CATALOG = freeze(rawCatalog);

export function catalogModel(id) {
  return CATALOG.models.find(model => model.id === id);
}

export function modelIdsOf(service) {
  if (typeof service.models !== 'string') invalid();
  const ids = service.models.split(',').map(value => value.trim()).filter(Boolean);
  if (ids.length < 1 || ids.length > 16 || new Set(ids).size !== ids.length
    || ids.some(id => !catalogModel(id))) invalid();
  return ids;
}

function boundedText(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= maximum;
}

// Service rows and provider presets share one HTTPS/root rule: a native
// profile only accepts its verified hosts (or documented workspace suffix),
// and no URL may smuggle credentials, query or fragment.
function validateBaseUrl(baseUrl, profileName) {
  let url;
  try { url = new URL(baseUrl); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password
    || url.search || url.hash) invalid();
  const profile = rawCatalog.profiles[profileName];
  if (profile && (url.pathname !== '/' || url.port || !(profile.hosts.includes(url.hostname)
    || (profile.workspaceHostSuffix && /^[a-zA-Z0-9-]+$/.test(url.hostname.slice(0, -profile.workspaceHostSuffix.length))
      && url.hostname.endsWith(profile.workspaceHostSuffix))))) invalid();
}

/**
 * Provider presets are plugin-authored catalogue metadata, not user config.
 * They stay optional so older catalogues keep loading, and App clients may
 * ignore them entirely. Each preset only advertises values that the installed
 * model catalogue already serves under the same profile and kind.
 */
export function validatePresets(presets) {
  if (!Array.isArray(presets) || presets.length > 16) invalid();
  const ids = new Set();
  for (const preset of presets) {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)
      || typeof preset.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(preset.id)
      || ids.has(preset.id)
      || !boundedText(preset.label, 80)
      || (preset.labelEn !== undefined && !boundedText(preset.labelEn, 80))
      || typeof preset.provider !== 'string' || !preset.provider.trim()
      || Buffer.byteLength(preset.provider, 'utf8') > 80
      || /[\u0000-\u001f]/.test(preset.provider)
      || !PROFILES.includes(preset.profile)
      || !['image', 'video'].includes(preset.kind)
      || typeof preset.keyGroup !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(preset.keyGroup)) invalid();
    const responseFormat = preset.responseFormat ?? '';
    if (!['', 'url', 'b64_json'].includes(responseFormat)
      || (preset.profile !== 'openai-compatible' && responseFormat)) invalid();
    validateBaseUrl(preset.baseUrl, preset.profile);
    if (!Array.isArray(preset.models) || preset.models.length < 1 || preset.models.length > 16) invalid();
    const seen = new Set();
    const models = [];
    for (const id of preset.models) {
      const model = typeof id === 'string' ? rawCatalog.models.find(item => item.id === id) : undefined;
      if (!model || seen.has(id) || model.profile !== preset.profile || model.kind !== preset.kind) invalid();
      seen.add(id);
      models.push(model);
    }
    // The same whitelist validateServices applies later: a preset must not
    // advertise a response format its models were not verified with.
    if (models.some(model => model.responseFormats !== undefined
      && !model.responseFormats.includes(responseFormat))) invalid();
    ids.add(preset.id);
  }
  return presets;
}

export function validateServices(services) {
  if (!Array.isArray(services) || services.length > 8) invalid();
  const ids = new Set();
  const allowed = new Set(['id', 'label', 'enabled', 'provider', 'baseUrl', 'profile', 'responseFormat', 'models', 'keyRef']);
  for (const service of services) {
    if (!service || Object.keys(service).some(key => !allowed.has(key))
      || !/^[a-z][a-z0-9_]{0,31}$/.test(service.id ?? '')
      || ids.has(service.id)
      || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(service.keyRef ?? '')
      || !PROFILES.includes(service.profile)
      || typeof service.provider !== 'string' || !service.provider.trim()
      || Buffer.byteLength(service.provider, 'utf8') > 80
      || /[\u0000-\u001f]/.test(service.provider)
      || !['', 'url', 'b64_json'].includes(service.responseFormat ?? '')) invalid();
    validateBaseUrl(service.baseUrl, service.profile);
    if (service.profile !== 'openai-compatible' && service.responseFormat) invalid();
    const models = modelIdsOf(service).map(catalogModel);
    if (models.some(model => model.profile !== service.profile)) invalid();
    // A catalog whitelist requires an explicit evidenced response format.
    // An absent list leaves the profile's existing rules in force.
    if (models.some(model => model.responseFormats !== undefined
      && !model.responseFormats.includes(service.responseFormat))) invalid();
    ids.add(service.id);
  }
  return services;
}

const Service = z.object({
  id: z.string().pattern(/^[a-z][a-z0-9_]{0,31}$/).required()
    .description('服务 ID（唯一小写标识；图片与视频各建一个）'),
  label: z.string().max(80).default('').description('显示名称'),
  enabled: z.boolean().default(false).description('启用'),
  provider: z.string().max(80).default('openai').description('服务商（如 ark、aliyun、openai）'),
  baseUrl: z.string().max(2048).default('https://api.openai.com/v1')
    .description('服务地址（HTTPS API 根路径，由服务商预设带入）'),
  profile: z.union(PROFILES)
    .default('openai-gpt-image').description('请求协议（由服务商预设决定）'),
  responseFormat: z.union(['', 'url', 'b64_json']).default('')
    .description('兼容接口返回格式（仅 OpenAI 兼容服务需要；其他协议留空）'),
  models: z.string().max(2048).default('gpt-image-2.5-flare')
    .description('允许的模型 ID（英文逗号分隔，来自已安装目录）'),
  keyRef: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).required()
    .description('凭据名（任意已配置的凭据，如 DSH_MEDIA_ARK_API_KEY；旧版固定槽仍可用）'),
});

// Exact-empty validation with a fixed error avoids Schemastery's const "got"
// diagnostic echoing a misplaced secret. Keep a transform leaf: f87 treats
// intersect nodes as groups before checking their secret role.
const SecretSentinel = z.transform(z.any(), value => {
  if (value !== '') throw new Error('密钥只能通过凭据服务写入。');
  return '';
}, true).default('').role('secret');

function credentialSlot(ref, number) {
  return z.object({
    credentialRef: z.const(ref).default(ref).role('credential-ref'),
    apiKey: SecretSentinel
      .description('写入密钥：' + ref),
  }).description('凭据槽 ' + number + '：' + ref);
}

const Credentials = z.object(Object.fromEntries(
  CREDENTIAL_SLOTS.map((ref, index) => ['slot' + (index + 1), credentialSlot(ref, index + 1)]),
));

export const Config = z.object({
  // Deployment-only. It is intentionally not volatile or editable via settings.
  dshHome: z.string().description('DSH 数据根（仅主机部署配置）'),
  services: z.transform(z.array(Service).max(8), validateServices, true)
    .default([]).volatile()
    .extra('extra', { [CATALOG_META_KEY]: CATALOG })
    .description('服务（图片或视频各建一个，可共用同一凭据）'),
  credentials: Credentials.volatile()
    .description('旧版固定密钥槽，仅为兼容保留；新版 App 会按服务自动创建凭据，不需要在这里重复填'),
  defaults: z.object({
    serviceId: z.string().max(32).default('')
      .description('默认服务 ID（旧版通用设置；新版按图片/视频分别设置）'),
    modelId: z.string().max(160).default('')
      .description('默认模型 ID（旧版通用设置）'),
    imageServiceId: z.string().max(32).default('')
      .description('图片默认服务 ID（留空使用首个可用图片服务）'),
    imageModelId: z.string().max(160).default('')
      .description('图片默认模型 ID（留空使用所选服务首项）'),
    videoServiceId: z.string().max(32).default('')
      .description('视频默认服务 ID（留空使用首个可用视频服务）'),
    videoModelId: z.string().max(160).default('')
      .description('视频默认模型 ID（留空使用所选服务首项）'),
  }).volatile().description('默认值（图片与视频可分别设置）'),
  budget: z.object({
    dailyCny: z.string().default('20').description('每日本地预算（人民币，上海日期）'),
    unknownPriceHoldCny: z.string().default('20').description('无可靠价格时每次预留金额；逐次确认，非供应商收费上限'),
  }).volatile().description('费用保护'),
  limits: z.object({
    maxVideoBytes: z.number().step(1).min(1).max(HARD_LIMITS.maxVideoBytes)
      .default(HARD_LIMITS.maxVideoBytes).description('视频原件字节上限'),
    maxImages: z.number().step(1).min(1).max(HARD_LIMITS.maxImages)
      .default(HARD_LIMITS.maxImages).description('单次图片张数上限'),
    maxImageBytes: z.number().step(1).min(1).max(HARD_LIMITS.maxImageBytes)
      .default(HARD_LIMITS.maxImageBytes).description('单张原件字节上限'),
    maxResponseBytes: z.number().step(1).min(1).max(HARD_LIMITS.maxResponseBytes)
      .default(HARD_LIMITS.maxResponseBytes).description('服务响应字节上限'),
    maxTotalImageBytes: z.number().step(1).min(1).max(HARD_LIMITS.maxTotalImageBytes)
      .default(HARD_LIMITS.maxTotalImageBytes).description('单次原件总字节上限'),
  }).volatile().description('请求与存储上限（不含每日费用预算）'),
});

function current(ref) {
  if (!ref || typeof ref.get !== 'function') invalid();
  return ref.get();
}

export function runtimeSnapshot(config) {
  const services = validateServices(current(config.services));
  const defaults = current(config.defaults);
  const limits = current(config.limits);
  const cleanLimits = {};
  for (const [name, maximum] of Object.entries(HARD_LIMITS)) {
    const value = limits[name] ?? maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
    cleanLimits[name] = value;
  }
  for (const field of DEFAULT_FIELD_NAMES) {
    if (defaults[field] !== undefined && typeof defaults[field] !== 'string') invalid();
  }
  const budget = config.budget ? current(config.budget) : { dailyCny: '20', unknownPriceHoldCny: '20' };
  let dailyMicros, unknownHoldMicros;
  try { dailyMicros = cnyMicros(budget.dailyCny); unknownHoldMicros = cnyMicros(budget.unknownPriceHoldCny); } catch { invalid(); }
  if (dailyMicros < 1 || unknownHoldMicros < 1 || unknownHoldMicros > dailyMicros) invalid();
  return freeze({
    budget: { dailyMicros, unknownHoldMicros },
    services: services.filter(service => service.enabled === true).map(service => ({
      id: service.id, label: service.label || service.id, provider: service.provider,
      baseUrl: service.baseUrl, profile: service.profile,
      ...(service.responseFormat ? { responseFormat: service.responseFormat } : {}),
      keyRef: service.keyRef, modelIds: modelIdsOf(service),
    })),
    defaults: Object.fromEntries(DEFAULT_FIELD_NAMES.map(field => [field, defaults[field] ?? ''])),
    limits: cleanLimits,
  });
}
