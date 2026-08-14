# DevLoop 项目目录说明

## 1. 顶层结构

```text
devloop/
├── apps/
│   ├── desktop/
│   ├── server/
│   └── web/
├── packages/
│   ├── db/
│   ├── git/
│   ├── runners/
│   ├── shared/
│   └── workflow/
├── schemas/
├── deploy/
├── design-system/
├── Dockerfile
├── compose.yaml
├── DEPLOYMENT.md
├── DEVELOPMENT_PLAN.md
├── TECH_SELECTION.md
└── PROJECT_STRUCTURE.md
```

仓库使用 pnpm Workspace Monorepo。可以独立运行的程序放在 `apps`，具有明确边界的共享能力放在 `packages`。

## 2. 为什么需要三个应用

### 2.1 `apps/desktop`

Electron 桌面外壳，负责：

- 创建原生窗口。
- 管理 macOS 红绿灯和全屏布局。
- 提供受控 Preload 接口。
- 连接本机或远程 DevLoop Server。
- 后续承载本地 Server 的安装与生命周期管理。

Electron 不保存任务事实，也不直接实现 Scheduler。

### 2.2 `apps/web`

React 单页应用，同时用于：

- Electron 窗口。
- 桌面浏览器。
- 手机浏览器/PWA。

它只通过 HTTP 和 SSE 使用 Server，不直接访问 Node.js、SQLite、Git、Codex 或任意本地文件。

### 2.3 `apps/server`

实例核心，负责：

- Fastify API 和 Web 静态资源。
- 内置实例所有者身份。
- Scheduler 与 AgentWorker。
- Codex Runner 生命周期。
- 项目注册、任务、审核和 Skill API。
- Server 启动与关闭。

本地模式和 Docker 模式运行的是同一个 Server。

## 3. packages 目录

### 3.1 `packages/shared`

Web 与 Server 共用：

- 领域类型。
- 状态枚举。
- 中文状态名称。
- Zod 输入 Schema。
- 状态转换规则。

该包不依赖数据库或 Node.js 文件系统，适合在浏览器中使用。

### 3.2 `packages/db`

SQLite 与 Drizzle 数据层：

- 数据库连接和 WAL 配置。
- Schema 与迁移。
- Repository。
- 原子任务领取。
- 乐观版本和幂等命令。
- 领域事件、审核记录和软删除。

`drizzle` 目录必须进入服务器镜像，否则新实例无法初始化数据库。

### 3.3 `packages/git`

Git 命令边界：

- SSH 仓库地址规范化。
- clone、fetch 和远程分支解析。
- Worktree 创建。
- 结果 Commit。
- 安全推送。
- 旧本地写回能力及相关测试。

所有 Git 操作使用参数数组调用系统 Git，不拼接 Shell 命令。

### 3.4 `packages/runners`

Agent Runner 抽象：

- `CodexRunner` 调用真实 Codex CLI。
- `FakeRunner` 用于页面和状态测试。
- Runner 输入、事件和结构化结果类型。
- 超时、取消、日志脱敏和 JSON 修复。

### 3.5 `packages/workflow`

以 XState 表达的任务状态机规格文档。当前不被 `apps/server` 引用，运行时的状态转换由 `packages/db` 的 Repository 与 `packages/shared/src/transitions.ts` 联合执行。

## 4. 其他目录

### 4.1 `schemas`

保存 Agent 最终结果的 JSON Schema。自定义 Provider 模式不会把它传给 `--output-schema`，但会放进 Prompt，并用于本地结果校验约束。

### 4.2 `deploy`

保存宝塔、Nginx 和后续部署平台模板。当前包含关闭 SSE 缓冲的宝塔 Nginx 片段。

### 4.3 `design-system`

保存界面视觉规范，不参与运行时逻辑。

### 4.4 生成目录

以下目录不属于源码架构：

- `node_modules`：Workspace 依赖。
- `dist`：TypeScript 或 Vite 构建产物。
- `.devloop-data`：本地开发数据库、仓库、Worktree 和 Skill。
- `data`：Docker 部署的宿主持久化目录。
- `config`：Docker 部署的 Codex 和 Git SSH 配置。

这些目录都不应提交到 Git。

## 5. 运行依赖方向

```text
desktop ───────────────> DevLoop Server URL

web ──────────────────> shared
  │ HTTP / SSE
  v
server ────────────────> db
  ├────────────────────> git
  ├────────────────────> runners
  ├────────────────────> shared
  └────────────────────> workflow

db / git / runners / workflow ──> shared
```

Web 不依赖 Server 源码，Desktop 不依赖数据库实现。这个边界保证同一页面可以连接本机实例或个人服务器实例。

## 6. 数据目录

### 本地开发

```text
.devloop-data/
├── devloop.db
├── repositories/
├── worktrees/
└── skills/
```

### Docker

```text
data/
├── devloop.db
├── repositories/
├── worktrees/
└── skills/
```

日志当前主要通过 Pino 输出到标准输出，由开发终端或 Docker 日志驱动保存；独立文件日志目录仍属于后续完善项。

## 7. 是否需要合并 packages

从纯代码规模看，`db`、`git`、`runners` 和 `workflow` 仍然可以并入 Server。但当前远程 Git、Docker 构建和独立测试已经形成了较明确的模块边界，立即搬迁只会产生大量路径和构建改动。

当前决定是：

- 保留 `desktop`、`web`、`server` 和 `shared` 的必要边界。
- 暂时保留现有 Server 能力包。
- 不继续拆出更细的 package。
- 等出现独立 Worker、CLI 或第二个真实消费者时再重新评估。

## 8. 新代码放在哪里

- 页面、组件、样式：`apps/web/src`。
- Electron 窗口和系统能力：`apps/desktop/src`。
- API、Worker、Skill 文件管理：`apps/server/src`。
- SQLite 和事务：`packages/db/src`。
- Git 命令：`packages/git/src`。
- Codex 或新 Runner：`packages/runners/src`。
- 前后端共享类型与输入校验：`packages/shared/src`。
- 状态机：`packages/workflow/src`。
- 部署模板：`deploy` 或仓库根目录。

不要让 Web 页面直接导入数据库、Git 或 Runner 包。
