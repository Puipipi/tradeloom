#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPSTREAM_URL = 'https://github.com/ccch1mneyyy/dsh-Go.git';
export const UPSTREAM_BRANCH = 'main';

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const git = (args, cwd, options) => run('git', args, cwd, options);

export function inspectRepo(repo) {
  repo = resolve(repo);
  const top = git(['rev-parse', '--show-toplevel'], repo).stdout.trim();
  const head = git(['rev-parse', 'HEAD'], top).stdout.trim();
  const branch = git(['branch', '--show-current'], top).stdout.trim();
  const shallow = git(['rev-parse', '--is-shallow-repository'], top).stdout.trim() === 'true';
  const status = git(['--no-optional-locks', 'status', '--porcelain=v1'], top).stdout;
  return { repo: top, head, branch, shallow, dirty: Boolean(status.trim()), status };
}

export function checkUpstream(repo, upstreamUrl = UPSTREAM_URL, branch = UPSTREAM_BRANCH) {
  const state = inspectRepo(repo);
  const refs = git(['ls-remote', '--heads', upstreamUrl, `refs/heads/${branch}`], state.repo);
  const line = refs.stdout.trim().split(/\s+/);
  if (!line[0] || !/^[a-f0-9]{40}$/i.test(line[0])) throw new Error(`上游未返回 ${branch} 分支 SHA`);
  return { ...state, upstreamSha: line[0] };
}

export function createCandidate(repo, destination, upstreamUrl = UPSTREAM_URL, branch = UPSTREAM_BRANCH) {
  const state = inspectRepo(repo);
  if (state.dirty) throw new Error('源工作树含未提交变更；候选模式已拒绝，未触碰源目录。先检查并提交希望迁移的代码，再重试。');
  destination = resolve(destination);
  const fromRepo = relative(state.repo, destination);
  if (!fromRepo || (fromRepo !== '..' && !fromRepo.startsWith(`..${sep}`) && !isAbsolute(fromRepo))) {
    throw new Error('候选目录必须位于原工作树之外');
  }
  if (existsSync(destination)) throw new Error(`候选目标已存在：${destination}`);
  mkdirSync(dirname(destination), { recursive: true });

  // Use Git's transport so a linked worktree's shallow boundary is carried into the clone.
  git(['clone', '--no-local', state.repo, destination], dirname(destination));
  const candidateHead = git(['rev-parse', 'HEAD'], destination).stdout.trim();
  if (candidateHead !== state.head) {
    throw new Error(`候选 HEAD 与原始快照不一致：预期 ${state.head}，实际 ${candidateHead}`);
  }
  const shallow = git(['rev-parse', '--is-shallow-repository'], destination).stdout.trim() === 'true';
  if (shallow !== state.shallow) throw new Error('候选浅克隆状态与源快照不一致');
  git(['remote', 'add', 'upstream', upstreamUrl], destination);
  git(shallow ? ['fetch', '--no-tags', '--unshallow', 'upstream', branch] : ['fetch', '--no-tags', 'upstream', branch], destination);
  const candidateBranch = `codex/upstream-candidate-${state.head.slice(0, 8)}`;
  git(['switch', '-c', candidateBranch], destination);
  const merge = git(['-c', 'user.name=TradeLoom Candidate', '-c', 'user.email=local-candidate@invalid', 'merge', '--no-edit', `upstream/${branch}`], destination, { allowFailure: true });
  if (merge.code !== 0) {
    const conflicts = git(['diff', '--name-only', '--diff-filter=U'], destination).stdout.trim().split(/\r?\n/).filter(Boolean);
    if (conflicts.length) return { candidate: destination, state, conflicts, stage: 'merge-conflict', error: merge.stderr.trim() };
    git(['merge', '--abort'], destination, { allowFailure: true });
    return { candidate: destination, state, conflicts: [], stage: 'merge-error', error: merge.stderr.trim() || merge.stdout.trim() };
  }
  return { candidate: destination, state, conflicts: [], stage: 'ready', upstreamHead: git(['rev-parse', `refs/remotes/upstream/${branch}`], destination).stdout.trim() };
}

function usage() {
  return `使用方式：\n  node tooling/tradeloom/sync-upstream.mjs --check --repo <Go工作树>\n  node tooling/tradeloom/sync-upstream.mjs --candidate --repo <Go工作树> --dest <独立候选目录>\n\n固定上游：${UPSTREAM_URL} (${UPSTREAM_BRANCH})\n`;
}

function cli(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args.set(argv[i], argv[i + 1]?.startsWith('--') ? true : argv[++i]);
  }
  if (args.has('--help') || (!args.has('--check') && !args.has('--candidate'))) return console.log(usage());
  const repo = args.get('--repo') || process.cwd();
  if (args.has('--check')) {
    const result = checkUpstream(repo);
    console.log(`本地分支：${result.branch || '(detached)'} @ ${result.head}${result.shallow ? '（浅克隆）' : ''}`);
    console.log(`上游 ${UPSTREAM_BRANCH}：${result.upstreamSha}`);
    console.log(`工作区：${result.dirty ? '有未提交变更；检查已完成，候选模式会拒绝' : '干净'}`);
    return;
  }
  const dest = args.get('--dest');
  if (!dest || dest === true) throw new Error('--candidate 必须同时提供 --dest');
  const result = createCandidate(repo, dest);
  console.log(`候选目录：${result.candidate}`);
  console.log(`原工作树：${result.state.repo}（未修改）`);
  if (result.stage === 'ready') console.log(`已从上游 ${result.upstreamHead} 创建隔离候选分支；代码未执行。回退：删除候选目录即可。`);
  else {
    console.error(`候选未就绪：${result.stage}\n冲突文件：${result.conflicts.join(', ') || '(无 Git 冲突文件)'}${result.error ? `\n原因：${result.error}` : ''}`);
    console.error(result.stage === 'merge-conflict' ? '在候选中解决冲突，或运行 git merge --abort；源工作树不受影响。' : '删除候选目录即可回退；源工作树不受影响。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(`更新检查失败：${error.message}`); process.exitCode = 1; }
}
