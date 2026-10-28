/**
 * dsh-git-helper — Web client half.
 *
 * Registers one compact control in `conversation.input.left` (the left side of
 * the composer tool row). The control shows the active project's current Git
 * branch and opens a popover that drives the Host half's same-origin JSON route:
 * switch / create / merge branches, commit with an auto-summarized message,
 * push, and initialize a repository.
 *
 * Plain JavaScript on purpose: loaded by the Harness module loader, React comes
 * from the page's module table, and every color comes from a `--dsw-alias-*`
 * theme token so the control follows light/dark themes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-git-helper',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/dsh-git-helper/api';
    const REFRESH_MS = 15000;

    /* ---------------------------------------------------------------- */
    /* Copy                                                              */
    /* ---------------------------------------------------------------- */

    const DICT = {
      zh: {
        title: 'Git 助手',
        git: 'Git',
        loading: '读取 Git 状态…',
        initShort: '初始化 Git',
        noSession: '当前会话不可用',
        serviceError: 'Git 服务未就绪',
        refresh: '刷新',
        clean: '工作区干净',
        changed: '{n} 个变更',
        ahead: '领先 {n}',
        behind: '落后 {n}',
        detached: 'detached HEAD',
        noUpstream: '未设置上游',
        branches: '切换分支',
        actions: '操作',
        createBranch: '新建分支…',
        mergeBranch: '合并分支…',
        commitChanges: '提交变更…',
        push: '推送',
        initRepo: '初始化 Git 仓库',
        notRepoTitle: '当前项目还不是 Git 仓库',
        notRepoDesc: '初始化后即可在这里切换分支、提交并推送。',
        initNow: '初始化仓库',
        newBranchTitle: '新建分支',
        newBranchName: '分支名',
        baseBranch: '起点',
        baseCurrent: '当前 HEAD',
        create: '创建并切换',
        back: '返回',
        cancel: '取消',
        mergeTitle: '合并到当前分支',
        mergeTo: '将 {branch} 合并到 {current}',
        mergeConfirm: '确认合并',
        mergeNone: '没有其他本地分支可合并',
        noBranches: '没有本地分支',
        commitTitle: '提交变更',
        commitAutoHint: '提交说明已根据工作区变动自动总结，可修改后提交。',
        fileCount: '{n} 个文件',
        moreFiles: '…还有 {n} 个文件',
        confirmCommit: '确认提交',
        committed: '提交成功',
        pushed: '推送完成',
        merged: '合并完成',
        created: '分支已创建',
        initialized: '仓库已初始化',
        switched: '已切换到 {branch}',
        root: '仓库',
        lastCommit: '最近提交',
        pushDirty: '有未提交的变更',
      },
      en: {
        title: 'Git Helper',
        git: 'Git',
        loading: 'Reading Git status…',
        initShort: 'Init Git',
        noSession: 'Session unavailable',
        serviceError: 'Git service not ready',
        refresh: 'Refresh',
        clean: 'Working tree clean',
        changed: '{n} changed',
        ahead: '{n} ahead',
        behind: '{n} behind',
        detached: 'detached HEAD',
        noUpstream: 'no upstream',
        branches: 'Switch branch',
        actions: 'Actions',
        createBranch: 'New branch…',
        mergeBranch: 'Merge branch…',
        commitChanges: 'Commit changes…',
        push: 'Push',
        initRepo: 'Initialize Git repository',
        notRepoTitle: 'This project is not a Git repository',
        notRepoDesc: 'Initialize it to switch branches, commit and push from here.',
        initNow: 'Initialize',
        newBranchTitle: 'New branch',
        newBranchName: 'Branch name',
        baseBranch: 'Start from',
        baseCurrent: 'Current HEAD',
        create: 'Create and switch',
        back: 'Back',
        cancel: 'Cancel',
        mergeTitle: 'Merge into current branch',
        mergeTo: 'Merge {branch} into {current}',
        mergeConfirm: 'Merge',
        mergeNone: 'No other local branches to merge',
        noBranches: 'No local branches',
        commitTitle: 'Commit changes',
        commitAutoHint: 'The message was summarized from the working tree; edit it if needed.',
        fileCount: '{n} files',
        moreFiles: '…and {n} more',
        confirmCommit: 'Commit',
        committed: 'Committed',
        pushed: 'Pushed',
        merged: 'Merged',
        created: 'Branch created',
        initialized: 'Repository initialized',
        switched: 'Switched to {branch}',
        root: 'Repository',
        lastCommit: 'Last commit',
        pushDirty: 'Uncommitted changes',
      },
    };

    function translate(locale, key, values) {
      const table = DICT[locale] && DICT[locale][key] !== undefined ? DICT[locale] : DICT.zh;
      const text = table[key] !== undefined ? table[key] : (DICT.en[key] !== undefined ? DICT.en[key] : key);
      if (values === undefined) return text;
      return String(text).replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
      ));
    }

    /* ---------------------------------------------------------------- */
    /* Small helpers                                                     */
    /* ---------------------------------------------------------------- */

    function messageOf(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message;
      return String(error);
    }

    function baseName(path) {
      if (typeof path !== 'string' || path === '') return '';
      const parts = path.split(/[\\/]+/).filter((part) => part !== '');
      return parts.length > 0 ? parts[parts.length - 1] : path;
    }

    function firstLines(text, count) {
      if (typeof text !== 'string') return '';
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
      return lines.slice(0, count).join('\n');
    }

    async function request(sessionId, action, params) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ sessionId, action }, params || {})),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const text = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(text);
      }
      if (payload === null || payload.ok !== true) {
        const text = payload && typeof payload.error === 'string' ? payload.error : 'Git 服务返回了无效响应';
        throw new Error(text);
      }
      return payload.data;
    }

    /* ---------------------------------------------------------------- */
    /* Icons                                                             */
    /* ---------------------------------------------------------------- */

    function icon(children, size = 14) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false', style: { flex: 'none' },
      }, children);
    }

    const icons = {
      branch: () => icon([
        h('circle', { key: 'a', cx: 6, cy: 5, r: 2.2 }),
        h('circle', { key: 'b', cx: 6, cy: 19, r: 2.2 }),
        h('circle', { key: 'c', cx: 18, cy: 7, r: 2.2 }),
        h('path', { key: 'd', d: 'M6 7.2v9.6' }),
        h('path', { key: 'e', d: 'M6 11c0-2.2 2.2-4 4.5-4H18' }),
      ]),
      chevron: () => icon([h('path', { key: 'c', d: 'M7 10l5-5 5 5' })]),
      plus: () => icon([h('path', { key: 'a', d: 'M12 5v14' }), h('path', { key: 'b', d: 'M5 12h14' })]),
      merge: () => icon([
        h('circle', { key: 'a', cx: 6, cy: 18, r: 2.2 }),
        h('circle', { key: 'b', cx: 18, cy: 6, r: 2.2 }),
        h('path', { key: 'c', d: 'M6 15.8V8a3 3 0 0 1 3-3h3' }),
        h('path', { key: 'd', d: 'M12 12l6-6' }),
      ]),
      commit: () => icon([
        h('circle', { key: 'a', cx: 12, cy: 12, r: 3.2 }),
        h('path', { key: 'b', d: 'M3 12h5.8' }),
        h('path', { key: 'c', d: 'M15.2 12H21' }),
      ]),
      push: () => icon([
        h('path', { key: 'a', d: 'M12 20V5' }),
        h('path', { key: 'b', d: 'M6 11l6-6 6 6' }),
      ]),
      repo: () => icon([
        h('path', { key: 'a', d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5z' }),
        h('path', { key: 'b', d: 'M4 17.5h15' }),
        h('path', { key: 'c', d: 'M8 3v9l2.5-1.8L13 12V3' }),
      ]),
      back: () => icon([h('path', { key: 'a', d: 'M14 6l-6 6 6 6' })]),
      refresh: () => icon([
        h('path', { key: 'a', d: 'M20 12a8 8 0 1 1-2.6-5.9' }),
        h('path', { key: 'b', d: 'M20 4v4.5h-4.5' }),
      ]),
      check: () => icon([h('path', { key: 'a', d: 'M5 12.5l4.5 4.5L19 7.5' })]),
      dot: () => icon([h('circle', { key: 'a', cx: 12, cy: 12, r: 4, fill: 'currentColor', stroke: 'none' })]),
    };

    /* ---------------------------------------------------------------- */
    /* Styles                                                            */
    /* ---------------------------------------------------------------- */

    const CSS = `
.gh-wrap { position: relative; display: inline-flex; align-items: center; min-width: 0; }
.gh-trigger {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; max-width: 220px;
  padding: 0 8px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer; user-select: none;
}
.gh-trigger:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.gh-trigger[aria-expanded="true"] { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }
.gh-trigger:disabled { cursor: default; opacity: 0.55; }
.gh-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 168px; }
.gh-dirty-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); flex: none; }
.gh-chevron { opacity: 0.55; display: inline-flex; }
.gh-popover {
  position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 80;
  width: 348px; max-width: calc(100vw - 32px); max-height: min(68vh, 560px);
  overflow: auto; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 8px; padding: 12px;
  border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);
  font-size: 12px; line-height: 1.45;
}
.gh-head { display: flex; align-items: flex-start; gap: 8px; }
.gh-head-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.gh-head-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh-head-branch { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.gh-head-branch > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
  padding: 0; border: 1px solid transparent; border-radius: 7px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer; flex: none;
}
.gh-icon-btn:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.gh-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.gh-meta b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.gh-meta-warn { color: var(--dsw-alias-state-warn-primary); }
.gh-last { color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; min-width: 0; }
.gh-last code { font-family: inherit; color: var(--dsw-alias-label-primary); margin-right: 4px; }
.gh-section-title { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.gh-scroll { display: flex; flex-direction: column; gap: 2px; max-height: 168px; overflow: auto; margin: 0 -4px; padding: 0 4px; }
.gh-row {
  display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box;
  padding: 7px 8px; border: 0; border-radius: 8px; background: transparent;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.gh-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.gh-row:disabled { cursor: default; opacity: 0.5; }
.gh-row.is-current { color: var(--dsw-alias-brand-primary); }
.gh-row-icon { display: inline-flex; color: var(--dsw-alias-label-secondary); }
.gh-row.is-current .gh-row-icon { color: var(--dsw-alias-brand-primary); }
.gh-row-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh-row-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh-badge { flex: none; padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); color: var(--dsw-alias-brand-primary); font-size: 11px; }
.gh-banner { padding: 7px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); white-space: pre-wrap; word-break: break-word; }
.gh-banner-success { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); color: var(--dsw-alias-state-success-primary); }
.gh-banner-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); color: var(--dsw-alias-state-error-primary); }
.gh-empty { color: var(--dsw-alias-label-secondary); padding: 6px 2px; }
.gh-view { display: flex; flex-direction: column; gap: 8px; }
.gh-view-head { display: flex; align-items: center; gap: 6px; }
.gh-view-title { font-weight: 600; font-size: 12px; }
.gh-field { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary); }
.gh-input, .gh-textarea, .gh-select {
  width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; outline: none;
}
.gh-input, .gh-select { height: 30px; }
.gh-textarea { min-height: 108px; resize: vertical; line-height: 1.5; }
.gh-input:focus, .gh-textarea:focus, .gh-select:focus { border-color: var(--dsw-alias-brand-primary); }
.gh-files { display: flex; flex-direction: column; gap: 1px; color: var(--dsw-alias-label-secondary); font-size: 11px; max-height: 84px; overflow: auto; }
.gh-files span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.gh-btn {
  height: 28px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer;
}
.gh-btn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.gh-btn:disabled { opacity: 0.5; cursor: default; }
.gh-btn-primary {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  color: var(--dsw-alias-brand-primary);
}
.gh-btn-primary:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent); }
.gh-notch { align-self: stretch; color: var(--dsw-alias-label-secondary); }
.gh-spin { display: inline-flex; animation: gh-spin 0.9s linear infinite; }
@keyframes gh-spin { to { transform: rotate(360deg); } }
`;

    /* ---------------------------------------------------------------- */
    /* Component                                                         */
    /* ---------------------------------------------------------------- */

    function createGitHelper(ctx) {
      function readLocale() {
        try {
          const snapshot = ctx.locale.getSnapshot();
          if (snapshot && typeof snapshot.active === 'string' && snapshot.active !== '') return snapshot.active;
        } catch {
          /* fall through */
        }
        return 'zh';
      }

      function useLocale() {
        const [locale, setLocale] = React.useState(readLocale);
        React.useEffect(() => {
          let unsubscribe = () => {};
          try {
            unsubscribe = ctx.locale.subscribe(() => setLocale(readLocale())) || unsubscribe;
          } catch {
            /* locale service unavailable */
          }
          setLocale(readLocale());
          return () => {
            try {
              unsubscribe();
            } catch {
              /* ignore */
            }
          };
        }, []);
        return locale;
      }

      return function GitHelper(props) {
        const locale = useLocale();
        const t = (key, values) => translate(locale, key, values);
        const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';

        const rootRef = React.useRef(null);
        const [open, setOpen] = React.useState(false);
        const [view, setView] = React.useState('main');
        const [status, setStatus] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [notice, setNotice] = React.useState(null);
        const [branchName, setBranchName] = React.useState('');
        const [baseBranch, setBaseBranch] = React.useState('');
        const [mergeTarget, setMergeTarget] = React.useState('');
        const [commitMessage, setCommitMessage] = React.useState('');
        const [commitFiles, setCommitFiles] = React.useState([]);
        /* Latest session id, for dropping responses that arrive after a switch. */
        const sessionRef = React.useRef(sessionId);
        sessionRef.current = sessionId;
        const statusInFlight = React.useRef(false);

        const applyStatus = (next) => {
          if (next && typeof next === 'object') setStatus(next);
        };

        const loadStatus = React.useCallback(async (silent) => {
          if (sessionId === '') return;
          if (statusInFlight.current) return;
          statusInFlight.current = true;
          const activeSession = sessionId;
          try {
            const data = await request(activeSession, 'status');
            if (sessionRef.current !== activeSession) return;
            applyStatus(data);
            if (!silent) setError(null);
          } catch (failure) {
            if (sessionRef.current === activeSession && !silent) setError(messageOf(failure));
          } finally {
            statusInFlight.current = false;
          }
        }, [sessionId]);

        /* Load on mount / session change. */
        React.useEffect(() => {
          setStatus(null);
          setError(null);
          setNotice(null);
          setBusy(false);
          setView('main');
          setOpen(false);
          setBranchName('');
          setBaseBranch('');
          setMergeTarget('');
          setCommitMessage('');
          setCommitFiles([]);
          if (sessionId === '') return undefined;
          let alive = true;
          request(sessionId, 'status')
            .then((data) => {
              if (alive) setStatus(data);
            })
            .catch((failure) => {
              if (alive) setError(messageOf(failure));
            });
          return () => {
            alive = false;
          };
        }, [sessionId]);

        /* Keep the branch chip fresh while the page is visible. */
        const latestLoad = React.useRef(loadStatus);
        latestLoad.current = loadStatus;
        React.useEffect(() => {
          if (sessionId === '') return undefined;
          const timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            void latestLoad.current(true);
          }, REFRESH_MS);
          return () => clearInterval(timer);
        }, [sessionId]);

        const close = React.useCallback(() => {
          setOpen(false);
          setView('main');
          setNotice(null);
        }, []);

        /* Dismiss on outside click / Escape while open. */
        React.useEffect(() => {
          if (!open) return undefined;
          const onPointerDown = (event) => {
            const root = rootRef.current;
            if (root && event.target instanceof Node && !root.contains(event.target)) close();
          };
          const onKeyDown = (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              event.preventDefault();
              close();
            }
          };
          document.addEventListener('mousedown', onPointerDown, true);
          document.addEventListener('keydown', onKeyDown, true);
          return () => {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
          };
        }, [open, close]);

        const run = async (action, params, successText) => {
          if (sessionId === '') return undefined;
          const activeSession = sessionId;
          setBusy(true);
          setError(null);
          setNotice(null);
          try {
            const data = await request(activeSession, action, params);
            if (sessionRef.current !== activeSession) return undefined;
            if (data && data.status) applyStatus(data.status);
            if (successText !== undefined) {
              setNotice({ kind: 'success', text: successText });
            } else if (data && typeof data.output === 'string' && data.output.trim() !== '') {
              setNotice({ kind: 'success', text: firstLines(data.output, 3) });
            }
            return data;
          } catch (failure) {
            if (sessionRef.current === activeSession) setError(messageOf(failure));
            return undefined;
          } finally {
            setBusy(false);
          }
        };

        const beginCommit = async () => {
          if (sessionId === '') return;
          const activeSession = sessionId;
          setBusy(true);
          setError(null);
          setNotice(null);
          try {
            const data = await request(activeSession, 'prepare-commit');
            if (sessionRef.current !== activeSession) return;
            setCommitMessage(typeof data.message === 'string' ? data.message : '');
            setCommitFiles(Array.isArray(data.files) ? data.files : []);
            applyStatus(data.status);
            setView('commit');
          } catch (failure) {
            if (sessionRef.current === activeSession) setError(messageOf(failure));
          } finally {
            setBusy(false);
          }
        };

        const confirmCommit = async () => {
          const data = await run('commit', { message: commitMessage }, t('committed'));
          if (data !== undefined) {
            setCommitMessage('');
            setCommitFiles([]);
            setView('main');
          }
        };

        const refreshNow = async () => {
          setError(null);
          await loadStatus(false);
        };

        const repo = status !== null && status.repo === true;
        const branches = repo && Array.isArray(status.branches) ? status.branches : [];
        const dirty = repo && Array.isArray(status.dirty) ? status.dirty : [];
        const dirtyCount = dirty.length;
        const currentBranch = repo ? (status.detached ? t('detached') : status.branch || '') : '';
        const label = (() => {
          if (sessionId === '') return t('git');
          if (status === null) return t('git');
          if (!repo) return t('initShort');
          return currentBranch;
        })();
        const triggerTitle = sessionId === ''
          ? t('noSession')
          : status === null
            ? t('loading')
            : repo
              ? `${t('root')}: ${status.root || ''}\n${t('title')}`
              : t('notRepoTitle');

        const canOpen = sessionId !== '';
        const toggleOpen = () => {
          if (!canOpen) return;
          const next = !open;
          setOpen(next);
          if (next) {
            setView('main');
            setError(null);
            setNotice(null);
            void loadStatus(true);
          }
        };

        /* --- shared fragments --------------------------------------- */

        const backButton = (targetView = 'main') => h('button', {
          type: 'button', className: 'gh-icon-btn', title: t('back'), 'aria-label': t('back'),
          onClick: () => { setView(targetView); setError(null); setNotice(null); },
        }, icons.back());

        const banner = () => {
          const blocks = [];
          if (error !== null) blocks.push(h('div', { className: 'gh-banner gh-banner-error', key: 'error' }, error));
          else if (notice !== null) blocks.push(h('div', { className: `gh-banner gh-banner-${notice.kind}`, key: 'notice' }, notice.text));
          return blocks;
        };

        const head = () => h('div', { className: 'gh-head' },
          h('div', { className: 'gh-head-main' },
            h('span', { className: 'gh-head-title', title: status && status.root ? status.root : '' },
              repo ? baseName(status.root) || t('title') : t('title')),
            repo ? h('span', { className: 'gh-head-branch' },
              h('span', { className: 'gh-row-icon' }, icons.branch()),
              h('span', null, currentBranch),
              status.upstream ? h('span', { className: 'gh-row-hint' }, status.upstream) : h('span', { className: 'gh-row-hint' }, t('noUpstream')),
            ) : null,
          ),
          h('button', {
            type: 'button', className: 'gh-icon-btn', title: t('refresh'), 'aria-label': t('refresh'),
            onClick: () => { void refreshNow(); }, disabled: busy || sessionId === '',
          }, h('span', { className: busy ? 'gh-spin' : undefined }, icons.refresh())),
        );

        const meta = () => {
          if (!repo) return null;
          const items = [
            h('span', { key: 'dirty', className: dirtyCount > 0 ? 'gh-meta-warn' : null },
              dirtyCount > 0 ? t('changed', { n: dirtyCount }) : t('clean')),
          ];
          if (status.ahead > 0) items.push(h('span', { key: 'ahead' }, t('ahead', { n: status.ahead })));
          if (status.behind > 0) items.push(h('span', { key: 'behind' }, t('behind', { n: status.behind })));
          if (status.lastCommit) {
            items.push(h('span', { key: 'last', className: 'gh-last', title: status.lastCommit.subject },
              h('code', null, status.lastCommit.short), status.lastCommit.subject));
          }
          return h('div', { className: 'gh-meta' }, items);
        };

        const branchRows = () => {
          if (branches.length === 0) return h('div', { className: 'gh-empty' }, t('noBranches'));
          return h('div', { className: 'gh-scroll' }, branches.map((branch) => h('button', {
            key: branch.name,
            type: 'button',
            className: `gh-row${branch.current ? ' is-current' : ''}`,
            disabled: busy || branch.current,
            title: branch.name,
            onClick: async () => {
              const data = await run('switch', { branch: branch.name }, t('switched', { branch: branch.name }));
              if (data !== undefined) setView('main');
            },
          },
          h('span', { className: 'gh-row-icon' }, branch.current ? icons.check() : icons.branch()),
          h('span', { className: 'gh-row-text' }, branch.name),
          branch.upstream ? h('span', { className: 'gh-row-hint' }, branch.upstream) : null,
          )));
        };

        const actionRow = (key, glyph, text, onClick, options = {}) => h('button', {
          key,
          type: 'button',
          className: 'gh-row',
          disabled: busy || options.disabled === true,
          onClick,
        },
        h('span', { className: 'gh-row-icon' }, glyph()),
        h('span', { className: 'gh-row-text' }, text),
        options.badge !== undefined && options.badge > 0 ? h('span', { className: 'gh-badge' }, options.badge) : null,
        );

        /* --- views -------------------------------------------------- */

        const mainView = () => {
          if (!repo) {
            return h('div', { className: 'gh-view' },
              h('div', { className: 'gh-empty' }, t('notRepoTitle')),
              h('div', { className: 'gh-empty' }, t('notRepoDesc')),
              h('div', { className: 'gh-foot' },
                h('button', {
                  type: 'button', className: 'gh-btn gh-btn-primary', disabled: busy,
                  onClick: async () => {
                    const data = await run('init', {}, t('initialized'));
                    if (data !== undefined) setView('main');
                  },
                }, t('initNow')),
              ),
            );
          }
          return h('div', { className: 'gh-view' },
            meta(),
            h('div', { className: 'gh-section-title' }, t('branches')),
            branchRows(),
            h('div', { className: 'gh-section-title' }, t('actions')),
            actionRow('create', icons.plus, t('createBranch'), () => { setView('create'); setBranchName(''); setBaseBranch(''); setError(null); setNotice(null); }),
            actionRow('merge', icons.merge, t('mergeBranch'), () => { setView('merge'); setMergeTarget(''); setError(null); setNotice(null); }, { disabled: branches.length < 2 || status.detached }),
            actionRow('commit', icons.commit, t('commitChanges'), () => { void beginCommit(); }, { badge: dirtyCount }),
            actionRow('push', icons.push, t('push'), async () => { await run('push', {}, t('pushed')); }),
          );
        };

        const submitCreate = async () => {
          const name = branchName.trim();
          if (name === '') return;
          const data = await run('create', { name, base: baseBranch === '' ? undefined : baseBranch }, t('created'));
          if (data !== undefined) {
            setBranchName('');
            setBaseBranch('');
            setView('main');
          }
        };

        const createView = () => h('div', { className: 'gh-view' },
          h('div', { className: 'gh-view-head' }, backButton(), h('span', { className: 'gh-view-title' }, t('newBranchTitle'))),
          h('label', { className: 'gh-field' },
            h('span', null, t('newBranchName')),
            h('input', {
              className: 'gh-input', type: 'text', value: branchName, autoFocus: true,
              placeholder: 'feature/my-branch',
              onChange: (event) => setBranchName(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submitCreate();
                }
              },
            }),
          ),
          h('label', { className: 'gh-field' },
            h('span', null, t('baseBranch')),
            h('select', {
              className: 'gh-select', value: baseBranch,
              onChange: (event) => setBaseBranch(event.target.value),
            },
            h('option', { value: '' }, t('baseCurrent')),
            branches.map((branch) => h('option', { key: branch.name, value: branch.name }, branch.name)),
            ),
          ),
          h('div', { className: 'gh-foot' },
            h('button', { type: 'button', className: 'gh-btn', onClick: () => setView('main') }, t('cancel')),
            h('button', {
              type: 'button', className: 'gh-btn gh-btn-primary',
              disabled: busy || branchName.trim() === '',
              onClick: () => { void submitCreate(); },
            }, t('create')),
          ),
        );

        const mergeView = () => {
          const others = branches.filter((branch) => !branch.current);
          return h('div', { className: 'gh-view' },
            h('div', { className: 'gh-view-head' }, backButton(), h('span', { className: 'gh-view-title' }, t('mergeTitle'))),
            others.length === 0
              ? h('div', { className: 'gh-empty' }, t('mergeNone'))
              : h('div', { className: 'gh-scroll' }, others.map((branch) => h('button', {
                key: branch.name,
                type: 'button',
                className: `gh-row${mergeTarget === branch.name ? ' is-current' : ''}`,
                disabled: busy,
                onClick: () => setMergeTarget(branch.name),
              },
              h('span', { className: 'gh-row-icon' }, mergeTarget === branch.name ? icons.check() : icons.merge()),
              h('span', { className: 'gh-row-text' }, branch.name),
              ))),
            mergeTarget === '' ? null : h('div', { className: 'gh-banner' },
              t('mergeTo', { branch: mergeTarget, current: currentBranch })),
            h('div', { className: 'gh-foot' },
              h('button', { type: 'button', className: 'gh-btn', onClick: () => setView('main') }, t('cancel')),
              h('button', {
                type: 'button', className: 'gh-btn gh-btn-primary',
                disabled: busy || mergeTarget === '',
                onClick: async () => {
                  const data = await run('merge', { branch: mergeTarget }, t('merged'));
                  if (data !== undefined) {
                    setMergeTarget('');
                    setView('main');
                  }
                },
              }, t('mergeConfirm')),
            ),
          );
        };

        const filesPreview = () => {
          const shown = commitFiles.slice(0, 6);
          return h('div', { className: 'gh-files' },
            shown.map((file) => h('span', { key: file.path, title: file.path },
              `${KIND_TEXT[locale]?.[file.kind] ?? file.kind} ${file.path}`)),
            commitFiles.length > shown.length
              ? h('span', { key: 'more' }, t('moreFiles', { n: commitFiles.length - shown.length }))
              : null,
          );
        };

        const commitView = () => h('div', { className: 'gh-view' },
          h('div', { className: 'gh-view-head' }, backButton(), h('span', { className: 'gh-view-title' }, t('commitTitle'))),
          h('div', { className: 'gh-empty' }, t('fileCount', { n: commitFiles.length })),
          filesPreview(),
          h('div', { className: 'gh-empty' }, t('commitAutoHint')),
          h('textarea', {
            className: 'gh-textarea',
            value: commitMessage,
            spellCheck: false,
            onChange: (event) => setCommitMessage(event.target.value),
          }),
          h('div', { className: 'gh-foot' },
            h('button', { type: 'button', className: 'gh-btn', onClick: () => setView('main') }, t('cancel')),
            h('button', {
              type: 'button', className: 'gh-btn gh-btn-primary',
              disabled: busy || commitMessage.trim() === '',
              onClick: () => { void confirmCommit(); },
            }, t('confirmCommit')),
          ),
        );

        const unavailableView = () => h('div', { className: 'gh-view' },
          h('div', { className: 'gh-empty' }, t('serviceError')),
          h('div', { className: 'gh-foot' },
            h('button', {
              type: 'button', className: 'gh-btn', disabled: busy,
              onClick: () => { void refreshNow(); },
            }, t('refresh')),
          ),
        );

        const loadingView = () => h('div', { className: 'gh-view' },
          h('div', { className: 'gh-empty' }, t('loading')),
        );

        const popover = () => h('div', {
          className: 'gh-popover', role: 'dialog', 'aria-label': t('title'),
        },
        head(),
        ...banner(),
        status === null
          ? (error !== null ? unavailableView() : loadingView())
          : view === 'create' ? createView()
            : view === 'merge' ? mergeView()
              : view === 'commit' ? commitView()
                : mainView(),
        );

        return h('div', { className: 'gh-wrap', ref: rootRef },
          h('style', { key: 'style' }, CSS),
          h('button', {
            type: 'button',
            className: 'gh-trigger',
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            title: triggerTitle,
            disabled: !canOpen,
            onClick: toggleOpen,
          },
          h('span', { className: 'gh-row-icon' }, icons.branch()),
          h('span', { className: 'gh-label' }, label),
          status !== null && repo && dirtyCount > 0
            ? h('span', { className: 'gh-dirty-dot', title: t('changed', { n: dirtyCount }) })
            : null,
          h('span', { className: 'gh-chevron' }, icons.chevron()),
          ),
          open ? popover() : null,
        );
      };
    }

    /* Kind labels used by the commit file preview. */
    const KIND_TEXT = {
      zh: { added: '新增', deleted: '删除', modified: '修改', renamed: '重命名', copied: '复制', conflict: '冲突' },
      en: { added: 'Added', deleted: 'Deleted', modified: 'Modified', renamed: 'Renamed', copied: 'Copied', conflict: 'Conflict' },
    };

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const GitHelper = createGitHelper(ctx);
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-git-helper',
          order: 20,
          label: () => 'Git',
        }, (props) => h(GitHelper, props || {})));
      },
    };
  },
});
