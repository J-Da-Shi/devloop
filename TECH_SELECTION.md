# DevLoop 技术选型方案

## 1. 选型目标

技术方案需要优先满足：

- 本地单用户部署简单。
- Electron 窗口和手机页面关闭后 Worker 仍能运行。
- 能安全访问本机 Git 项目并启动 CLI。
- 任务和运行状态可以崩溃恢复。
- Agent Runner 可以替换。
- 实时日志不引入额外基础设施。
- 前后端共享类型和校验规则。
- 手机可以通过私有网络查看状态并提交受控操作。
- 核心本机执行不依赖 Redis、PostgreSQL、Docker 或自建云服务。
- 手机外网访问可以选择依赖 Tailscale，但不影响本机任务执行。

## 2. 最终选型

| 层级 | 选择 |
| --- | --- |
| 仓库 | pnpm Workspace Monorepo |
| 语言 | TypeScript 严格模式 |
| Node.js | Node.js 24 LTS，使用版本文件固定 |
| 桌面客户端 | Electron |
| Electron 安全 | contextIsolation + sandbox，关闭 nodeIntegration |
| Electron 打包 | Electron Forge，签名与 notarization |
| Web | React + Vite |
| 手机入口 | 响应式 Web/PWA，共用 React 应用 |
| 手机私有访问 | Tailscale Serve，局域网模式可选 |
| 手机设备认证 | 一次性配对码 + HttpOnly Cookie + Device Role |
| 路由 | TanStack Router |
| 服务端状态 | TanStack Query |
| 表单 | React Hook Form + Zod |
| UI 基础组件 | Radix UI |
| 样式 | Tailwind CSS |
| 图标 | Lucide React |
| 看板拖拽 | dnd-kit |
| 节点编辑器 | XYFlow，Phase 6 引入 |
| API Server | Fastify |
| API 校验 | Zod + Fastify Zod Type Provider |
| 实时通信 | Server-Sent Events |
| 远程写命令 | REST + expected version + idempotency key |
| 数据库 | SQLite WAL |
| ORM | Drizzle ORM |
| SQLite Driver | better-sqlite3 |
| 状态机 | XState v5 |
| 调度队列 | SQLite 事务、租约和 heartbeat |
| 子进程 | execa + AbortController |
| Git | 系统 Git CLI |
| 日志 | Pino JSON 日志 |
| 单元和集成测试 | Vitest |
| Electron 与 Web 端到端测试 | Playwright |
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
apps/desktop
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
- Electron、手机 Web、后续 CLI 和 GitHub 集成可以继续加入同一仓库。

## 4. 前端选型

### 4.1 Electron Desktop

Electron 是 macOS 首版的主要产品入口，负责：

- 承载 React Task Center。
- 原生项目目录选择、系统通知和菜单栏入口。
- 检测 Git、Codex、Tailscale 和本机权限。
- 安装、启动、停止和诊断独立 DevLoop Service。
- 生成手机配对二维码并管理已授权设备。

Electron 不承载任务事实和 Worker 生命周期。关闭窗口后，用户级 launchd Service 继续运行。

BrowserWindow 必须使用：

~~~text
contextIsolation = true
nodeIntegration = false
sandbox = true
~~~

Preload 只暴露类型化、可枚举的原生操作，不提供通用 IPC、文件读取或命令执行接口。Renderer 的任务操作仍调用 Fastify API。

### 4.2 React + Vite

不选择 Next.js。

原因：

- DevLoop 是桌面和手机共用的本地单页应用，不需要 SEO 和服务端渲染。
- 生产环境由本地 Fastify Server 提供静态资源。
- Vite 启动和构建简单，适合本地控制台。
- 前端与 Worker 生命周期不应耦合。

Electron 在开发模式加载 Vite URL，在生产模式加载 DevLoop Service 提供的 loopback URL。浏览器备用入口和手机入口使用同一套构建产物。

### 4.3 Mobile Web/PWA

手机不开发原生 App，使用响应式 Web/PWA：

- `/status` 作为手机默认入口。
- 展示 Mac 在线状态、Worker、当前任务、阶段、耗时、日志摘要和待审核结果。
- 支持 DRAFT 编辑、BLOCKED/FAILED 补充、新 Revision、暂停、取消、通过和驳回。
- 不提供本地路径、安全能力授权、Codex 登录和 Worktree 源码编辑。
- PWA Service Worker 只缓存静态应用壳，不缓存 API、日志、Diff、凭据或其他敏感 Artifact。
- 离线时只展示明确标记的最后快照，不离线排队高风险写命令。

