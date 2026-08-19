# DevLoop

English version: [README.en.md](./README.en.md)

DevLoop 是一个单用户、本机运行的开发任务执行系统。用户在自己的电脑上安装 Electron 客户端，客户端会启动一个只监听 `127.0.0.1` 的本地服务进程，负责管理任务队列、Git Worktree、结构化验收结果和审核推送。所有数据都保存在用户当前设备。

每个项目可以独立选择使用 **Codex CLI** 还是 **Claude Code CLI** 作为执行器，配置保存在本机数据库，切换后立刻对下一次执行生效。

## 获取与使用

### 普通用户：下载 Electron 安装包

即将提供。发布后可从 Releases 下载对应平台的 `.dmg` / `.exe` 安装包，安装后直接使用。

在此之前请使用下面的源码方式运行。

### 开发者：使用源码运行

要求 Node.js 24 和 pnpm 10。

```bash
git clone <本仓库地址>
cd devloop
pnpm install
pnpm dev
```

`pnpm dev` 会同时启动本地服务、Web 页面和 Electron 客户端；`pnpm dev:web` 只启动本地服务和 Web 页面，在浏览器中打开 `http://127.0.0.1:5173`。

默认调用当前用户已经可用的 Codex CLI。也可以在项目卡片上把执行器切换成 Claude Code CLI（需要本机已安装并登录 `claude`）。只想验证界面和任务状态时使用模拟执行器：

```bash
DEVLOOP_RUNNER=fake pnpm dev:web
```

服务端环境变量如下。`pnpm dev` 不会自动加载项目根目录的 `.env`，需要在命令前设置、从 shell 导出，或通过进程管理器注入。

```bash
# 解析数据库迁移、Web 静态资源和输出 Schema 的仓库根目录；源码运行时默认是当前仓库。
DEVLOOP_REPOSITORY_ROOT=/absolute/path/to/devloop

# 服务监听地址；默认仅允许本机访问。
DEVLOOP_HOST=127.0.0.1

# 服务监听端口。
DEVLOOP_PORT=4317

# 是否允许监听非回环地址；DEVLOOP_HOST 不是本机地址时必须设为 true。
DEVLOOP_ALLOW_LAN=false

# 数据库、Git 仓库镜像、Worktree 和 Skill 的存储目录；相对路径基于仓库根目录。
DEVLOOP_DATA_DIR=.devloop-data

# 服务日志级别，传给 Fastify/Pino，例如 trace、debug、info、warn、error。
DEVLOOP_LOG_LEVEL=info

# 项目未显式指定执行器时的兜底值；可选 codex 或 fake。
DEVLOOP_RUNNER=codex

# Codex CLI 的命令名或绝对路径。
DEVLOOP_CODEX_EXECUTABLE=codex

# 是否让 Codex CLI 忽略用户 config.toml 和规则文件。
DEVLOOP_CODEX_IGNORE_USER_CONFIG=false

# Codex 连续无输出多久后判定为卡住并终止，单位毫秒；不是任务总执行时限。
DEVLOOP_CODEX_STALL_TIMEOUT_MS=1800000

# Claude Code CLI 的命令名或绝对路径。
DEVLOOP_CLAUDE_CODE_EXECUTABLE=claude

# Claude Code 连续无输出多久后判定为卡住并终止，单位毫秒；不是任务总执行时限。
DEVLOOP_CLAUDE_CODE_STALL_TIMEOUT_MS=1800000

# 任务进入待执行状态后，Worker 至少等待多久再领取，单位毫秒。
DEVLOOP_AGENT_CLAIM_DELAY_MS=5000

# Fake Runner 模拟一次执行所等待的时间，单位毫秒。
DEVLOOP_FAKE_RUNNER_DELAY_MS=850

# 自动预览启动后等待健康检查通过的最长时间，单位毫秒。
DEVLOOP_PREVIEW_STARTUP_TIMEOUT_MS=90000

# Playwright 页面加载、截图和基础检查的超时时间，单位毫秒。
DEVLOOP_PLAYWRIGHT_TIMEOUT_MS=60000

# 项目自定义 Playwright 命令的最长执行时间，单位毫秒。
DEVLOOP_PLAYWRIGHT_TEST_TIMEOUT_MS=600000

# 可选：指定已有的 Chromium/Chrome/Edge 可执行文件。未设置时按 Playwright、Chrome、Edge 顺序探测。
DEVLOOP_PLAYWRIGHT_EXECUTABLE=
```

`DEVLOOP_CODEX_TIMEOUT_MS` 仅作为旧版本兼容别名保留；新配置应使用 `DEVLOOP_CODEX_STALL_TIMEOUT_MS`。

项目页可以为每个项目配置预览命令，例如 `pnpm dev -- --host 127.0.0.1 --port {{port}}`。任务完成后，DevLoop 会在结果 Commit 的隔离 Worktree 中启动该命令，运行基础 Playwright 检查并把截图、检查项和自定义交互测试输出附到审核页。预览命令留空时自动验证会明确记录为“已跳过”。预览与测试进程不会继承 DevLoop 的 API Key、Git Token 等敏感环境变量，只保留必要的系统路径以及 `VITE_`、`NEXT_PUBLIC_`、`PUBLIC_` 开头的公开变量。

