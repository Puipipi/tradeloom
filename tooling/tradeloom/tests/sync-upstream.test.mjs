import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { checkUpstream, createCandidate, inspectRepo } from '../sync-upstream.mjs';

function cmd(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function readText(path) { return readFileSync(path, 'utf8').replace(/\r\n/g, '\n'); }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tl-sync-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bare = join(root, 'upstream.git'), source = join(root, 'source');
  mkdirSync(source);
  cmd(['init', '--bare', bare], root);
  cmd(['init', '-b', 'main', source], root);
  cmd(['config', 'user.name', 'Fixture'], source);
  cmd(['config', 'user.email', 'fixture@example.invalid'], source);
  cmd(['remote', 'add', 'origin', bare], source);
  writeFileSync(join(source, 'app.txt'), 'base\n');
  cmd(['add', '.'], source); cmd(['commit', '-m', 'base'], source); cmd(['push', '-u', 'origin', 'main'], source);
  cmd(['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], root);
  return { root, bare, source };
}

test('浅克隆的关联工作树从确切 HEAD 创建候选，独立于源 origin', t => {
  const { root, bare, source: upstreamWork } = fixture(t);
  const upstreamUrl = pathToFileURL(bare).href;
  const owner = join(root, 'shallow-owner');
  const source = join(root, 'linked-source');
  const localOrigin = join(root, 'local-origin');
  cmd(['clone', '--depth=1', upstreamUrl, owner], root);
  cmd(['config', 'user.name', 'Fixture'], owner);
  cmd(['config', 'user.email', 'fixture@example.invalid'], owner);
  cmd(['remote', 'set-url', 'origin', localOrigin], owner);
  cmd(['worktree', 'add', '--detach', source], owner);
  assert.equal(inspectRepo(source).shallow, true);
  writeFileSync(join(upstreamWork, 'upstream.txt'), 'arrived\n');
  cmd(['add', 'upstream.txt'], upstreamWork); cmd(['commit', '-m', 'upstream change'], upstreamWork); cmd(['push'], upstreamWork);
  writeFileSync(join(source, 'app.txt'), 'base\ntradeloom adaptation\n');
  cmd(['add', 'app.txt'], source); cmd(['commit', '-m', 'TradeLoom adaptation'], source);
  const beforeHead = cmd(['rev-parse', 'HEAD'], source);
  const upstreamHead = cmd(['rev-parse', 'HEAD'], upstreamWork);
  assert.equal(checkUpstream(source, upstreamUrl).upstreamSha, upstreamHead);
  const candidate = join(root, 'candidate');
  const result = createCandidate(source, candidate, upstreamUrl, 'main');
  assert.equal(result.stage, 'ready');
  assert.equal(result.upstreamHead, upstreamHead);
  assert.equal(cmd(['rev-parse', 'HEAD^1'], candidate), beforeHead);
  assert.equal(cmd(['rev-parse', 'HEAD^2'], candidate), upstreamHead);
  assert.equal(cmd(['rev-parse', 'HEAD'], source), beforeHead);
  assert.equal(cmd(['remote', 'get-url', 'origin'], source), localOrigin);
  assert.equal(inspectRepo(source).shallow, true);
  assert.equal(inspectRepo(candidate).shallow, false);
  assert.equal(inspectRepo(source).dirty, false);
  assert.match(readText(join(source, 'app.txt')), /tradeloom adaptation/);
  assert.equal(readText(join(candidate, 'app.txt')), 'base\ntradeloom adaptation\n');
  assert.equal(readText(join(candidate, 'upstream.txt')), 'arrived\n');
});

test('同一行上游冲突被留在候选中，原工作树仍完整', t => {
  const { root, bare, source: upstreamWork } = fixture(t);
  const source = join(root, 'caller');
  cmd(['clone', bare, source], root);
  cmd(['config', 'user.name', 'Fixture'], source); cmd(['config', 'user.email', 'fixture@example.invalid'], source);
  writeFileSync(join(upstreamWork, 'app.txt'), 'upstream\n');
  cmd(['add', '.'], upstreamWork); cmd(['commit', '-m', 'upstream conflict'], upstreamWork); cmd(['push'], upstreamWork);
  writeFileSync(join(source, 'app.txt'), 'tradeloom\n');
  cmd(['add', '.'], source); cmd(['commit', '-m', 'TradeLoom conflict'], source);
  const beforeHead = cmd(['rev-parse', 'HEAD'], source);
  const candidate = join(root, 'candidate');
  const result = createCandidate(source, candidate, bare, 'main');
  assert.equal(result.stage, 'merge-conflict');
  assert.deepEqual(result.conflicts, ['app.txt']);
  assert.equal(readText(join(source, 'app.txt')), 'tradeloom\n');
  assert.equal(cmd(['rev-parse', 'HEAD'], source), beforeHead);
  assert.equal(existsSync(join(candidate, '.git')), true);
});

test('候选拒绝未提交变更，且只读检查可识别浅克隆', t => {
  const { root, bare } = fixture(t);
  const upstreamUrl = pathToFileURL(bare).href;
  const source = join(root, 'shallow-source');
  cmd(['clone', '--depth=1', upstreamUrl, source], root);
  cmd(['remote', 'remove', 'origin'], source);
  const state = inspectRepo(source);
  assert.equal(state.shallow, true);
  assert.equal(cmd(['branch', '--show-current'], source), 'main');
  writeFileSync(join(source, 'dirty.txt'), 'uncommitted\n');
  assert.throws(() => createCandidate(source, join(root, 'refused'), upstreamUrl, 'main'), /未提交变更/);
  assert.equal(existsSync(join(root, 'refused')), false);
});