手机布局从 375px 视口开始设计。表格在窄屏转换为列表或局部滚动，按钮满足触控尺寸，危险操作需要确认，异步状态提供清晰反馈。

### 4.4 TanStack Router

用于：

- 类型安全路由。
- 任务、运行和项目详情参数。
- 页面级数据预加载。
- 后续保持路由可测试。

计划路由：

~~~text
/status
/board
/projects
/projects/:projectId
/tasks/:taskId
/runs
/runs/:runId
/devices
/pair
/settings
~~~

### 4.5 TanStack Query

服务端数据全部通过 Query 管理：

- 项目和任务。
- Worker 状态。
- Run 和 Review Package。
- API 缓存失效。
- 网络错误重试。
- 配对设备和移动端在线状态。

SSE 收到事件后只更新必要缓存或触发精确失效，不维护第二套前端业务状态。

查询可以按策略重试，写操作不能因移动网络抖动自动重复执行。Mutation 必须携带幂等键和预期版本，冲突后重新加载服务端状态。

### 4.6 Zustand

只用于非持久业务状态：

- 看板筛选条件。
- 当前展开面板。
- 日志自动滚动开关。
- 本地界面偏好。

任务状态和运行状态不能只保存在 Zustand。

### 4.7 Radix UI + Tailwind CSS

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

桌面与手机共享语义组件，但允许不同布局。实时状态使用文本、图标和颜色共同表达；图标按钮提供可访问名称，动态状态使用 `aria-live`，手机不得出现页面级横向滚动。

### 4.8 dnd-kit 与 XYFlow

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
devices
remote
audit
worker
notifications
runtime
~~~

生产模式下 Fastify 同时服务：

- /api 下的 REST API。
- /api/events 的 SSE。
- Vite 构建产物。
- SPA fallback。
- Electron 与手机设备的会话和配对接口。

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
device.paired
device.revoked
~~~

所有对外状态事件写入全局 `domain_events` 表。客户端通过 `Last-Event-ID` 补齐短暂断线期间的事件；事件已经超过保留窗口时，客户端重新获取状态快照。

### 5.3 手机私有访问

MVP 不建设云端 Relay，优先使用 Tailscale Serve：

~~~text
Mobile Browser
  -> Tailscale private HTTPS
  -> Tailscale Serve
  -> 127.0.0.1 DevLoop Service
~~~

原因：

- Service 仍然只需要监听 loopback。
- 不需要路由器端口转发、动态 DNS 或自签名证书。
- 手机与 Mac 不在同一局域网时仍可访问。
- Tailscale 故障只影响远程入口，不影响本机 Worker。

可选局域网模式默认关闭，开启时必须绑定明确接口、启用 TLS 并通过 Electron 二次确认。禁止把未鉴权 Service 直接监听在 `0.0.0.0`。

Electron 生成短时单次配对码。配对后 Service 签发独立设备会话，并保存 viewer、operator 或 editor 角色。operator 继承 viewer，editor 继承 operator；角色变更只能在 Electron 完成。手机继续使用普通 REST + SSE，不引入第二套业务协议。

## 6. 数据库选型

### 6.1 SQLite

选择 SQLite，MVP 不使用 PostgreSQL。

原因：

- 单用户本地产品不需要数据库服务。
- 安装、备份和迁移简单。
- 事务足够支持单 Worker Scheduler。
- WAL 模式允许前端查询和 Worker 写入并行。
- 数据库可以随本机服务启动。
- 手机入口仍然访问同一个本机 Service，不需要复制数据库或引入远程数据库。

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

Task Revision 一经确认不可修改。手机或桌面端对 RUNNING、BLOCKED、FAILED 或被驳回任务的修改必须创建新 Revision；当前 Run 永远引用原 Revision。

Task、Revision 和 Run 都保存 `target_branch`。Task 中的字段允许草稿编辑；确认后复制到不可变 Revision；领取后再复制到 Run，保证执行和审核始终引用同一个目标分支快照。

Revision 保存 `base_strategy`：

- `LATEST_ACCEPTED`：Worker 准备 Worktree 时读取目标分支最新 Commit；目标分支不存在时读取项目默认分支 Commit。
- `PINNED`：始终使用确认时固定的 Commit。

