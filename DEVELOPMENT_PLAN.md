# DevLoop 浏览器端开发方案

## 1. 文档状态

- 产品名称：DevLoop
- 项目目录：~/Desktop/devloop
- 当前阶段：架构确认与 MVP 设计
- 产品形态：浏览器控制台 + 本机后台服务
- 首批平台：macOS，本地单用户
- 核心执行器：Codex CLI
- 后续执行器：Claude Code、其他兼容 CLI

## 2. 产品定义

DevLoop 是一个面向开发者的无人值守开发任务循环系统。

用户负责：

1. 创建任务并补全必要约束。
2. 确认任务可以进入执行队列。
3. 在执行完成后审核结果。

系统负责：

1. 从待执行队列原子领取任务。
2. 创建隔离的 Git 工作树。
3. 调用编程智能体修改代码。
4. 独立运行测试、lint、类型检查和构建。
5. 在预算范围内自动修复失败。
6. 生成 Diff、日志、测试和风险说明。
7. 将任务送入人工审核。
8. 当前任务失败或阻塞后继续处理下一条任务。

DevLoop 作为独立的本地 Web 产品运行，不依赖其他客户端承载界面。

## 3. 核心原则

### 3.1 用户只确认输入和输出

任务一旦确认，不再在执行中向用户弹出普通工程问题。

执行阶段遇到无法解决的权限、环境或需求问题时：

- 终止当前任务的本轮执行。
- 生成结构化阻塞结果。
- 保留工作树、日志和已产生的 Diff。
- 自动释放 Worker 并领取下一条任务。
- 用户之后修改任务输入并重新提交。

### 3.2 Agent 不管理队列

Scheduler、状态机、重试和测试由确定性程序控制。Agent 每次只能接收一个已经确认的任务，不能自行领取下一条任务，也不能自行修改任务状态。

### 3.3 不信任自然语言完成声明

任务是否进入审核，由 Workflow Engine 根据以下证据判断：

- Agent 结构化输出符合 Schema。
- Git 工作树存在可解释的修改。
- 必需验证命令已由控制器独立执行。
- 没有触发安全策略和阻断条件。

### 3.4 过程无人监听，结果完整可审计

用户不需要实时观察，但系统必须保存：

- 输入任务快照。
- 基础提交和执行分支。
- Agent JSONL 事件。
- 执行过的命令及退出码。
- 文件修改和 Git Diff。
- 测试结果。
- 重试原因。
- 最终结果和未解决风险。

## 4. 用户流程

~~~text
创建草稿
  -> 系统检查缺失字段
  -> 用户确认输入
  -> 进入待执行队列
  -> Scheduler 领取
  -> 创建 Worktree
  -> Agent 开发
  -> 独立验证
  -> 有限次数修复
  -> 生成结果包
  -> 人工审核
  -> 通过 / 驳回 / 人工接管
~~~

任务阻塞分支：

~~~text
执行中
  -> 无法获取预授权能力
  -> 生成阻塞结果
  -> 进入阻塞状态
  -> Worker 继续下一条任务
  -> 用户补充信息后重新排队
~~~

## 5. 输入确认协议

任务进入 READY 前必须具备：

- 任务标题和明确目标。
- 可验证的验收标准。
- 项目目录。
- 基础分支。
- 允许修改的目录。
- 禁止修改的目录。
- 测试、lint、类型检查和构建命令。
- 是否允许安装依赖。
- 是否允许访问网络。
- 最大运行时间。
- 最大自动修复次数。
- 执行器选择。
- 是否允许创建 Commit。
- 是否允许创建或更新 Pull Request。

确认时生成不可变的 Task Revision，至少记录：

~~~text
task_id
revision
task_spec_hash
project_id
base_branch
base_commit
policy_snapshot
confirmed_at
~~~

运行中的任务始终绑定确认时的 Revision。用户后续修改任务不会改变正在执行的 Run。

## 6. 输出审核协议

每次执行结束后生成 Review Package：

- 实现摘要。
- 验收标准逐项结果。
- 修改文件列表。
- 完整 Git Diff。
- 验证命令、退出码和输出摘要。
- Agent 执行次数和总耗时。
- 阻塞原因或失败原因。
- 风险、已知限制和建议人工检查项。
- Worktree、分支、Commit 或 Pull Request 信息。
- 完整日志下载入口。

