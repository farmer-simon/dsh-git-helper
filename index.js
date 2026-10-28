/**
 * dsh-git-helper — Host half.
 *
 * Exposes one authenticated, same-origin JSON route (`/dsh-git-helper/api`) that
 * runs Git operations in the working directory of the Session the request names.
 * The Web client half renders the branch chip in the composer and calls it.
 *
 * Admission is delegated to the Host connection service (`requestRejection`), so
 * the route obeys the same Host/Origin fence and browser login as the Harness's
 * own `/api` channel. Git itself runs through the local `git` executable with
 * terminal prompts disabled, so a missing credential fails fast instead of
 * hanging the UI.
 */
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ROUTE_PATH = '/dsh-git-helper/api';

const BODY_LIMIT = 64 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export const inject = ['webServer', 'sessions', 'workingDirectory', 'connection'];

/** An expected, user-facing failure (as opposed to a programming error). */
class GitHelperError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitHelperError';
  }
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (request, response) => handleRequest(ctx, request, response),
    }),
    'dsh-git-helper: git api route',
  );
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new GitHelperError('请求内容过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHelperError('请求格式无效');
  }
}

/**
 * The page must be admitted by the Host connection fence before any Git command
 * runs. Route registration alone would bypass the login/token check that `api`
 * requests go through, so ask the one gate the Harness already trusts — and fail
 * closed if that gate is unavailable, never open.
 */
function rejectionFor(ctx, request) {
  const connection = ctx.connection;
  if (connection === undefined || typeof connection.requestRejection !== 'function') return 403;
  try {
    return connection.requestRejection({ headers: request.headers });
  } catch {
    return 403;
  }
}

async function handleRequest(ctx, request, response) {
  try {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: '只支持 POST 请求' });
      return;
    }
    const rejected = rejectionFor(ctx, request);
    if (rejected !== undefined) {
      sendJson(response, rejected, {
        ok: false,
        error: rejected === 401 ? '需要先登录 DSH 页面' : '请求来源不受信任',
      });
      return;
    }
    const body = await readJsonBody(request);
    const data = await dispatch(ctx, body);
    sendJson(response, 200, { ok: true, data });
  } catch (error) {
    if (error instanceof GitHelperError) {
      sendJson(response, 200, { ok: false, error: error.message });
      return;
    }
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

const gitLocks = new Map();

/** Serialize mutations per working directory so two clicks cannot interleave. */
function withGitLock(key, task) {
  const previous = gitLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  gitLocks.set(key, current);
  current
    .finally(() => {
      if (gitLocks.get(key) === current) gitLocks.delete(key);
    })
    .catch(() => {});
  return current;
}

function resolveSessionDirectory(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new GitHelperError('缺少会话标识');
  }
  const session = ctx.sessions.get(sessionId);
  if (session === undefined) {
    throw new GitHelperError('当前会话尚未启动或已关闭，无法读取项目目录');
  }
  let directory;
  try {
    directory = ctx.workingDirectory.get(session);
  } catch {
    directory = undefined;
  }
  if (typeof directory !== 'string' || directory === '') {
    directory = session.header?.cwd;
  }
  if (typeof directory !== 'string' || directory === '') {
    throw new GitHelperError('当前会话没有工作目录');
  }
  try {
    if (statSync(directory).isDirectory() === false) throw new Error('not a directory');
  } catch {
    throw new GitHelperError(`项目目录不存在或不可访问：${directory}`);
  }
  return directory;
}

async function dispatch(ctx, body) {
  const action = typeof body.action === 'string' ? body.action : '';
  const directory = resolveSessionDirectory(ctx, body.sessionId);
  const lockKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
  return withGitLock(lockKey, () => runAction(action, body, directory));
}

