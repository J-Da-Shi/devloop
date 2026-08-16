# DevLoop

DevLoop 是一个单用户、本机运行的开发任务执行系统。用户在自己的电脑上安装 Electron 客户端，客户端会启动一个只监听 `127.0.0.1` 的本地服务进程，负责管理任务队列、Git Worktree、结构化验收结果和审核推送。所有数据都保存在用户当前设备。

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

默认调用当前用户已经可用的 Codex CLI。只想验证界面和任务状态时使用模拟执行器：

```bash
DEVLOOP_RUNNER=fake pnpm dev:web
```

常用环境变量：

```text
DEVLOOP_RUNNER=codex
DEVLOOP_CODEX_EXECUTABLE=/absolute/path/to/codex
DEVLOOP_CODEX_IGNORE_USER_CONFIG=false
DEVLOOP_CODEX_TIMEOUT_MS=1800000
DEVLOOP_AGENT_CLAIM_DELAY_MS=5000
DEVLOOP_DATA_DIR=.devloop-data
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
├── Codex CLI
├── SQLite（任务与运行事件）
├── Git 仓库与 Worktree
└── Skill
```

开发环境的数据保存在项目内 `.devloop-data`，正式 Electron 安装将使用操作系统应用数据目录。

## 访问边界

DevLoop 不提供注册、登录、管理员账户或多租户。所有请求使用内置的"实例所有者"身份。这意味着服务入口必须由部署环境保护：

- 本机模式只监听 `127.0.0.1`。
- 若走可选的多人共享部署，公网入口必须启用 HTTPS，并增加 Basic Auth、IP 白名单或其他外层保护。
- 不要把 `4317` 端口直接开放到公网。

## 当前能力

- 通过 SSH Git 地址注册远程项目。
- 草稿达到 100 分后自动进入待执行。
- 任务进入待执行 5 秒后由 Worker 原子领取。
- 每次执行前自动 `fetch --prune origin`。
- 目标分支不存在时从默认分支创建执行基线。
- 在隔离 Git Worktree 中调用真实 Codex CLI。
- 自定义 Provider 不使用 `--output-schema`，由本地解析 JSON 并进行一次格式修复重试。
- 通过 SSE 实时刷新桌面和手机页面。
- 执行中的任务可请求取消，Codex 主进程会收到 SIGTERM;进程组级取消（一并终止 Codex 拉起的子进程与工具调用）尚未接入。
- 执行令牌轮换保证迟到结果不能覆盖任务状态。
- 非执行中任务可软删除，历史记录继续保留。
- 审核通过后安全推送远程目标分支，不进行强制推送。
- 管理版本化的 DevLoop Skill 内容，并把已启用版本装配到任务执行中。
- 读取运行环境中 Codex 已有的 Provider、原生 Skill 和 MCP 配置。

Worker 会在每次领取任务时读取所有已启用 Skill 的当前版本，并把同一份快照注入 Codex 主任务和自动冲突解决 Prompt。任务级 Skill 选择仍属于后续工作。

当前 Worker 会校验 Codex 最终 JSON 并创建结果 Commit，但还没有独立验证命令配置。独立测试命令及退出码审计属于下一阶段。

## 项目文档

- [开发方案](./DEVELOPMENT_PLAN.md)
- [技术选型](./TECH_SELECTION.md)
- [项目目录说明](./PROJECT_STRUCTURE.md)
- [可选：多人共享部署说明](./DEPLOYMENT.md)

## 验证命令

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```