审核动作：

- 通过：任务进入 COMPLETED。
- 驳回：创建新的 Task Revision，回到 READY。
- 人工接管：保留 Worktree 并停止自动化。
- 取消：终止后续处理并保留审计记录。

MVP 不自动合并主分支，不自动部署。

## 7. 状态模型

### 7.1 任务状态

~~~text
DRAFT
READY
RUNNING
REVIEW
BLOCKED
FAILED
COMPLETED
CANCELLED
~~~

### 7.2 执行状态

~~~text
CLAIMED
PREPARING
AGENT_RUNNING
VERIFYING
REPAIRING
PREPARING_REVIEW
SUCCEEDED
BLOCKED
FAILED
INTERRUPTED
CANCELLED
~~~

### 7.3 合法转换

~~~text
DRAFT -> READY
READY -> RUNNING
RUNNING -> REVIEW
RUNNING -> BLOCKED
RUNNING -> FAILED
REVIEW -> COMPLETED
REVIEW -> READY
任意非终态 -> CANCELLED
~~~

状态转换必须由服务端事务完成，前端不能直接写状态字段。

## 8. 系统架构

~~~text
Browser
  |
  | REST + SSE
  v
DevLoop Local Service
  ├── HTTP API
  ├── Static Web Server
  ├── Task Service
  ├── Workflow Engine
  ├── Scheduler
  ├── Worker
  ├── Notification Adapter
  ├── SQLite Repository
  ├── Git Worktree Service
  └── Agent Runner Registry
       ├── CodexRunner
       └── ClaudeRunner
~~~

生产运行时，Server 同时提供 API 和已经构建的前端静态资源。浏览器只连接 127.0.0.1，不直接访问项目文件或启动命令。

### 8.1 能力边界

| 能力 | 是否可实现 | 实现位置 |
| --- | --- | --- |
| 动态分栏任务看板 | 可以 | 浏览器前端 |
| 节点配置和流程版本 | 可以 | 前端、Workflow Engine 和数据库 |
| 自动逐个领取任务 | 可以 | 本地 Scheduler |
| 开发完成自动进入审核 | 可以 | Workflow Engine |
| 任务持久化 | 可以 | SQLite |
| 操作本机代码目录 | 可以 | 本地服务，浏览器不能直接操作 |
| 使用 Codex 开发 | 可以 | CodexRunner 启动 codex exec |
| 接入 Claude Code | 可以 | 后续增加 ClaudeRunner |
| 实时日志和命令输出 | 可以 | JSONL、事件表和 SSE |
| Git Diff 和测试结果 | 可以 | Git Service 和 Verification Service |
| 审核、驳回和重试 | 可以 | Task Center 和 Workflow Engine |
| 一个任务阻塞后执行下一个 | 可以 | 租约和队列调度 |
| 浏览器关闭后继续任务 | 可以 | 本地服务必须常驻 |
| Codex 客户端关闭后继续任务 | 可以 | Worker 独立运行 |
| 电脑关机后继续任务 | 不可以 | 后续需要云端 Worker |

MVP 中的执行阶段不等待用户临时确认。未被输入策略预授权的能力会形成 BLOCKED 结果，Worker 随后继续下一条任务。

## 9. 核心模块

### 9.1 Web

- 项目管理。
- 动态任务看板。
- 任务创建和输入确认。
- 任务详情。
- 运行历史。
- 结果审核。
- Diff、测试和日志查看。
- Loop 开关和 Worker 状态。
- 设置和项目安全策略。

### 9.2 API Server

- 输入校验和鉴权。
- 任务、项目和审核 API。
- SSE 事件流。
- 静态资源服务。
- 本地会话管理。

### 9.3 Workflow Engine

- 校验合法状态转换。
- 创建不可变 Task Revision。
- 编排准备、执行、验证、修复和审核节点。
- 持久化节点状态。
- 根据恢复规则重启中断任务。

### 9.4 Scheduler