Scheduler 在领取事务中保存目标分支、Revision、Policy 和 Runner 配置。Worker 在创建 Worktree 前解析实际 `base_commit`，更新不可变 Run Input Snapshot 和校验值；之后目标分支继续变化也不能改变已经开始的 Run。

所有可被 SSE 消费的状态变化同时写入全局 `domain_events`。详细 Agent 事件继续写 `run_events` 或 Artifact，避免用 Run 专属表承载 Device、Task 和 Worker 事件。

### 7.2 SQLite Scheduler

MVP 不引入 BullMQ 和 Redis。

任务领取：

~~~text
BEGIN IMMEDIATE
SELECT 最早且优先级最高的 READY 任务
按 base_strategy 从 Revision 或项目 integration_commit 读取实际 base_commit
UPDATE task SET status = RUNNING
INSERT task_run 和 run_input_hash
写入 lease_owner、lease_until 和 execution_token
COMMIT
~~~

Worker 定期更新 heartbeat。所有阶段提交必须匹配 `execution_token`，避免租约过期的旧 Worker 写回结果。

服务重启后先处理旧进程组和 Worktree 锁。`AGENT_RUNNING` 不承诺无缝接管原 Codex 进程，而是标记 INTERRUPTED，在终止或确认旧进程后创建新 attempt。VERIFYING 和 PREPARING_REVIEW 等确定性阶段可以安全重跑。

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
- 提示模型返回 JSON，并由 DevLoop 在本地按 JSON Schema 校验最终结果。
- 首次格式校验失败时，使用 read-only 沙箱进行一次纯格式修复。
- 超时和取消。
- 可选独立 ephemeral attempt；恢复逻辑不依赖会话续接。

不得使用绕过审批和沙箱的危险参数。未预授权操作应该失败并转成 BLOCKED 结果，而不是在后台等待交互输入。

推荐命令能力组合：

~~~text
codex exec
  --json
  --output-last-message <agent-result.json>
  --sandbox workspace-write
  --ignore-user-config
  --strict-config
  --cd <worktree>
~~~

启动前必须执行：

- CLI 绝对路径、版本和参数能力检测。
- 非交互认证与模型可用性预检。
- Service 运行环境下的 Codex 凭据读取测试。
- 受控配置、审批策略、网络策略和环境白名单检查。

不能假设不同版本 CLI 参数和 JSONL 事件完全一致。MVP 固定支持的 CLI 版本范围，Parser 忽略未知事件并保留原始 JSONL。每个 Run 记录 CLI 版本、模型、Prompt 模板版本、Schema 版本和有效配置摘要。

自定义 Provider 可能无法正确转发 Responses API 的结构化输出参数，因此 DevLoop 不向 Codex CLI 传递 `--output-schema`。Runner 将 Schema 文本写入任务提示，读取 `--output-last-message` 结果后在本地执行严格校验。首次结果格式不合格时，只允许再启动一次 read-only、禁止工具调用的格式修复；修复后仍不合格则任务失败，并保留 Worktree 供诊断。

进程崩溃、超时或认证失败时可能没有 AgentResult，Runner 必须根据退出状态和系统证据生成失败或阻塞结果，不能进入格式修复流程。

### 8.3 ClaudeRunner

Phase 6 增加。通过适配器将 Claude Code 的事件和结果映射为统一 RunEvent 和 AgentResult。

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
merge-base --is-ancestor
merge --ff-only
apply --3way --index
update-ref
worktree add
worktree remove
add
commit
~~~

MVP 不开放任意 Git 命令给 Agent。

成功 Run 在进入 REVIEW 前由控制器执行 `add` 和 `commit`，创建 `devloop/run/<run-id>` 内部结果分支。审核通过只记录业务决策，不直接修改用户分支。

审核通过后，本机 editor 可以显式执行“写入目标分支”。Git Service 先用 `check-ref-format --branch` 校验名称，并确认本次 Run 的 base/result Commit 存在且关系有效。目标分支不存在时，以 Run 的 `base_commit` 为父链，通过带预期旧值的 `git update-ref` 原子创建分支。目标分支存在且已经前进时，在系统临时目录创建该分支 HEAD 的隔离 Worktree，通过 `git apply --3way --index` 合并本次 Run 的补丁并生成可回退 Commit，成功后再原子更新目标分支。