async function runAction(action, body, directory) {
  switch (action) {
    case 'status':
      return readStatus(directory);
    case 'switch':
      return switchBranch(directory, requireString(body.branch, '分支名'));
    case 'create':
      return createBranch(directory, requireString(body.name, '新分支名'), optionalString(body.base));
    case 'merge':
      return mergeBranch(directory, requireString(body.branch, '分支名'));
    case 'prepare-commit':
      return prepareCommit(directory);
    case 'commit':
      return commitChanges(directory, requireString(body.message, '提交说明'));
    case 'push':
      return pushBranch(directory);
    case 'init':
      return initRepository(directory);
    default:
      throw new GitHelperError(`未知操作：${action === '' ? '(空)' : action}`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GitHelperError(`缺少${label}`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/* ------------------------------------------------------------------ */
/* Git runner                                                          */
/* ------------------------------------------------------------------ */

function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_PAGER: 'cat',
          GIT_MERGE_AUTOEDIT: 'no',
          LC_ALL: 'C',
          LANG: 'C',
        },
      },
      (error, stdout, stderr) => {
        const exitCode = error == null
          ? 0
          : typeof error.code === 'number'
            ? error.code
            : -1;
        resolve({
          code: exitCode,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          spawnError: error?.code === 'ENOENT' ? error : undefined,
        });
      },
    );
  });
}

const GIT_MISSING = '未找到 git 可执行文件，请确认 Git 已安装并加入 PATH';

function ensureSpawned(result) {
  if (result.spawnError) throw new GitHelperError(GIT_MISSING);
  return result;
}

function cleanOutput(text, limit = 2000) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n…`;
}

function gitFailure(result, fallback) {
  const detail = cleanOutput(result.stderr || result.stdout, 1200);
  return detail === '' ? fallback : `${fallback}：${detail}`;
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

function changeKind(status) {
  if (status === '??') return 'added';
  const x = status[0];
  const y = status[1];
  if (status === 'UU' || status === 'AA' || status === 'DD' || x === 'U' || y === 'U') return 'conflict';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'R') return 'renamed';
  if (x === 'C') return 'copied';
  return 'modified';
}

/** Parse `git status --porcelain=v2 --branch -z` into plain JSON. */
export function parsePorcelainV2(raw) {
  const dirty = [];
  const header = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
  const fields = String(raw ?? '').split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry === '') continue;
    const marker = entry[0];
    if (marker === '#') {
      const body = entry.slice(2);
      const space = body.indexOf(' ');
      const key = space === -1 ? body : body.slice(0, space);
      const value = space === -1 ? '' : body.slice(space + 1);
      if (key === 'branch.oid') header.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') header.head = value;
      else if (key === 'branch.upstream') header.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+)\s+-(\d+)$/.exec(value);
        if (match) {
          header.ahead = Number(match[1]);
          header.behind = Number(match[2]);
        }
      }
      continue;
    }
    if (marker === '1') {
      const parts = entry.split(' ');
      dirty.push({ path: parts.slice(8).join(' '), status: parts[1] ?? 'M.' });
      continue;
    }
    if (marker === '2') {
      const parts = entry.split(' ');
      dirty.push({ path: parts.slice(9).join(' '), status: parts[1] ?? 'R.' });
      index += 1; // the next NUL field is the original path
      continue;
    }
    if (marker === 'u') {
      const parts = entry.split(' ');
      dirty.push({ path: parts.slice(10).join(' '), status: 'UU' });
      continue;
    }
    if (marker === '?') {
      dirty.push({ path: entry.slice(2), status: '??' });
      continue;
    }
    // '!' ignored entries carry no change.
  }
  return { dirty, header };
}

function emptyStatus(directory) {
  return {
    repo: false,
    cwd: directory,
    root: null,
    branch: null,
    detached: false,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: [],
    branches: [],
    lastCommit: null,
  };
}

export async function readStatus(directory) {
  const inside = ensureSpawned(await runGit(['rev-parse', '--is-inside-work-tree'], directory));
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return emptyStatus(directory);
  }

  // Resolve the repository root first and read status/paths against it, so a
  // Session opened in a subdirectory still sees repo-relative paths that match
  // `git add -A`'s scope and `git diff --numstat`'s keys.
  const rootResult = ensureSpawned(await runGit(['rev-parse', '--show-toplevel'], directory));
  if (rootResult.code !== 0) {
    throw new GitHelperError(gitFailure(rootResult, '无法定位 Git 仓库根目录'));
  }
  const root = rootResult.stdout.trim() || directory;

  const [statusResult, branchesResult, commitResult] = await Promise.all([
    runGit(['status', '--porcelain=v2', '--branch', '-z'], root),
    runGit(['for-each-ref', '--format=%(refname:short)%09%(upstream:short)', 'refs/heads'], root),
    runGit(['log', '-1', '--format=%h%x00%s'], root),
  ]);

  if (statusResult.code !== 0) {
    throw new GitHelperError(gitFailure(statusResult, '读取 Git 状态失败'));
  }

  const parsed = parsePorcelainV2(statusResult.stdout);
  const head = parsed.header.head;
  const detached = head === '(detached)';

  const branches = branchesResult.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [name, upstream] = line.split('\t');
      return { name, upstream: upstream === undefined || upstream === '' ? null : upstream, current: name === head };
    });

  let lastCommit = null;
  if (commitResult.code === 0) {
    const raw = commitResult.stdout.trim();
    const separator = raw.indexOf('\0');
    if (separator > 0) {
      lastCommit = { short: raw.slice(0, separator), subject: raw.slice(separator + 1) };
    }
  }

  return {
    repo: true,
    cwd: directory,
    root,
    branch: detached ? null : head,
    detached,
    oid: parsed.header.oid,
    upstream: parsed.header.upstream,
    ahead: parsed.header.ahead,
    behind: parsed.header.behind,
    dirty: parsed.dirty.sort((left, right) => left.path.localeCompare(right.path)),
    branches: branches.sort((left, right) => left.name.localeCompare(right.name)),
    lastCommit,
  };
}

/* ------------------------------------------------------------------ */
/* Commit message generation                                           */
/* ------------------------------------------------------------------ */

const KIND_LABEL = {
  added: '新增',
  deleted: '删除',
  modified: '修改',
  renamed: '重命名',
  copied: '复制',
  conflict: '冲突',
};

function clip(text, max) {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('')}…`;
}