- 单 Worker 并发。
- 通过 SQLite 事务领取最早的 READY 任务。
- 使用 lease_owner、lease_until 和 heartbeat 防止重复领取。
- BLOCKED 和 FAILED 任务不占用 Worker。
- 没有任务时使用事件唤醒或低频退避，不做高频轮询。

### 9.5 Git Service

- 校验项目是否为 Git 仓库。
- 记录 base commit。
- 为每个 Run 创建独立 Worktree 和分支。
- 获取状态、Diff 和修改文件。
- 可选创建 Commit。
- 审核前不修改用户当前工作目录。
- 定期清理已经完成且不再需要的 Worktree。

### 9.6 Agent Runner

统一接口：

~~~text
prepare
start
streamEvents
cancel
collectResult
detectCapabilities
~~~

Runner 输入：

- Task Revision。
- Worktree 路径。
- 项目策略。
- 输出 Schema。
- 超时和取消信号。

Runner 输出：

- 结构化状态。
- 摘要和阻塞信息。
- JSONL 事件。
- 进程退出码。

### 9.7 Verification Service

- 只执行用户确认过的命令。
- 为每条命令设置超时。
- 捕获 stdout、stderr 和退出码。
- 在 Agent 完成后独立运行。
- 将失败结果反馈给下一次修复尝试。
- 达到最大次数后停止，不形成无限循环。

## 10. 数据模型

MVP 表：

~~~text
projects
project_policies
tasks
task_revisions
task_runs
run_steps
run_events
artifacts
worker_leases
review_decisions
~~~

关键关系：

- 一个 Project 有多个 Task。
- 一个 Task 有多个不可变 Revision。
- 一个 Revision 可以有多个 Run。
- 一个 Run 有多个 Step、Event 和 Artifact。
- 审核决定始终关联具体 Run。

重要字段：

~~~text
tasks:
  id
  project_id
  title
  status
  priority
  active_revision_id

task_runs:
  id
  task_revision_id
  runner
  status
  worktree_path
  branch_name
  base_commit
  lease_owner
  lease_until
  started_at
  finished_at

run_events:
  id
  run_id
  sequence
  type
  payload_json
  created_at
~~~

## 11. API 设计

首批 REST API：

~~~text
GET    /api/health
GET    /api/projects
POST   /api/projects
PATCH  /api/projects/:id

GET    /api/tasks
POST   /api/tasks
GET    /api/tasks/:id
PATCH  /api/tasks/:id
POST   /api/tasks/:id/confirm
POST   /api/tasks/:id/cancel
POST   /api/tasks/:id/retry

GET    /api/runs/:id
GET    /api/runs/:id/events
GET    /api/runs/:id/diff
GET    /api/runs/:id/artifacts
POST   /api/runs/:id/approve
POST   /api/runs/:id/reject
POST   /api/runs/:id/take-over

GET    /api/worker
POST   /api/worker/start
POST   /api/worker/pause
~~~

实时事件使用：

~~~text
GET /api/events
Content-Type: text/event-stream
~~~

## 12. 本地目录

源码：

~~~text
~/Desktop/devloop
~~~

运行数据默认放在：

~~~text
~/Library/Application Support/DevLoop/
├── devloop.db
├── logs/
├── artifacts/
├── worktrees/
└── runtime.json
~~~

源码仓库不保存用户任务数据库、Agent 日志和 Worktree。

## 13. 安全模型

- Server 仅监听 127.0.0.1。
- 首次启动生成随机本地访问令牌。
- 校验 Origin 和 Host。
- 项目必须由用户显式注册。
- 允许写入的路径必须属于注册项目或对应 Worktree。
- Runner 默认使用 workspace-write 沙箱。
- 不使用绕过审批和沙箱的危险参数。
- 网络、依赖安装、Commit 和 PR 权限按项目保存。
- 禁止自动部署、自动合并和生产数据操作。
- 命令只来自确认过的项目策略，不接受 Agent 动态生成任意命令。
- 日志写入前清理常见密钥和令牌格式。

## 14. 可靠性设计