Playwright 不会默认把 Chromium 打进桌面安装包。需要自动截图时，在运行环境执行 `pnpm exec playwright install chromium`，或通过 `DEVLOOP_PLAYWRIGHT_EXECUTABLE` 指向本机已有的兼容浏览器；没有浏览器时任务仍会进入审核，页面会显示跳过原因。

### 打包桌面客户端

在 macOS 上生成 dmg / zip：

```bash
pnpm --filter @devloop/desktop make
```

产物落在 `apps/desktop/out/make/`。桌面主进程支持以下环境变量：

```bash
# 改用外部 DevLoop Server；设置后，打包客户端不会启动内置服务。
DEVLOOP_SERVICE_URL=http://127.0.0.1:4317

# 覆盖界面加载地址；开发模式默认 http://127.0.0.1:5173，打包后默认使用服务地址。
DEVLOOP_WEB_URL=http://127.0.0.1:5173

# 启动时自动打开 Chromium DevTools；只有值为 1 时启用。
DEVLOOP_OPEN_DEVTOOLS=1

# 把 renderer console、加载失败和崩溃信息转发到主进程 stderr；只有值为 1 时启用。
DEVLOOP_LOG_RENDERER=1
```

### 可选：多人共享部署

如果需要多台设备连接同一实例，可以把 DevLoop 部署到用户自己的服务器上。此路径不是主流程，详见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 运行拓扑

```text
Electron 客户端 / 本机浏览器
              |
           127.0.0.1
              |
本机 DevLoop Server 进程
├── 执行器注册表（Codex CLI / Claude Code CLI / Fake）
├── SQLite（任务、运行事件、项目 runner 配置）
├── Git 仓库与 Worktree
└── Skill
```

开发环境的数据保存在项目内 `.devloop-data`，正式 Electron 安装使用操作系统应用数据目录。

## 执行器

DevLoop 在服务端维护一张 runner 注册表，`AgentWorker` 拉取任务时按 `project.runner` 挑选实例：

| Runner          | ID            | 说明                                                                                                        |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| Codex CLI       | `codex`       | 默认执行器，需要本机已登录 `codex`                                                                          |
| Claude Code CLI | `claude-code` | 与 Codex 契约完全一致（AgentResult schema、stall watchdog、JSON 修复、进程组管理），需要本机已登录 `claude` |
| Fake            | `fake`        | 内置模拟执行器，用于验证 UI 与状态流转，不做真实修改                                                        |

- 在项目卡片上直接下拉切换。fake 只作为环境兜底，不在项目选项中出现。
- 若项目指向的 runner 未注册（例如未来卸载了某个 CLI），worker 会回退到默认 runner 并 emit `runner.fallback` 事件写入运行日志。
- CLI 参数、事件流解析、prompt 规则细节请参阅 `packages/runners/src/codex-runner.ts` 与 `packages/runners/src/claude-code-runner.ts`。

## 访问边界

DevLoop 不提供注册、登录、管理员账户或多租户。所有请求使用内置的"实例所有者"身份。这意味着服务入口必须由部署环境保护：

- 本机模式只监听 `127.0.0.1`。
- 若走可选的多人共享部署，公网入口必须启用 HTTPS，并增加 Basic Auth、IP 白名单或其他外层保护。
- 不要把 `4317` 端口直接开放到公网。

## 当前能力

- 通过 SSH Git 地址注册远程项目，或选择本机目录注册本地 Git 项目。
- 每个项目独立选择 Codex CLI 或 Claude Code CLI 执行器。
- 草稿达到 100 分后自动进入待执行。
- 任务进入待执行 5 秒后由 Worker 原子领取。
- 每次执行前自动 `fetch --prune origin`。
- 目标分支不存在时从默认分支创建执行基线。
- 在隔离 Git Worktree 中调用真实执行器 CLI。
- 由本地解析 CLI 输出的 JSON 并进行一次格式修复重试。
- 通过 SSE 实时刷新桌面和手机页面。
- 执行中的任务可请求取消，Codex/Claude Code 主进程会收到 SIGTERM。进程组级取消（一并终止 CLI 拉起的子进程与工具调用）尚未接入。
- 执行令牌轮换保证迟到结果不能覆盖任务状态。
- 非执行中任务可软删除，历史记录继续保留。
- 审核通过后安全推送远程目标分支，不进行强制推送。
- 管理版本化的 DevLoop Skill 内容，并把已启用版本装配到任务执行中。
- 读取运行环境中 CLI 已有的 Provider、原生 Skill 和 MCP 配置。

Worker 会在每次领取任务时读取所有已启用 Skill 的当前版本，并把同一份快照注入主任务和自动冲突解决 Prompt。任务级 Skill 选择仍属于后续工作。

当前 Worker 会校验最终 JSON 并创建结果 Commit，但还没有独立验证命令配置。独立测试命令及退出码审计属于下一阶段。

## 项目文档

- [开发方案](./DEVELOPMENT_PLAN.md)
- [技术选型](./TECH_SELECTION.md)
- [项目目录说明](./PROJECT_STRUCTURE.md)
- [可选：多人共享部署说明](./DEPLOYMENT.md)

## 开源协议

本项目采用 [MIT License](./LICENSE) 开源。

## 验证命令

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```