function topDirectories(paths) {
  const unique = [];
  for (const path of paths) {
    const normalized = path.replace(/\\/g, '/');
    const separator = normalized.indexOf('/');
    if (separator === -1) continue;
    const directory = normalized.slice(0, separator);
    if (!unique.includes(directory)) unique.push(directory);
  }
  if (unique.length === 0) return '';
  const shown = unique.slice(0, 3).join('、');
  return unique.length > 3 ? `${shown} 等 ${unique.length} 个目录` : shown;
}

/**
 * Turn one working-tree snapshot into a deterministic commit message: a subject
 * that states what kind of change happened and where, plus a per-file body with
 * line counts when they are available.
 */
export function buildCommitMessage(entries, stats = new Map()) {
  const counts = { added: 0, deleted: 0, modified: 0, renamed: 0, copied: 0, conflict: 0 };
  for (const entry of entries) counts[changeKind(entry.status)] += 1;

  const parts = [];
  for (const kind of ['added', 'deleted', 'modified', 'renamed', 'copied', 'conflict']) {
    if (counts[kind] > 0) parts.push(`${KIND_LABEL[kind]} ${counts[kind]}`);
  }

  const total = entries.length;
  let subject = parts.length === 1 && counts.conflict === 0
    ? `${parts[0]} 个文件`
    : `更新 ${total} 个文件（${parts.join(' / ')}）`;
  const directories = topDirectories(entries.map((entry) => entry.path));
  if (directories !== '') subject += `：${directories}`;
  subject = clip(subject, 72);

  const body = [];
  for (const entry of entries.slice(0, 40)) {
    const stat = stats instanceof Map ? stats.get(entry.path.replace(/\\/g, '/')) : undefined;
    const suffix = stat === undefined ? '' : `  (+${stat.added} / -${stat.removed})`;
    body.push(`${KIND_LABEL[changeKind(entry.status)]} ${entry.path}${suffix}`);
  }
  if (entries.length > 40) body.push(`… 另有 ${entries.length - 40} 个文件`);
  body.push('');
  body.push('由 DSH Git 助手自动总结生成');

  return `${subject}\n\n${body.join('\n')}`;
}

/** Count lines of a small text file without touching the repository index. */
function countFileLines(path) {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return undefined;
    const buffer = readFileSync(path);
    if (buffer.includes(0)) return undefined; // binary
    let lines = 0;
    for (const byte of buffer) if (byte === 10) lines += 1;
    if (buffer.length > 0 && buffer[buffer.length - 1] !== 10) lines += 1;
    return lines;
  } catch {
    return undefined;
  }
}

