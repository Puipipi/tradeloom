import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaClient } from '../src/adapters.js';
import { CATALOG } from '../src/config.js';

const id = 'task-local-fixture';
const error = { code: 'InternalError', message: 'synthetic private detail' };
const failed = { id, status: 'failed', error };
const request = {
  service: { profile: 'ark-video', baseUrl: 'https://ark.cn-beijing.volces.com' },
  model: CATALOG.models.find(model => model.profile === 'ark-video'),
  prompt: '合成协议夹具',
};
const response = (body, status = 200) => ({ status, body: Buffer.from(JSON.stringify(body)) });
function fixture(...responses) {
  const calls = [];
  const client = createMediaClient({ transport: async (url, options) => {
    calls.push({ method: options.method, path: new URL(url).pathname });
    assert.ok(responses.length, 'unexpected extra provider request');
    return responses.shift();
  } });
  return { client, calls };
}
const get = { method: 'GET', path: '/api/v3/contents/generations/tasks/' + id };

test('Ark query accepts the matching failed task receipt with private error data', async () => {
  // Official task-query response: failed tasks carry error.code/error.message.
  const f = fixture(response(failed));
  assert.deepEqual(await f.client.query(request, id, 'synthetic-credential'), { taskId: id, state: 'failed' });
  assert.deepEqual(f.calls, [get]);
});

test('Ark query keeps existing successful task-state normalization', async () => {
  const url = 'https://example.com/local-fixture.mp4';
  for (const [body, task] of [
    [{ id, status: 'failed' }, { taskId: id, state: 'failed' }],
    [{ id, status: 'queued' }, { taskId: id, state: 'queued' }],
    [{ id, status: 'succeeded', error: null, content: { video_url: url } }, { taskId: id, state: 'succeeded', url }],
  ]) {
    const f = fixture(response(body));
    assert.deepEqual(await f.client.query(request, id, 'synthetic-credential'), task);
    assert.deepEqual(f.calls, [get]);
  }
});

test('Ark query error exemption stays within the matching failed receipt and keeps error priority', async () => {
  for (const [name, body, status, code] of [
    ['wrong id', { ...failed, id: 'other-task' }, 200, 'provider'],
    ['no task', { error }, 200, 'provider'],
    ['unknown state', { ...failed, status: 'future-state' }, 200, 'provider'],
    ['expired is outside this change', { ...failed, status: 'expired' }, 200, 'provider'],
    ['HTTP failure', failed, 503, 'provider'],
    ['authentication', failed, 401, 'authentication'],
    ['rate limit', failed, 429, 'rate_limit'],
    ['top-level code', { ...failed, code: 'QueryFailure' }, 200, 'provider'],
    ['nested policy', { ...failed, error: { code: 'DataInspectionFailed' } }, 200, 'policy'],
    ['Ark output policy', { ...failed, error: { code: 'OutputVideoSensitiveContentDetected' } }, 200, 'policy'],
    ['Ark input text policy', { ...failed, error: { code: 'InputTextSensitiveContentDetected' } }, 200, 'policy'],
    ['Ark input image policy', { ...failed, error: { code: 'InputImageSensitiveContentDetected' } }, 200, 'policy'],
    ['top-level policy', { ...failed, code: 'content_policy_violation' }, 200, 'policy'],
    ['policy before generic HTTP failure', { ...failed, error: { code: 'DataInspectionFailed' } }, 503, 'policy'],
  ]) {
    const f = fixture(response(body, status));
    await assert.rejects(f.client.query(request, id, 'synthetic-credential'), { code }, name);
    assert.deepEqual(f.calls, [get], name);
  }
  const f = fixture(response({ ...failed, output: { task_id: id, task_status: 'FAILED' } }));
  const other = { ...request, service: { profile: 'ali-video', baseUrl: 'https://dashscope.aliyuncs.com' } };
  await assert.rejects(f.client.query(other, id, 'synthetic-credential'), { code: 'provider' });
  assert.deepEqual(f.calls, [{ method: 'GET', path: '/api/v1/tasks/' + id }]);
});

test('Ark HTTP 400 creation moderation errors remain definite policy failures', async () => {
  for (const [profile, codes] of [
    ['ark-video', ['InputTextSensitiveContentDetected', 'InputImageSensitiveContentDetected']],
    ['ark-image', ['InputTextSensitiveContentDetected', 'InputImageSensitiveContentDetected', 'OutputImageSensitiveContentDetected']],
  ]) {
    const selected = { ...request, service: { ...request.service, profile },
      model: CATALOG.models.find(model => model.profile === profile) };
    for (const code of codes) {
      const f = fixture(response({ error: { code, message: 'synthetic private detail' } }, 400));
      await assert.rejects(f.client.create(selected, [], 'synthetic-credential'), { code: 'policy' }, code);
      assert.deepEqual(f.calls, [{ method: 'POST', path: CATALOG.profiles[profile].path }]);
    }
  }
});

test('public options cannot enable a task-query error exemption on create', async () => {
  const f = fixture(response(failed));
  await assert.rejects(f.client.create(request, [], 'synthetic-credential', { queryId: id }), { code: 'submission_unknown' });
  assert.deepEqual(f.calls, [{ method: 'POST', path: '/api/v3/contents/generations/tasks' }]);
  const control = fixture(response({ id }));
  assert.deepEqual(await control.client.create(request, [], 'synthetic-credential'), { taskId: id });
  assert.equal(control.calls.length, 1);
});

test('public options cannot enable a task-query error exemption on a cancel acknowledgement', async () => {
  const f = fixture(response({ id, status: 'queued' }), response(failed));
  await assert.rejects(f.client.cancel(request, id, 'synthetic-credential', { queryId: id }), { code: 'provider' });
  assert.deepEqual(f.calls, [get, { method: 'DELETE', path: get.path }]);
});
