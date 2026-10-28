/**
 * Host-half integration test. Runs the real Git operations against disposable
 * repositories under the OS temp directory (never the project itself).
 *
 *   node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __internals } from '../index.js';

const {
  readStatus,
  readDiffStats,
  prepareCommit,
  switchBranch,
  createBranch,
  mergeBranch,
  commitChanges,
  pushBranch,
  initRepository,
  parsePorcelainV2,
  buildCommitMessage,
  runGit,
} = __internals;

const root = mkdtempSync(join(tmpdir(), 'dsh-git-helper-test-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const configure = (cwd) => {
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test User');
  git(cwd, 'config', 'commit.gpgsign', 'false');
};

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`ok - ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error });
    console.error(`not ok - ${name}\n  ${error?.stack ?? error}`);
  }
}

const project = join(root, 'project');
mkdirSync(project, { recursive: true });
git(project, 'init', '-b', 'main');
configure(project);

await check('initRepository on a non-repository directory', async () => {
  const fresh = join(root, 'fresh');
  mkdirSync(fresh);
  const before = await readStatus(fresh);
  assert.equal(before.repo, false);
  const after = await initRepository(fresh);
  assert.equal(after.status.repo, true);
  assert.equal(after.status.branch, 'main');
});

await check('readStatus reports clean repository', async () => {
  writeFileSync(join(project, 'a.txt'), 'hello\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-m', '初始提交');
  const status = await readStatus(project);
  assert.equal(status.repo, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.dirty.length, 0);
  assert.equal(status.lastCommit.subject, '初始提交');
  assert.equal(status.ahead, 0);
});

await check('readStatus lists dirty files', async () => {
  writeFileSync(join(project, 'a.txt'), 'hello world\n');
  writeFileSync(join(project, 'b.txt'), 'new file\n');
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'c.js'), 'export default 1\n');
  const status = await readStatus(project);
  assert.equal(status.dirty.length, 3);
  assert.ok(status.dirty.some((entry) => entry.path === 'b.txt' && entry.status === '??'));
});

await check('prepareCommit summarizes the working tree', async () => {
  const prepared = await prepareCommit(project);
  assert.equal(prepared.files.length, 3);
  assert.match(prepared.message.split('\n')[0], /3 个文件/);
  assert.match(prepared.message, /新增 b\.txt/);
  assert.match(prepared.message, /由 DSH Git 助手自动总结生成/);
  const stats = await readDiffStats(project);
  const message = buildCommitMessage(prepared.files, stats);
  assert.match(message, /修改 a\.txt/);
});

await check('commitChanges commits and clears the working tree', async () => {
  const prepared = await prepareCommit(project);
  const result = await commitChanges(project, prepared.message);
  assert.equal(result.status.dirty.length, 0);
  assert.equal(result.summary, prepared.message.split('\n')[0]);
});

await check('createBranch then switchBranch', async () => {
  const created = await createBranch(project, 'feature/demo');
  assert.equal(created.status.branch, 'feature/demo');
  const switched = await switchBranch(project, 'main');
  assert.equal(switched.status.branch, 'main');
  const branches = switched.status.branches.map((entry) => entry.name);
  assert.deepEqual(branches, ['feature/demo', 'main']);
});

await check('createBranch rejects an invalid name', async () => {
  await assert.rejects(() => createBranch(project, 'bad name'), /不合法/);
});

await check('mergeBranch merges a new commit from another branch', async () => {
  await switchBranch(project, 'feature/demo');
  writeFileSync(join(project, 'feature.txt'), 'feature\n');
  const prepared = await prepareCommit(project);
  await commitChanges(project, prepared.message);
  await switchBranch(project, 'main');
  const merged = await mergeBranch(project, 'feature/demo');
  assert.equal(merged.status.branch, 'main');
  assert.equal(merged.status.dirty.length, 0);
  const content = execFileSync('git', ['show', 'HEAD:feature.txt'], { cwd: project, encoding: 'utf8' });
  assert.equal(content.trim(), 'feature');
});

await check('parsePorcelainV2 handles renamed paths', async () => {
  renameSync(join(project, 'feature.txt'), join(project, 'renamed.txt'));
  await runGit(['add', '-A'], project);
  const parsed = await runGit(['status', '--porcelain=v2', '--branch', '-z'], project);
  const result = parsePorcelainV2(parsed.stdout);
  const renamed = result.dirty.find((entry) => entry.path === 'renamed.txt');
  assert.ok(renamed, JSON.stringify(result.dirty));
  assert.equal(renamed.status[0], 'R');
  await commitChanges(project, '重命名 feature.txt');
});

await check('pushBranch sets upstream and pushes to a local bare remote', async () => {
  const remote = join(root, 'remote.git');
  mkdirSync(remote);
  git(remote, 'init', '--bare');
  git(project, 'remote', 'add', 'origin', remote);
  const pushed = await pushBranch(project);
  assert.equal(pushed.status.upstream, 'origin/main');
  writeFileSync(join(project, 'a.txt'), 'hello world again\n');
  const prepared = await prepareCommit(project);
  await commitChanges(project, prepared.message);
  const second = await pushBranch(project);
  assert.equal(second.status.ahead, 0);
});

await check('pushBranch refuses a dirty working tree', async () => {
  writeFileSync(join(project, 'dirty.txt'), 'dirty\n');
  await assert.rejects(() => pushBranch(project), /未提交/);
  rmSync(join(project, 'dirty.txt'));
});

await check('prepareCommit counts lines for untracked files', async () => {
  writeFileSync(join(project, 'new-lines.txt'), 'a\nb\nc\n');
  const prepared = await prepareCommit(project);
  const entry = prepared.files.find((file) => file.path === 'new-lines.txt');
  assert.ok(entry, JSON.stringify(prepared.files));
  assert.equal(entry.kind, 'added');
  assert.equal(entry.added, 3);
  assert.match(prepared.message, /new-lines\.txt\s+\(\+3 \/ -0\)/);
  rmSync(join(project, 'new-lines.txt'));
});

await check('merge conflict blocks commit until resolved', async () => {
  await createBranch(project, 'conflict-side');
  writeFileSync(join(project, 'a.txt'), 'side version\n');
  await runGit(['add', '-A'], project);
  await runGit(['commit', '-m', 'side change'], project);
  await switchBranch(project, 'main');
  writeFileSync(join(project, 'a.txt'), 'main version\n');
  await runGit(['add', '-A'], project);
  await runGit(['commit', '-m', 'main change'], project);

  await assert.rejects(() => mergeBranch(project, 'conflict-side'), /冲突/);
  const conflicted = await readStatus(project);
  assert.ok(conflicted.dirty.some((entry) => entry.status === 'UU'), JSON.stringify(conflicted.dirty));
  await assert.rejects(() => prepareCommit(project), /未解决/);
  await assert.rejects(() => commitChanges(project, '更新 a.txt\n\n不应提交冲突'), /未解决/);

  await runGit(['merge', '--abort'], project);
  await runGit(['checkout', '--', 'a.txt'], project);
  assert.equal((await readStatus(project)).dirty.length, 0);
});

await check('readStatus reports detached HEAD and checkout returns', async () => {
  const oid = git(project, 'rev-parse', 'HEAD');
  git(project, 'checkout', '--detach', oid);
  const status = await readStatus(project);
  assert.equal(status.detached, true);
  assert.equal(status.branch, null);
  const switched = await switchBranch(project, 'main');
  assert.equal(switched.status.branch, 'main');
});

rmSync(root, { recursive: true, force: true });
const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
