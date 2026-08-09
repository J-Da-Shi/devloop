# DevLoop 技术选型方案

## 1. 选型目标

技术方案需要优先满足：

- 本地单用户部署简单。
- 浏览器关闭后 Worker 仍能运行。
- 能安全访问本机 Git 项目并启动 CLI。
- 任务和运行状态可以崩溃恢复。
- Agent Runner 可以替换。
- 实时日志不引入额外基础设施。
- 前后端共享类型和校验规则。
- MVP 不依赖 Redis、PostgreSQL、Docker、Electron 或云服务。

## 2. 最终选型

| 层级 | 选择 |
| --- | --- |
| 仓库 | pnpm Workspace Monorepo |
| 语言 | TypeScript 严格模式 |
| Node.js | Node.js 24 LTS，使用版本文件固定 |
| Web | React + Vite |
| 路由 | TanStack Router |
| 服务端状态 | TanStack Query |
| 表单 | React Hook Form + Zod |
| UI 基础组件 | Radix UI |
| 样式 | Tailwind CSS |
| 图标 | Lucide React |
| 看板拖拽 | dnd-kit |
| 节点编辑器 | XYFlow，Phase 5 引入 |
| API Server | Fastify |
| API 校验 | Zod + Fastify Zod Type Provider |
| 实时通信 | Server-Sent Events |
| 数据库 | SQLite WAL |
| ORM | Drizzle ORM |
| SQLite Driver | better-sqlite3 |
| 状态机 | XState v5 |
| 调度队列 | SQLite 事务、租约和 heartbeat |
| 子进程 | execa + AbortController |
| Git | 系统 Git CLI |
| 日志 | Pino JSON 日志 |
| 单元和集成测试 | Vitest |
| 浏览器端到端测试 | Playwright |
| 本地后台服务 | macOS launchd |

## 3. 仓库与语言

### 3.1 TypeScript

前端、后端、Workflow、数据库和 Runner 统一使用 TypeScript。

原因：

- 前后端共享 Task、Run、Event 和 Policy 类型。
- Agent 结构化输出可以统一校验。
- Node 子进程和文件系统生态成熟。
- 当前产品瓶颈在业务可靠性，不需要先引入 Rust 或 Go 增加开发成本。

要求：

- 开启 strict。
- 禁止隐式 any。
- 领域对象不直接复用数据库 Row。
- 所有外部输入经过 Zod 校验。
- 错误使用明确的错误类型和错误码。

### 3.2 pnpm Workspace

选择 Monorepo：

~~~text
apps/web
apps/server
packages/shared
packages/db
packages/workflow
packages/git
packages/runners
~~~

原因：

- 一次安装和统一锁文件。
- 共享类型不需要发布私有包。
- 可以对包边界做独立测试。
- 后续 CLI 和 GitHub 集成可以继续加入同一仓库。

## 4. 前端选型

### 4.1 React + Vite

不选择 Next.js。

原因：

- DevLoop 是本地单页应用，不需要 SEO 和服务端渲染。
- 生产环境由本地 Fastify Server 提供静态资源。
- Vite 启动和构建简单，适合本地控制台。
- 前端与 Worker 生命周期不应耦合。

### 4.2 TanStack Router

用于：

- 类型安全路由。
- 任务、运行和项目详情参数。
- 页面级数据预加载。
- 后续保持路由可测试。

计划路由：

~~~text
/board
/projects
/projects/:projectId
/tasks/:taskId
/runs
/runs/:runId
/settings
~~~

### 4.3 TanStack Query

服务端数据全部通过 Query 管理：

- 项目和任务。
- Worker 状态。
- Run 和 Review Package。
- API 缓存失效。
- 网络错误重试。

SSE 收到事件后只更新必要缓存或触发精确失效，不维护第二套前端业务状态。

### 4.4 Zustand

只用于非持久业务状态：

- 看板筛选条件。
- 当前展开面板。
- 日志自动滚动开关。
- 本地界面偏好。

任务状态和运行状态不能只保存在 Zustand。

### 4.5 Radix UI + Tailwind CSS

Radix 提供无障碍交互原语，Tailwind 负责布局和视觉样式。

首批组件：

- Dialog。
- Dropdown Menu。
- Tabs。
- Tooltip。
- Select。
- Checkbox。
- Switch。
- Scroll Area。
- Alert Dialog。

界面采用适合开发工具的紧凑信息密度，不使用营销型大卡片、超大标题和装饰性渐变。

### 4.6 dnd-kit 与 XYFlow

- MVP 使用 dnd-kit 支持合法的任务操作。
- 不允许拖拽绕过状态机。
- 可配置工作流稳定后再引入 XYFlow。
- XYFlow 只负责编辑视图，服务端负责验证和发布 Workflow Version。

## 5. 后端选型

### 5.1 Fastify

选择 Fastify，不选择 Next.js API Route、Express 或完整企业框架。

原因：

- 扩展机制和生命周期明确。
- Pino 日志原生集成。
- JSON Schema 和类型提供器生态成熟。
- 适合长连接 SSE。
- 性能充足且结构比 Express 更可控。
- 比 NestJS 更轻，适合本地单进程服务。

