# dsh-git-helper / DSH Git 助手

在 DSH Web 输入框的工具行（“完全权限”下拉框右侧）显示当前项目的 Git 分支，点开后可以直接完成日常 Git 操作，不需要离开对话去终端。

## 显示位置

注册在 `conversation.input.left` 插槽（即图中标记 **2** 的位置，输入框左下工具行）。默认只显示当前分支名：

```
⑂ main ●
```

- `●` 表示工作区有未提交的变更。
- 没有 Git 仓库时显示 `初始化 Git`。
- 点开后的面板会显示仓库名、分支、上游跟踪、领先/落后提交数、最近一次提交、本地分支列表与操作入口。

## 功能

| 功能 | 说明 |
| --- | --- |
| 切换分支 | 面板内列出本地分支，点击即 `git checkout` |
| 新建分支 | 输入分支名，可选起点（默认当前 HEAD），`git checkout -b` |
| 合并分支 | 选择本地分支合并到当前分支，`git merge --no-edit`；冲突时提示先到终端解决，且在有未解决冲突时拒绝提交 |
| 提交 | 自动读取工作区变动并生成提交说明（主题 + 逐文件行数统计，含未跟踪文件），可编辑后 `git add -A && git commit` |
| 推送 | 没有上游时自动 `git push -u <remote> <branch>`；有上游时 `git push` |
| 初始化仓库 | 项目不是 Git 仓库时 `git init -b main` |

## 实现方式

- **Host 半**（`index.js`）：在 `webServer` 上注册一个同源 JSON 路由 `POST /dsh-git-helper/api`，由 DSH `connection.requestRejection()` 做 Host/Origin 与登录校验（该服务不可用时拒绝请求，不会放开）；按请求携带的 Session ID 通过 `sessions` + `workingDirectory` 解析当前项目目录，再用本机 `git` 执行操作。同一目录的写操作串行化，`GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` 避免凭据提示把请求挂死。
- **Client 半**（`client.js`）：普通 JS 模块（`window.__ModuleLoader__`），React 来自页面的模块表，样式只使用 `--dsw-alias-*` 主题变量，自动适配明暗主题；通过同源 `fetch` 调用 Host 路由。
- 每 15 秒（页面可见时）静默刷新一次状态，点开面板、执行操作后也会刷新。

## 安装

```bash
dsh plugin add <本目录的绝对路径>
```

或在 DSH 的插件管理页安装本目录。安装后刷新页面，输入框左下工具行会出现分支胶囊。

## 测试

Host 半的 Git 操作有独立集成测试（在系统临时目录创建一次性仓库，不碰当前项目）：

```bash
node test/host.test.mjs
```

覆盖：仓库探测、状态解析（含重命名/分离 HEAD）、提交说明生成、提交、创建/切换/合并分支、推送与上游设置、初始化仓库、合并冲突拦截、未跟踪文件行数统计、从 detached HEAD 切回分支。

## 已知限制

- 只操作**当前 Session 的工作目录**；远程/SSH 工作区沿用本机 `git`，不保证可用。
- 提交说明是根据 `git status` / `git diff --numstat` 生成的确定性摘要（变更类型、目录、文件与行数），不是语义级代码总结。
- 推送使用本机 Git 已有凭据；需要交互式输入的推送会直接失败并显示原因。
- 不提供 stash、rebase、tag、撤销提交等高级操作。