async function readDiffStats(root) {
  const stats = new Map();
  const hasHead = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  // `--no-renames` keeps every numstat path a plain path, so map keys always
  // match `git status` entries (rename output uses `{old => new}` otherwise).
  const result = await runGit(
    hasHead.code === 0
      ? ['diff', 'HEAD', '--numstat', '--no-renames', '--']
      : ['diff', '--numstat', '--no-renames', '--'],
    root,
  );
  if (result.code !== 0) return stats;
  for (const line of result.stdout.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (match === null) continue;
    stats.set(match[3].replace(/\\/g, '/'), {
      added: match[1] === '-' ? 0 : Number(match[1]),
      removed: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return stats;
}

function conflictEntries(status) {
  return status.dirty.filter((entry) => changeKind(entry.status) === 'conflict');
}

function conflictMessage(status) {
  return `工作区还有 ${conflictEntries(status).length} 个未解决的冲突，请先解决冲突，或在终端执行 git merge --abort 放弃本次合并`;
}

async function prepareCommit(directory) {
  const status = await readStatus(directory);
  if (!status.repo) throw new GitHelperError('当前项目还不是 Git 仓库，请先初始化');
  if (conflictEntries(status).length > 0) throw new GitHelperError(conflictMessage(status));
  if (status.dirty.length === 0) throw new GitHelperError('工作区没有可提交的变更');

  const stats = await readDiffStats(status.root);
  const files = [];
  const usableStats = new Map();
  for (const entry of status.dirty) {
    const kind = changeKind(entry.status);
    let stat = kind === 'renamed' || kind === 'copied' ? undefined : stats.get(entry.path.replace(/\\/g, '/'));
    if (stat === undefined && kind === 'added') {
      const lines = countFileLines(join(status.root, entry.path));
      if (lines !== undefined) stat = { added: lines, removed: 0 };
    }
    files.push({ path: entry.path, status: entry.status, kind, ...(stat ?? {}) });
    if (stat !== undefined) usableStats.set(entry.path, stat);
  }

  return {
    message: buildCommitMessage(status.dirty, usableStats),
    files,
    status,
  };
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

async function switchBranch(directory, branch) {
  const status = await readStatus(directory);
  if (!status.repo) throw new GitHelperError('当前项目还不是 Git 仓库');
  if (branch === status.branch) return { output: '', status };
  if (!status.branches.some((entry) => entry.name === branch)) {
    throw new GitHelperError(`本地不存在分支 ${branch}`);
  }
  const result = await runGit(['checkout', branch], directory);
  if (result.code !== 0) {
    throw new GitHelperError(gitFailure(result, `切换到分支 ${branch} 失败`));
  }
  return { output: cleanOutput(result.stderr) || `已切换到 ${branch}`, status: await readStatus(directory) };
}

async function createBranch(directory, name, base) {
  const status = await readStatus(directory);
  if (!status.repo) throw new GitHelperError('当前项目还不是 Git 仓库，请先初始化');
  const valid = ensureSpawned(await runGit(['check-ref-format', '--branch', name], directory));
  if (valid.code !== 0) throw new GitHelperError(`分支名「${name}」不合法`);
  if (status.branches.some((entry) => entry.name === name)) {
    throw new GitHelperError(`分支 ${name} 已存在`);
  }
  const args = ['checkout', '-b', name];
  if (base !== undefined) {
    if (!status.branches.some((entry) => entry.name === base)) {
      throw new GitHelperError(`起点分支 ${base} 不存在`);
    }
    args.push(base);
  }
  const result = await runGit(args, directory);
  if (result.code !== 0) {
    throw new GitHelperError(gitFailure(result, `创建分支 ${name} 失败`));
  }
  return { output: `已创建并切换到 ${name}`, status: await readStatus(directory) };
}

async function mergeBranch(directory, branch) {
  const status = await readStatus(directory);
  if (!status.repo) throw new GitHelperError('当前项目还不是 Git 仓库');
  if (status.detached) throw new GitHelperError('当前处于 detached HEAD 状态，无法合并');
  if (branch === status.branch) throw new GitHelperError('不能把当前分支合并到自身');
  if (!status.branches.some((entry) => entry.name === branch)) {
    throw new GitHelperError(`本地不存在分支 ${branch}`);
  }
  const result = await runGit(['merge', '--no-edit', branch], directory);
  if (result.code !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`;
    if (/CONFLICT|冲突/i.test(detail)) {
      const files = status.dirty.map((entry) => entry.path);
      throw new GitHelperError(
        `合并 ${branch} 发生冲突，请在终端解决冲突后再提交${files.length > 0 ? `（涉及 ${files.length} 个已变更文件）` : ''}`,
      );
    }
    throw new GitHelperError(gitFailure(result, `合并 ${branch} 失败`));
  }
  return { output: cleanOutput(result.stdout) || `已合并 ${branch}`, status: await readStatus(directory) };
}

async function commitChanges(directory, message) {
  const lines = message.split(/\r?\n/).map((line) => line.trimEnd());
  const subject = (lines.shift() ?? '').trim();
  if (subject === '') throw new GitHelperError('提交说明不能为空');
  const body = lines.join('\n').trim();

  // Never let `git add -A` launder unresolved conflict markers into a commit:
  // a merge left the working tree dirty with conflict entries, and staging them
  // without an explicit resolution would commit the markers.
  const before = await readStatus(directory);
  if (!before.repo) throw new GitHelperError('当前项目还不是 Git 仓库');
  if (conflictEntries(before).length > 0) throw new GitHelperError(conflictMessage(before));
  if (before.dirty.length === 0) throw new GitHelperError('工作区没有可提交的变更');

  const add = ensureSpawned(await runGit(['add', '-A'], directory));
  if (add.code !== 0) throw new GitHelperError(gitFailure(add, '暂存变更失败'));

  const args = ['commit', '-m', subject];
  if (body !== '') args.push('-m', body);
  const result = await runGit(args, directory);
  if (result.code !== 0) throw new GitHelperError(gitFailure(result, '提交失败'));

  return {
    summary: subject,
    output: cleanOutput(result.stdout),
    status: await readStatus(directory),
  };
}

async function pushBranch(directory) {
  const status = await readStatus(directory);
  if (!status.repo) throw new GitHelperError('当前项目还不是 Git 仓库');
  if (status.detached) throw new GitHelperError('当前处于 detached HEAD 状态，无法推送');
  if (status.branch === null) throw new GitHelperError('无法确定当前分支');
  if (status.dirty.length > 0) {
    throw new GitHelperError(`工作区还有 ${status.dirty.length} 个未提交的变更，请先提交或清理后再推送`);
  }

  const remotesResult = ensureSpawned(await runGit(['remote'], directory));
  const remotes = remotesResult.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (remotes.length === 0) throw new GitHelperError('尚未配置远程仓库，请先添加 remote');

  let args;
  if (status.upstream !== null) {
    args = ['push'];
  } else {
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    args = ['push', '-u', remote, status.branch];
  }

  const result = await runGit(args, directory);
  if (result.code !== 0) throw new GitHelperError(gitFailure(result, '推送失败'));
  return {
    output: cleanOutput(`${result.stderr}\n${result.stdout}`) || '推送完成',
    status: await readStatus(directory),
  };
}

async function initRepository(directory) {
  const current = await readStatus(directory);
  if (current.repo) return { output: '已经是 Git 仓库', status: current };

  let result = await runGit(['init', '-b', 'main'], directory);
  if (result.code !== 0) result = await runGit(['init'], directory);
  if (result.code !== 0) throw new GitHelperError(gitFailure(result, '初始化 Git 仓库失败'));

  return { output: cleanOutput(result.stdout), status: await readStatus(directory) };
}

/** Test-only surface: the operations above, without mounting the plugin. */
export const __internals = {
  buildCommitMessage,
  changeKind,
  parsePorcelainV2,
  readStatus,
  readDiffStats,
  prepareCommit,
  switchBranch,
  createBranch,
  mergeBranch,
  commitChanges,
  pushBranch,
  initRepository,
  runGit,
};