目标分支未检出时只更新 Git 引用，不切换或修改当前项目目录。目标分支正在当前项目目录检出时，先检查本次结果涉及的文件没有未提交或未跟踪内容，再通过 fast-forward 同步分支和目录。目标分支若被其他 Worktree 检出则停止写入，避免引用与目录状态不一致。三方应用冲突、目标分支并发变化或任一步骤失败时删除临时 Worktree，目标分支和项目目录均不产生半成品；禁止使用 `reset --hard` 和强制 checkout。

Worktree 只有在 Commit、Diff Artifact 和校验值均持久化后才允许清理。后续 `LATEST_ACCEPTED` 任务重新读取各自目标分支最新 Commit，因此不同分支的任务不会共享一条全局执行基线。

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

日志和 Artifact 在持久化前执行常见密钥脱敏，并设置单文件大小、单 Run 总量、全局磁盘配额和保留期限。手机默认只加载摘要和按需分页内容，不自动下载完整 JSONL 或大型 Diff。

SQLite WAL 数据使用 SQLite Backup API 生成一致备份，不直接复制单个数据库文件。

## 12. 测试方案

### 12.1 Vitest

- 状态机路径测试。
- Scheduler 原子领取测试。
- Repository 和迁移测试。
- Policy 校验测试。
- FakeRunner 测试。
- Codex JSONL Parser 测试。
- Git Service 集成测试。
- integration ref 初始化、fast-forward、冲突和连续任务基线测试。
- 全局事件顺序和 SSE 补偿测试。
- 设备配对、角色、撤销、版本冲突和幂等命令测试。
- execution token fencing 和中断恢复测试。

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
- Electron 启动、Preload API 边界和 Service 诊断。
- 手机 375px、768px 和桌面视口布局。
- 二维码配对、低权限拒绝、移动端修改 Task Revision。
- 手机取消、驳回和通过操作的重复提交与版本冲突。

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
- Electron 加载 Vite 页面，并通过 Preload 提供目录选择和 Service 诊断。
- Server、Web 和 Electron 由 Workspace 脚本并行启动，退出开发命令时只终止本次开发进程。

### 13.2 生产模式

~~~text
打开 DevLoop.app
  -> 检查用户级 DevLoop Service
  -> Service 未安装时进入引导安装
  -> Service 运行后加载 127.0.0.1 UI
  -> Electron 展示 Task Center 和本机预检状态
~~~

Electron 使用 Electron Forge 生成 macOS arm64 和 x64 安装产物，并进行代码签名与 notarization。首版优先分别发布两个架构包，不先制作 Universal Binary。

安装包必须携带 Service 所需的固定 Node 运行时、构建后的 Server、迁移文件和对应架构的 `better-sqlite3`，不能依赖用户全局 Node 或 pnpm。Service 资源以版本目录安装到 DevLoop 数据目录，升级成功后再原子切换当前版本。

### 13.3 后台常驻

macOS 使用用户级 LaunchAgent：

~~~text
devloop service install
devloop service start
devloop service stop
devloop service status
~~~

LaunchAgent 使用绝对路径启动打包后的 Service Runtime，显式设置最小 PATH、HOME、TMPDIR 和 DevLoop 数据目录。launchd 只负责 Server 进程存活，Worker 的暂停和任务恢复仍由数据库状态控制。

安装和启动预检必须覆盖：

- DevLoop Service 单实例锁和固定或持久化端口。
- Git、Codex 绝对路径以及 Codex 非交互登录状态。
- macOS Desktop、Documents 等项目目录的 TCC 权限。
- Codex 凭据目录在 LaunchAgent 环境中可读。
- 数据库迁移失败时保留旧版本和可恢复备份。

### 13.4 手机入口

Electron 的设备页面展示：

- Tailscale 安装与在线状态。
- 手机访问 HTTPS 地址。
- 短时二维码和配对码。
- 已配对设备、角色、最后在线时间和撤销操作。

Tailscale 不存在时，本机执行功能保持完整；用户可以只在 Electron 中使用 DevLoop。局域网直连作为显式高级设置，不作为默认安装路径。

## 14. 通知

通知分两层：

- Electron 打开时使用 Electron Notification、Dock Badge 和页面未读状态。
- Electron 窗口关闭但 Service 运行时，由受签名的本地通知适配器发送 macOS 系统通知。
- 手机页面打开时使用页面未读状态和可选 Web Notification。
- 没有 Cloud Relay 时，不承诺手机 PWA 关闭后的可靠远程 Push；Phase 6 再增加推送服务。