服务端模块：

~~~text
http
projects
tasks
runs
reviews
events
worker
notifications
runtime
~~~

生产模式下 Fastify 同时服务：

- /api 下的 REST API。
- /api/events 的 SSE。
- Vite 构建产物。
- SPA fallback。

### 5.2 REST + SSE

选择 REST 处理命令和查询，SSE 处理服务器到浏览器的实时事件。

不先使用 WebSocket，原因：

- 主要实时数据是服务端单向推送。
- 浏览器自动重连支持更简单。
- 调试和代理行为更清晰。
- 不需要为普通 CRUD 建立双向消息协议。

事件包含：

~~~text
task.created
task.updated
task.status_changed
run.started
run.step_changed
run.event
run.finished
worker.status_changed
review.created
~~~

客户端通过 lastEventId 补齐短暂断线期间的事件。

## 6. 数据库选型

### 6.1 SQLite

选择 SQLite，MVP 不使用 PostgreSQL。

原因：

- 单用户本地产品不需要数据库服务。
- 安装、备份和迁移简单。
- 事务足够支持单 Worker Scheduler。
- WAL 模式允许前端查询和 Worker 写入并行。
- 数据库可以随本机服务启动。

运行设置：

~~~text
journal_mode = WAL
foreign_keys = ON
busy_timeout = 5000
synchronous = NORMAL
~~~

### 6.2 Drizzle ORM

用于：

- 类型安全 Schema。
- SQL 迁移。
- 常规查询。
- 事务。

原子任务领取、租约续期等关键路径允许使用明确的 SQL，不强制通过高层 ORM 抽象。

### 6.3 better-sqlite3

选择同步 Driver。

原因：

- 本地单进程服务模型简单。
- 事务边界清晰。
- 性能和可靠性成熟。
- 避免异步 Driver 带来的额外状态复杂度。

数据库操作通过 Repository 层封装，避免同步调用散落在 HTTP Handler 中。

## 7. Workflow 和 Scheduler

### 7.1 XState

XState 负责：

- 状态图。
- 合法转换。
- Guard。
- 终态判断。
- 可视化和测试状态路径。

SQLite 仍然是事实来源。每次转换必须在数据库事务内：

1. 校验当前持久化状态。
2. 计算下一状态。
3. 更新 Task 或 Run。
4. 写入 Event。
5. 提交事务。

不直接依赖内存中的 XState Snapshot 恢复业务事实。

### 7.2 SQLite Scheduler

MVP 不引入 BullMQ 和 Redis。

任务领取：

~~~text
BEGIN IMMEDIATE
SELECT 最早且优先级最高的 READY 任务
UPDATE task SET status = RUNNING
INSERT task_run
写入 lease_owner 和 lease_until
COMMIT
~~~

Worker 定期更新 heartbeat。租约过期后由恢复任务检查 Agent 进程和 Worktree，再决定恢复、失败或转人工接管。

## 8. Agent Runner

### 8.1 统一接口

~~~typescript
interface AgentRunner {
  detectCapabilities(): Promise<RunnerCapabilities>;
  start(input: RunnerInput): Promise<RunnerHandle>;
  cancel(handle: RunnerHandle): Promise<void>;
}
~~~

RunnerHandle 提供：

- 事件流。
- 退出 Promise。
- 进程标识。
- 取消能力。

### 8.2 CodexRunner

通过本机 codex exec 启动。

使用能力：

- 指定 Worktree 作为工作目录。
- workspace-write 沙箱。
- JSONL 标准输出。
- JSON Schema 约束最终结果。
- 超时和取消。
- 可选 ephemeral 会话。

不得使用绕过审批和沙箱的危险参数。未预授权操作应该失败并转成 BLOCKED 结果，而不是在后台等待交互输入。

推荐命令能力组合：

~~~text
codex exec
  --json
  --output-schema <agent-result.schema.json>
  --sandbox workspace-write
  --cd <worktree>
~~~

启动前必须执行能力检测，不能假设不同版本 CLI 参数完全一致。

### 8.3 ClaudeRunner

Phase 5 增加。通过适配器将 Claude Code 的事件和结果映射为统一 RunEvent 和 AgentResult。

Workflow Engine 不依赖任何执行器专有事件。

### 8.4 子进程库

选择 execa：

- stdout 和 stderr 流。
- AbortSignal。
- 环境变量控制。
- 退出码和错误对象一致。

需要额外实现：

- POSIX 进程组。
- 超时后终止整个进程树。
- 服务退出时清理子进程。
- 输出大小限制和日志落盘。

## 9. Git 选型

直接调用系统 Git CLI，不使用纯 JavaScript Git 实现。

原因：

- Worktree 行为与开发者本机 Git 一致。
- 支持用户现有凭据、配置和 hooks。
- 错误输出更容易排查。
- 不需要重新实现复杂 Git 语义。

Git Service 只开放明确操作：

~~~text
rev-parse
status
diff
branch
worktree add
worktree remove
add
commit
~~~