- SQLite 开启 WAL。
- 每次状态转换和事件写入使用事务。
- Worker 使用租约和 heartbeat。
- Run 每个阶段必须可重入或有明确恢复策略。
- Agent 和命令进程支持超时、取消和进程树终止。
- 服务重启后扫描过期租约。
- 中断的 Run 标记为 INTERRUPTED，再根据阶段恢复或生成人工结果。
- 对每个任务限制总时长、Agent 次数和修复次数。
- Worktree 创建、Commit 和清理操作记录审计事件。

## 15. 前端页面

~~~text
/board
/projects
/projects/:id
/tasks/:id
/runs
/runs/:id
/settings
~~~

看板默认分栏：

~~~text
草稿 | 待执行 | 执行中 | 待审核 | 已完成 | 阻塞
~~~

执行中列只展示摘要状态，不要求用户持续监控。用户主要操作集中在草稿、待执行和待审核。

## 16. 代码目录规划

~~~text
devloop/
├── apps/
│   ├── web/
│   │   └── src/
│   └── server/
│       └── src/
├── packages/
│   ├── db/
│   ├── git/
│   ├── runners/
│   ├── shared/
│   └── workflow/
├── schemas/
│   └── agent-result.schema.json
├── scripts/
├── package.json
├── pnpm-workspace.yaml
├── DEVELOPMENT_PLAN.md
└── TECH_SELECTION.md
~~~

## 17. 分阶段开发

### Phase 0：项目骨架

- pnpm Monorepo。
- Web、Server 和共享包。
- 开发环境并行启动。
- Server 提供健康检查和静态页面。
- SQLite 迁移框架。
- 基础测试和代码质量命令。

通过条件：一条命令启动 Web 和 Server，刷新页面后服务状态正常。

### Phase 1：任务和项目

- 注册本地 Git 项目。
- 项目策略。
- 任务 CRUD。
- 输入完整性校验。
- Task Revision。
- 持久化看板。

通过条件：重启服务和浏览器后任务、项目和状态保持不变。

### Phase 2：固定 Workflow 与模拟 Runner

- 状态机。
- Scheduler 和单 Worker。
- 租约与 heartbeat。
- FakeRunner。
- 验证命令模拟。
- Review Package。

通过条件：测试任务可以无人值守从 READY 到 REVIEW，失败任务不阻塞后续任务。

### Phase 3：Codex Runner

- Git Worktree。
- Codex CLI 能力检测。
- JSONL 事件解析。
- 结构化输出 Schema。
- 超时和取消。
- 独立验证和自动修复。

通过条件：在测试仓库中完成真实代码修改、测试并生成审核结果。

### Phase 4：审核和可靠性

- Diff 和 Artifact 页面。
- 通过、驳回和人工接管。
- 服务重启恢复。
- 进程异常恢复。
- Worktree 清理。
- 系统通知。

通过条件：浏览器关闭、服务重启和 Agent 异常退出后，任务状态仍然一致且可解释。

### Phase 5：可配置工作流

- Workflow Definition 和版本。
- 阶段节点、执行节点和条件边。
- 节点编辑器。
- ClaudeRunner。
- GitHub Issue 和 Pull Request 集成。

## 18. MVP 非目标

- 多用户协作。
- 云端 Worker。
- 多 Worker 并发。
- 自动合并主分支。
- 自动部署。
- 生产数据库操作。
- 任意脚本节点。
- 无限制修复循环。
- 非 Git 项目。

## 19. MVP 完成标准

MVP 必须完整跑通：

1. 用户注册一个本地 Git 项目。
2. 创建任务并确认输入。
3. Worker 自动领取任务。
4. 创建独立 Worktree。
5. Codex 修改代码。
6. 控制器运行验证命令。
7. 失败时在限制内自动修复。
8. 生成 Diff、测试和结果报告。
9. 任务进入待审核。
10. 用户通过或驳回。
11. 一个任务阻塞后，下一条 READY 任务仍可执行。
12. 浏览器关闭后 Worker 继续运行。
13. 服务重启后状态和历史可以恢复。

## 20. 已确定决策

- Web 是主入口。
- 本机服务是执行主体。
- SQLite 是本地事实来源。
- 单 Worker 是 MVP 默认值。
- Git Worktree 是任务隔离方式。
- Codex CLI 是第一执行器。
- 用户只确认输入和输出。
- 中途问题转换为阻塞结果，不弹交互确认。