首批通知：

- 任务进入 REVIEW。
- 任务 BLOCKED。
- 任务 FAILED。
- Worker 异常停止。

点击系统通知打开：

~~~text
devloop://tasks/<taskId>
~~~

## 15. 本地安全

- Service 默认监听地址固定为 127.0.0.1。
- Tailscale Serve 提供私有 HTTPS 反向代理；不直接开放公网端口。
- 首次启动生成随机访问令牌。
- Electron 本地会话和手机设备会话使用不同的 HttpOnly、SameSite Cookie。
- 所有请求校验 Host，允许值只包含 loopback 和 Electron 明确登记的 Tailscale 主机名；所有写操作校验 Origin、设备角色、预期版本和幂等键。
- 配对码短时、单次有效，数据库只保存摘要；Electron 可以撤销设备。
- Electron BrowserWindow 开启 context isolation 和 sandbox，关闭 Node integration。
- Preload 不提供任意路径读取、任意 IPC 或 shell 执行能力。
- 不允许通过 API 提交任意 shell 命令。
- 项目目录使用 realpath 后与授权根目录比较。
- Worktree 必须位于 DevLoop 数据目录。
- Runner 环境变量使用白名单继承。
- 敏感环境变量默认不传给 Agent。
- Codex 控制面网络与 Agent 工具网络分开建模。
- 网络、依赖安装、Push、PR 等危险策略只能在 Electron 项目设置中显式开启并二次确认。
- 手机不能修改本地路径、Codex 登录或危险项目策略，也不能直接编辑 Worktree。
- MVP 仅支持用户信任的项目。若 Verification 命令直接以当前用户权限运行，网络和文件策略属于检查与审计，不宣称为强 OS 隔离。

## 16. 不选择的方案

### Next.js

不需要 SSR、Edge Runtime 和服务端组件。它会增加本地进程与 Worker 的边界复杂度。

### Tauri

首版选择 Electron，不选择 Tauri。当前代码统一为 TypeScript，且桌面端需要 Node 生态的进程、打包和诊断能力。Tauri 会引入 Rust、Node sidecar 和新的跨语言边界，暂时不能抵消安装包体积收益。

Electron 仍然只是桌面壳；任务执行必须留在独立 Service，不能因选择 Electron 而把 Worker 生命周期绑定到窗口。

### PostgreSQL、Redis 和 BullMQ

单用户、单 Worker MVP 不需要额外服务。SQLite 事务和租约足够。

### Temporal

可靠性能力强，但本地部署和学习成本超过 MVP 需求。只有在远程 Worker、多用户和长周期工作流出现后再评估。

### Docker 作为默认运行方式

容器会增加本机项目挂载、Git 凭据、Codex 登录和系统通知复杂度。可以作为 CI 测试环境，但不是默认产品运行方式。

### 浏览器 File System Access API

它不能可靠启动 Codex、Git 和测试命令，也不能承担后台 Worker，因此不作为核心文件访问方式。

### 原生 iOS 或 Android App

手机首版只需要查看、编辑任务和提交审核，响应式 Web/PWA 已足够。只有出现系统级 Push、离线能力或更深设备集成需求后再评估原生 App。

### 自建 Cloud Relay

MVP 使用 Tailscale 私有网络，避免提前引入账号系统、远程命令中转、端到端加密和云端运维。正式多设备产品阶段再实现只负责转发的 Cloud Relay，本机 SQLite 仍然是事实来源。

## 17. 依赖边界

~~~text
apps/desktop
  -> packages/shared

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

apps/desktop 只使用共享 IPC/API 类型和本机壳能力，不直接导入数据库、Workflow、Git 或 Runner。packages/db、packages/git 和 packages/runners 不能被 Renderer 或 Web 导入。

## 18. 选型结论

第一版固定组合：

~~~text
Electron + Electron Forge
React + Vite
Responsive Web/PWA
Fastify
SQLite + Drizzle
XState
SSE
Tailscale Serve
Git Worktree
Codex CLI JSONL
Vitest + Playwright
User LaunchAgent
~~~

该组合满足桌面主入口、手机私有访问、本机无人值守执行、持久状态恢复和结果审核。Electron 提升本机安装与权限体验，独立 Service 保证窗口关闭后继续运行，Tailscale 在不开放公网端口的情况下提供手机入口。