MVP 不开放任意 Git 命令给 Agent。

## 10. 校验与 Schema

Zod 用于：

- HTTP 输入。
- 配置文件。
- 项目策略。
- 数据库 Repository 边界。
- SSE 事件 Payload。

Agent 最终输出使用版本化 JSON Schema：

~~~text
schemas/agent-result.v1.schema.json
~~~

服务端必须再次校验 AgentResult。即使 Schema 通过，也要独立检查 Git Diff 和验证命令。

## 11. 日志和 Artifact

### 11.1 Pino

服务日志使用结构化 JSON：

~~~text
timestamp
level
service
task_id
run_id
step
event
message
error
~~~

### 11.2 Artifact

大内容不直接写入 run_events：

- Agent JSONL。
- 命令完整日志。
- Git Diff。
- Review Report。
- 测试报告。

数据库只保存 Artifact 元数据、文件路径、大小和校验值。

日志写入前执行常见密钥脱敏。

## 12. 测试方案

### 12.1 Vitest

- 状态机路径测试。
- Scheduler 原子领取测试。
- Repository 和迁移测试。
- Policy 校验测试。
- FakeRunner 测试。
- Codex JSONL Parser 测试。
- Git Service 集成测试。

每个数据库测试使用独立临时 SQLite 文件。

### 12.2 Playwright

覆盖：

- 创建项目。
- 创建和确认任务。
- 看板状态变化。
- FakeRunner 从 READY 到 REVIEW。
- 查看 Diff 和测试结果。
- 审核通过和驳回。
- SSE 断线重连。

真实 CodexRunner 测试作为显式运行的本地集成测试，不进入普通单元测试。

## 13. 本地运行和打包

### 13.1 开发模式

~~~bash
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm e2e
~~~

开发模式：

- Vite 提供前端热更新。
- Fastify 提供 API。
- 前端代理 /api 到本地 Server。

### 13.2 生产模式

~~~text
devloop start
  -> 启动 Fastify
  -> 启动 Scheduler 和 Worker
  -> 服务 Web 静态资源
  -> 打开或提示本地 URL
~~~

### 13.3 后台常驻

macOS 使用 launchd：

~~~text
devloop service install
devloop service start
devloop service stop
devloop service status
~~~

launchd 只负责 Server 进程存活。Worker 的暂停和任务恢复仍由数据库状态控制。

## 14. 通知

通知分两层：

- 浏览器打开时使用 Web Notification 和页面未读状态。
- 浏览器关闭时由本地服务调用 macOS 系统通知。

首批通知：

- 任务进入 REVIEW。
- 任务 BLOCKED。
- 任务 FAILED。
- Worker 异常停止。

点击系统通知打开：

~~~text
http://127.0.0.1:<port>/tasks/<taskId>
~~~

## 15. 本地安全

- 监听地址固定为 127.0.0.1。
- 首次启动生成随机访问令牌。
- 浏览器使用 HttpOnly、SameSite=Strict Cookie。
- 所有写操作校验 Origin。
- 不允许通过 API 提交任意 shell 命令。
- 项目目录使用 realpath 后与授权根目录比较。
- Worktree 必须位于 DevLoop 数据目录。
- Runner 环境变量使用白名单继承。
- 敏感环境变量默认不传给 Agent。
- 危险策略需要在项目设置中显式开启并二次确认。

## 16. 不选择的方案

### Next.js

不需要 SSR、Edge Runtime 和服务端组件。它会增加本地进程与 Worker 的边界复杂度。

### Electron 或 Tauri

当前决定使用浏览器主界面，不需要额外桌面外壳。本机文件和 CLI 能力已经由 Server 提供。

### PostgreSQL、Redis 和 BullMQ

单用户、单 Worker MVP 不需要额外服务。SQLite 事务和租约足够。

### Temporal

可靠性能力强，但本地部署和学习成本超过 MVP 需求。只有在远程 Worker、多用户和长周期工作流出现后再评估。

### Docker 作为默认运行方式

容器会增加本机项目挂载、Git 凭据、Codex 登录和系统通知复杂度。可以作为 CI 测试环境，但不是默认产品运行方式。

### 浏览器 File System Access API

它不能可靠启动 Codex、Git 和测试命令，也不能承担后台 Worker，因此不作为核心文件访问方式。

## 17. 依赖边界

~~~text
apps/web
  -> packages/shared

apps/server
  -> packages/shared
  -> packages/db
  -> packages/workflow
  -> packages/git
  -> packages/runners

packages/workflow
  -> packages/shared
  -> packages/db

packages/runners
  -> packages/shared

packages/git
  -> packages/shared
~~~

packages/db、packages/git 和 packages/runners 不能被前端导入。

## 18. 选型结论

第一版固定组合：

~~~text
React + Vite
Fastify
SQLite + Drizzle
XState
SSE
Git Worktree
Codex CLI JSONL
Vitest + Playwright
launchd
~~~

该组合满足浏览器控制、本机执行、无人值守运行、崩溃恢复和结果审核，同时保持本地安装成本可控。
