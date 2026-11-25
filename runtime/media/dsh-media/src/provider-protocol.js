// Internal, unconnected provider protocol foundation. Never serialize results to chat/logs.
import { fail } from './errors.js';
import { parseMediaUrl } from './http.js';
import { base64DecodedLength } from './base64.js';

export const PROVIDERS = Object.freeze({
  'ark-image': Object.freeze({ model: 'doubao-seedream-5-0-lite-260128', path: '/api/v3/images/generations', kind: 'image' }),
  'ali-qwen-image': Object.freeze({ model: 'qwen-image-3.0', path: '/compatible-mode/v1/images/generations', kind: 'image' }),
  'ali-wan-image': Object.freeze({ model: 'wan2.7-image', path: '/api/v1/services/aigc/multimodal-generation/generation', kind: 'image' }),
  'ark-video': Object.freeze({ model: 'doubao-seedance-2-5-260628', path: '/api/v3/contents/generations/tasks', kind: 'video' }),
  'ali-video': Object.freeze({ model: 'wan2.7-t2v-2026-06-12', path: '/api/v1/services/aigc/video-generation/video-synthesis', kind: 'video' }),
});
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function only(value, keys) {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(k => !keys.includes(k))) fail('invalid_request');
}
function profile(name) { if (!Object.hasOwn(PROVIDERS, name)) fail('invalid_request'); return PROVIDERS[name]; }
function taskId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) fail('response'); return value; }
function exact(value, expected) { if (value !== expected) fail('invalid_request'); }
function text(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 4096) fail('invalid_request');
  return value;
}

// All narrow choices are explicit; unsupported values/fields are never silently dropped.
export function buildProviderCreate(name, options) {
  const spec = profile(name), video = spec.kind === 'video';
  only(options, video ? ['model', 'prompt', 'duration', 'resolution', 'ratio', ...(name === 'ark-video' ? ['generateAudio'] : ['promptExtend'])]
    : ['model', 'prompt', 'n', 'size', ...(name === 'ark-image' ? ['responseFormat'] : [])]);
  exact(options.model, spec.model); const prompt = text(options.prompt);
  let body;
  const headers = {};
  if (!video) {
    exact(options.n, 1);
    exact(options.size, name === 'ali-qwen-image' ? '1024x1024' : '2048x2048');
    if (name === 'ark-image') {
      if (!['url', 'b64_json'].includes(options.responseFormat)) fail('invalid_request');
      body = { model: spec.model, prompt, size: options.size, sequential_image_generation: 'disabled', response_format: options.responseFormat };
    } else if (name === 'ali-qwen-image') {
      body = { model: spec.model, prompt, n: 1, size: options.size };
    } else {
      body = { model: spec.model, input: { messages: [{ role: 'user', content: [{ text: prompt }] }] }, parameters: { n: 1, size: '2048*2048', enable_sequential: false } };
    }
  } else {
    exact(options.duration, 5); exact(options.resolution, '720p'); exact(options.ratio, '16:9');
    if (name === 'ark-video') {
      if (typeof options.generateAudio !== 'boolean') fail('invalid_request');
      body = { model: spec.model, content: [{ type: 'text', text: prompt }], duration: 5, resolution: '720p', ratio: '16:9', generate_audio: options.generateAudio };
    } else {
      exact(options.promptExtend, false);
      headers['X-DashScope-Async'] = 'enable';
      body = { model: spec.model, input: { prompt }, parameters: { duration: 5, resolution: '720P', ratio: '16:9', prompt_extend: false } };
    }
  }
  return { method: 'POST', path: spec.path, headers, body };
}
export function buildProviderQuery(name, id) {
  if (profile(name).kind !== 'video') fail('invalid_request');
  taskId(id);
  return { method: 'GET', path: (name === 'ark-video' ? PROVIDERS[name].path : '/api/v1/tasks') + '/' + id, headers: {} };
}
function remoteUrl(value) {
  if (typeof value !== 'string') fail('response');
  try { parseMediaUrl(value); } catch { fail('response'); }
  return value;
}
function noError(value) { if (!record(value) || value.error || value.code) fail('response'); }
export function normalizeProviderImage(name, value) {
  if (profile(name).kind !== 'image') fail('invalid_request');
  noError(value);
  let items;
  if (name === 'ali-wan-image') {
    const choices = value.output?.choices;
    if (!Array.isArray(choices) || choices.length !== 1) fail('response');
    const choice = choices[0]; noError(choice);
    items = choice.message?.content;
    if (!Array.isArray(items) || items.length !== 1) fail('response');
    noError(items[0]);
    return { kind: 'image', source: { type: 'url', value: remoteUrl(items[0].image) } };
  }
  items = value.data;
  if (!Array.isArray(items) || items.length !== 1) fail('response');
  const item = items[0]; noError(item);
  if (typeof item.url === 'string' && item.b64_json === undefined) return { kind: 'image', source: { type: 'url', value: remoteUrl(item.url) } };
  if (name === 'ark-image' && typeof item.b64_json === 'string' && item.url === undefined) {
    base64DecodedLength(item.b64_json, 20 * 1024 * 1024);
    return { kind: 'image', source: { type: 'base64', value: item.b64_json } };
  }
  fail('response');
}
const ARK = Object.freeze({ queued: 'queued', running: 'running', cancelled: 'cancelled', succeeded: 'succeeded', failed: 'failed', expired: 'expired' });
const ALI = Object.freeze({ PENDING: 'queued', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELED: 'cancelled', UNKNOWN: 'unknown' });
export function normalizeProviderCreated(name, value) {
  if (profile(name).kind !== 'video') fail('invalid_request');
  noError(value);
  // An id is enough to query; do not invent a state for Ark's id-only receipt.
  if (name === 'ark-video') return { kind: 'video-task', taskId: taskId(value.id) };
  const output = value.output;
  if (!record(output) || !Object.hasOwn(ALI, output.task_status)) fail('response');
  return { kind: 'video-task', taskId: taskId(output.task_id), state: ALI[output.task_status] };
}
export function normalizeProviderTask(name, id, value) {
  if (profile(name).kind !== 'video') fail('invalid_request');
  taskId(id); if (!record(value)) fail('response');
  const output = name === 'ark-video' ? value : value.output;
  if (!record(output)) fail('response');
  const actual = name === 'ark-video' ? output.id : output.task_id;
  if (taskId(actual) !== id) fail('response');
  const map = name === 'ark-video' ? ARK : ALI;
  const raw = name === 'ark-video' ? output.status : output.task_status;
  if (!Object.hasOwn(map, raw)) fail('response');
  const result = { kind: 'video-task', taskId: id, state: map[raw] };
  if (result.state === 'succeeded') result.source = { type: 'url', value: remoteUrl(name === 'ark-video' ? output.content?.video_url : output.video_url) };
  // Provider message/error/usage/raw URL metadata never become public error text.
  return result;
}
