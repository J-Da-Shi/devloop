# DevLoop 桌面端与移动端开发方案

## 1. 文档状态

- 产品名称：DevLoop
- 项目目录：~/Desktop/devloop
- 当前阶段：架构确认与 MVP 设计
- 产品形态：Electron 桌面客户端 + 独立本机后台服务 + 手机 Web/PWA
- 首批平台：macOS，本地单用户
- 手机入口：iOS 和 Android 浏览器，首版不开发原生 App
- 核心执行器：Codex CLI
- 后续执行器：Claude Code、其他兼容 CLI

## 2. 产品定义

DevLoop 是一个面向开发者的无人值守开发任务循环系统。

用户负责：

1. 创建任务并补全必要约束。
2. 确认任务可以进入执行队列。
3. 在执行完成后审核结果。
4. 可在手机上查看运行状态，并在设备权限范围内修改草稿、补充阻塞任务或提交审核操作。

系统负责：

1. 从待执行队列原子领取任务。
2. 创建隔离的 Git 工作树。
3. 调用编程智能体修改代码。
4. 独立运行测试、lint、类型检查和构建。
5. 在预算范围内自动修复失败。
6. 生成 Diff、日志、测试和风险说明。
7. 将任务送入人工审核。
8. 当前任务失败或阻塞后继续处理下一条任务。

Electron Desktop 是主要产品入口，负责项目目录选择、本机权限、Codex 检测、服务管理和完整任务操作。DevLoop Service 作为独立用户级后台进程运行，不依赖 Electron 窗口维持生命周期。手机通过响应式 Web/PWA 连接 DevLoop Service，只承担查看和受控操作，不直接访问本地文件或启动 CLI。

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

### 3.5 界面与执行生命周期分离

- Electron 窗口关闭不停止 Service 或当前 Run。
- 手机页面关闭或网络断开不影响本机执行。
- Electron 可以安装、启动、停止和诊断 Service，但不是任务状态的事实来源。
- Service 由用户级 launchd 保持运行，SQLite 是唯一持久化事实来源。

### 3.6 远程修改不改变正在运行的输入

- DRAFT 任务可以在手机或桌面端直接编辑。
- BLOCKED、FAILED 或被驳回的任务修改后必须创建新的 Task Revision。
- RUNNING 任务始终绑定确认时的 Revision，远程修改只保存为下一次执行输入。
- 手机不能直接编辑正在运行的 Worktree，也不能提交任意 shell 命令。
- 取消、驳回、通过和安全权限变更必须记录设备、用户动作和审计事件。

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

手机接入流程：

~~~text
Electron 生成一次性配对码或二维码
  -> 手机通过局域网或 Tailscale 打开响应式 Web/PWA
  -> Service 校验配对码并签发设备会话
  -> 手机查看 Worker、任务、日志摘要和审核结果
  -> 手机提交受权限约束的修改或审核命令
  -> Service 校验设备角色、expected_version 和状态机
  -> SQLite 事务落库并通过 SSE 返回最新状态
~~~

## 5. 输入确认协议

任务进入 READY 前必须具备：

- 任务标题和明确目标。
- 可验证的验收标准。
- 项目目录。
- 基础分支。
- 基线策略：固定 Commit，或执行时使用最新已通过结果。
- 允许修改的目录。
- 禁止修改的目录。
- 测试、lint、类型检查和构建命令。
- 是否允许安装依赖。
- 是否允许访问网络。
- 最大运行时间。
- 最大自动修复次数。
- 执行器选择。
- 结果分支和 Commit 命名策略。
- 是否允许创建或更新 Pull Request。

确认时生成不可变的 Task Revision，至少记录：

~~~text
task_id
revision
task_spec_hash
project_id
base_ref
base_strategy
confirmed_base_commit
policy_snapshot
created_from
created_by_device_id
confirmed_at
~~~

Task Revision 固定任务目标、策略和基线选择方式。Scheduler 领取任务时解析实际 `base_commit` 并生成不可变 Run Input Snapshot；运行中的 Run 始终绑定该 Snapshot。用户后续修改任务不会改变正在执行的 Run。

默认 `LATEST_ACCEPTED` 策略使用项目持久化的 DevLoop integration commit，使后续任务可以基于前一个已通过结果继续开发。`PINNED` 策略始终使用用户确认的固定 Commit。

编辑规则：

- DRAFT 保存使用乐观并发版本号，桌面和手机不能静默覆盖彼此的修改。
- READY 任务修改前必须撤回为 DRAFT，再重新确认并创建 Revision。
- BLOCKED、FAILED 和 REVIEW 驳回后的修改必须创建新 Revision。
- 手机提交写操作必须携带 `expected_version` 和 `idempotency_key`。
- RUNNING 期间提交的补充说明只进入下一 Revision，不注入当前 Agent 会话。

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

成功 Run 在进入 REVIEW 前必须由控制器创建可追踪的结果 Commit。该 Commit 位于 DevLoop 结果分支，不自动合并用户基础分支。Worktree 只有在结果 Commit、Diff Artifact 和校验值都已持久化后才能清理。

审核动作：

- 通过：在 fast-forward 校验通过后，以数据库事务推进项目的 DevLoop integration commit 并进入 COMPLETED；随后幂等同步对应 Git ref，同时保留结果分支和 Commit。
- 驳回：保存审核意见，创建新的 Task Revision，回到 READY。
- 人工接管：保留 Worktree 并停止自动化。
- 取消：终止后续处理并保留审计记录。

MVP 不自动合并主分支，不自动部署。

手机设备默认只有 viewer 权限。`operator` 继承 viewer 并可以暂停、取消、通过和驳回；`editor` 继承 operator 并可以修改任务和创建 Revision。开启网络、依赖安装、Push/PR 等高风险能力必须在 Electron Desktop 再次确认。

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
READY -> DRAFT
READY -> RUNNING
RUNNING -> REVIEW
RUNNING -> BLOCKED
RUNNING -> FAILED
REVIEW -> COMPLETED
REVIEW -> READY
BLOCKED -> READY
FAILED -> READY
任意非终态 -> CANCELLED
~~~

`BLOCKED -> READY`、`FAILED -> READY` 和 `REVIEW -> READY` 都必须绑定新的 Task Revision，不能重用已执行 Revision。

`READY -> DRAFT` 只允许在任务尚未被 Scheduler 领取时执行，并通过事务防止与任务领取竞争。

执行状态转换：

~~~text
CLAIMED -> PREPARING
PREPARING -> AGENT_RUNNING | BLOCKED | FAILED | CANCELLED
AGENT_RUNNING -> VERIFYING | BLOCKED | FAILED | INTERRUPTED | CANCELLED
VERIFYING -> PREPARING_REVIEW | REPAIRING | BLOCKED | FAILED | INTERRUPTED | CANCELLED
REPAIRING -> AGENT_RUNNING | BLOCKED | FAILED | INTERRUPTED | CANCELLED
PREPARING_REVIEW -> SUCCEEDED | FAILED | INTERRUPTED | CANCELLED
~~~

状态转换必须由服务端事务完成，前端不能直接写状态字段。

## 8. 系统架构

~~~text
Electron Desktop
  ├── React Renderer
  └── Main + Preload
       ├── 原生目录选择和通知
       └── 安装、启动和诊断 DevLoop Service
                |
                | REST + SSE（127.0.0.1）
                v
DevLoop Local Service
  ├── HTTP API
  ├── Static Web Server
  ├── Device Pairing
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

Mobile Web/PWA
  |
  | Tailscale 私有 HTTPS，后续可替换为 Cloud Relay
  v
DevLoop Local Service
~~~

生产运行时，Server 同时提供 API、SSE 和已经构建的响应式前端静态资源。Electron 默认连接 `127.0.0.1`。手机 MVP 通过同一局域网或 Tailscale 访问，其中优先使用 Tailscale Serve 将私有 HTTPS 请求反向代理到 loopback Service。Service 默认不监听 `0.0.0.0`，不要求用户开放路由器端口。

Electron Renderer 和手机页面都不能直接访问项目文件或启动命令。Electron Main 只开放最小化、类型化的 Preload API，用于目录选择、系统通知和 Service 管理；所有任务、Run 和审核状态仍通过 Service API 完成。

### 8.1 能力边界

| 能力 | 是否可实现 | 实现位置 |
| --- | --- | --- |
| Electron 桌面任务中心 | 可以 | Electron + React |
| 手机查看执行状态 | 可以 | 响应式 Web/PWA + REST/SSE |
| 手机修改草稿和补充阻塞任务 | 可以 | Device Role + Task Revision |
| 手机通过、驳回、暂停或取消 | 可以 | operator/editor 权限 + Workflow Engine |
| 手机直接编辑 Worktree 或执行命令 | 不允许 | 安全边界 |
| 动态分栏任务看板 | 可以 | React 前端 |
| 节点配置和流程版本 | 可以 | 前端、Workflow Engine 和数据库 |
| 自动逐个领取任务 | 可以 | 本地 Scheduler |
| 开发完成自动进入审核 | 可以 | Workflow Engine |
| 任务持久化 | 可以 | SQLite |
| 操作本机代码目录 | 可以 | 本地服务，Renderer 和手机不能直接操作 |
| 使用 Codex 开发 | 可以 | CodexRunner 启动 codex exec |
| 接入 Claude Code | 可以 | 后续增加 ClaudeRunner |
| 实时日志和命令输出 | 可以 | JSONL、事件表和 SSE |
| Git Diff 和测试结果 | 可以 | Git Service 和 Verification Service |
| 审核、驳回和重试 | 可以 | Task Center 和 Workflow Engine |
| 一个任务阻塞后执行下一个 | 可以 | 租约和队列调度 |
| Electron 窗口或手机页面关闭后继续任务 | 可以 | 本地服务必须常驻 |
| Codex 客户端关闭后继续任务 | 可以 | Worker 独立运行 |
| Mac 离线后手机查看实时状态 | 不可以 | 只能显示最后在线状态；后续 Relay 可缓存摘要 |
| 电脑关机后继续任务 | 不可以 | 后续需要云端 Worker |

MVP 中的执行阶段不等待用户临时确认。未被输入策略预授权的能力会形成 BLOCKED 结果，Worker 随后继续下一条任务。

## 9. 核心模块

### 9.1 Electron Desktop

- 承载 React Renderer，不在 Renderer 中启用 Node.js 集成。
- 通过安全 Preload API 提供项目目录选择、系统通知和诊断能力。
- 安装、启动、停止和查看用户级 DevLoop Service 状态。
- 展示 Codex、Git、Node、权限和配对状态预检。
- 生成手机配对二维码，查看并撤销已授权设备。
- 关闭窗口后不停止正在运行的 Service。

### 9.2 Web/PWA

- 项目管理。
- 动态任务看板。
- 任务创建和输入确认。
- 任务详情。
- 运行历史。
- 结果审核。
- Diff、测试和日志查看。
- Loop 开关和 Worker 状态。
- 设置和项目安全策略。
- 桌面和手机复用同一套 React 领域组件与 API Client。
- 手机布局优先展示在线状态、当前任务、阶段、耗时、日志摘要和审核动作。
- 手机表格转换为列表或可控横向滚动，交互目标满足触控尺寸，不产生页面级横向滚动。
- 取消、驳回、通过等重要操作显示明确确认和成功/失败反馈。
- 实时状态区域使用可访问的动态更新提示。

### 9.3 API Server

- 输入校验和鉴权。
- 任务、项目和审核 API。
- SSE 事件流。
- 静态资源服务。
- 本地和已配对设备会话管理。
- 所有写命令校验设备角色、`expected_version` 和 `idempotency_key`。

### 9.4 Remote Access

- Electron 生成短时、单次使用的配对码或二维码。
- 配对成功后签发独立设备凭据，支持 viewer、operator 和 editor 角色。
- MVP 使用同一局域网或 Tailscale 私有网络，不开放公网端口。
- 手机断线重连后通过全局 Event ID 补齐事件；补齐范围外则重新获取状态快照。
- 后续 Cloud Relay 只能转发经过鉴权的命令和事件，不成为任务事实来源。
- Electron 可以随时撤销设备，Service 立即拒绝其后续请求。

### 9.5 Workflow Engine

- 校验合法状态转换。
- 创建不可变 Task Revision。
- 编排准备、执行、验证、修复和审核节点。
- 持久化节点状态。
- 根据恢复规则重启中断任务。

### 9.6 Scheduler

- 单 Worker 并发。
- 通过 SQLite 事务领取最早的 READY 任务。
- 使用 lease_owner、lease_until 和 heartbeat 防止重复领取。
- BLOCKED 和 FAILED 任务不占用 Worker。
- 没有任务时使用事件唤醒或低频退避，不做高频轮询。

### 9.7 Git Service

- 校验项目是否为 Git 仓库。
- 记录 base commit。
- 为项目维护 DevLoop 自有 integration commit，并同步一个可恢复的 Git ref，不直接推进用户基础分支。
- 为每个 Run 创建独立 Worktree 和分支。
- 获取状态、Diff 和修改文件。
- 成功 Run 进入 REVIEW 前由控制器创建结果 Commit。
- 审核通过后保留结果分支和 Commit，并在满足 fast-forward 条件时推进数据库 integration commit，再幂等同步 Git ref，但不自动合并用户基础分支。
- 审核前不修改用户当前工作目录。
- 定期清理已经完成且不再需要的 Worktree。

### 9.8 Agent Runner

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

### 9.9 Verification Service

- 只执行用户确认过的命令。
- 为每条命令设置超时。
- 捕获 stdout、stderr 和退出码。
- 在 Agent 完成后独立运行。
- 将失败结果反馈给下一次修复尝试。
- 达到最大次数后停止，不形成无限循环。
- MVP 只支持用户信任的本地仓库。若验证命令没有额外 OS 沙箱，网络和文件限制必须明确标注为策略检查而不是强隔离保证。

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
domain_events
artifacts
worker_state
review_decisions
paired_devices
remote_commands
audit_events
~~~

关键关系：

- 一个 Project 有多个 Task。
- 一个 Task 有多个不可变 Revision。
- 一个 Revision 可以有多个 Run。
- 一个 Run 有多个 Step、Event 和 Artifact。
- 审核决定始终关联具体 Run。
- `domain_events` 保存所有 Task、Run、Worker 和 Device 状态变化，作为 SSE 断线补偿来源。
- 一个配对设备拥有独立角色、凭据、最后在线时间和撤销状态。
- 一个远程写命令对应唯一 `idempotency_key`，重复提交返回第一次执行结果。

重要字段：

~~~text
projects:
  id
  path
  default_base_ref
  integration_ref
  integration_commit
  version

tasks:
  id
  project_id
  title
  status
  priority
  active_revision_id
  version

task_revisions:
  id
  task_id
  revision
  spec_json
  task_spec_hash
  base_ref
  base_strategy
  confirmed_base_commit
  created_from
  created_by_device_id
  confirmed_at

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
  execution_token
  process_group_id
  runner_version
  run_input_hash
  started_at
  finished_at

run_events:
  id
  run_id
  sequence
  type
  payload_json
  created_at

domain_events:
  id
  aggregate_type
  aggregate_id
  type
  payload_json
  created_at

paired_devices:
  id
  name
  role
  credential_hash
  last_seen_at
  revoked_at

remote_commands:
  id
  device_id
  idempotency_key
  command_type
  expected_version
  status
  result_json
  created_at
~~~

约束：

- 同一 Task 同时最多一个非终态 Run。
- `run_events(run_id, sequence)` 唯一。
- `remote_commands(device_id, idempotency_key)` 唯一。
- 所有 lease 更新和阶段提交必须匹配当前 `execution_token`，过期 Worker 不能继续写状态。

## 11. API 设计

首批 REST API：

~~~text
GET    /api/health
GET    /api/session

POST   /api/devices/pairing-sessions
POST   /api/devices/pair
GET    /api/devices
PATCH  /api/devices/:id
POST   /api/devices/:id/revoke

GET    /api/projects
POST   /api/projects
PATCH  /api/projects/:id

GET    /api/tasks
POST   /api/tasks
GET    /api/tasks/:id
PATCH  /api/tasks/:id
POST   /api/tasks/:id/revisions
POST   /api/tasks/:id/confirm
POST   /api/tasks/:id/unconfirm
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

除配对、登录等引导接口外，领域写请求统一包含：

~~~text
expected_version
idempotency_key
~~~

设备配对后使用 HttpOnly、SameSite Cookie。EventSource 自动重连时携带 Cookie 和 `Last-Event-ID`。如果请求的 Event ID 已超过保留窗口，Server 返回重同步事件，客户端重新获取状态快照。

审核通过还要携带预期的项目 integration version。若 integration commit 已变化，Server 返回 `409 Conflict`，任务保持 REVIEW，不覆盖其他已通过结果。

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
├── service/
├── backups/
└── runtime.json
~~~

源码仓库不保存用户任务数据库、Agent 日志和 Worktree。

## 13. 安全模型

- Server 默认仅监听 127.0.0.1。
- Tailscale Serve 将私有 HTTPS 入口反向代理到 loopback Service；可选局域网监听必须显式开启并配置 TLS。
- 禁止默认绑定 `0.0.0.0`，禁止指导用户进行公网端口转发。
- 首次启动生成随机本地访问令牌。
- Electron 本地会话与手机设备会话使用不同凭据，均校验 Origin 和 Host。
- 配对码短时有效、单次使用，数据库只保存摘要；配对成功后可在 Electron 中撤销设备。
- 设备角色分为 viewer、operator 和 editor，权限逐级继承；角色变更只能在 Electron 完成，所有写操作执行服务端权限校验。
- Electron Renderer 使用 `contextIsolation`，关闭 `nodeIntegration`，只通过最小化 Preload API 使用原生能力。
- 项目必须由用户显式注册。
- 允许写入的路径必须属于注册项目或对应 Worktree。
- Runner 默认使用 workspace-write 沙箱。
- 不使用绕过审批和沙箱的危险参数。
- Codex 访问模型服务的控制面网络与 Agent 命令访问互联网的工具网络分别配置。
- 网络、依赖安装、Push 和 PR 权限按项目保存；远程设备不能单独开启这些高风险能力。
- 禁止自动部署、自动合并和生产数据操作。
- 命令只来自确认过的项目策略，不接受 Agent 动态生成任意命令。
- 手机不能提交本地路径或任意命令，也不能直接编辑 Worktree。
- MVP 将注册项目视为用户信任的代码；没有额外 OS 沙箱时，不宣称 Verification 命令具备强网络或文件隔离。
- 日志写入前清理常见密钥和令牌格式。

## 14. 可靠性设计

- SQLite 开启 WAL。
- 每次状态转换和 `domain_events` 写入使用同一事务。
- Worker 使用租约和 heartbeat。
- Run 每个阶段必须可重入或有明确恢复策略。
- Agent 和命令进程支持超时、取消和进程树终止。
- 服务重启后扫描过期租约。
- 服务重启后先处理旧进程组和 Worktree 锁，再允许创建新 attempt。
- `AGENT_RUNNING` 中断后不尝试无缝接管原进程，标记为 INTERRUPTED，再基于保留 Worktree 创建新 attempt 或生成人工结果。
- VERIFYING 和 PREPARING_REVIEW 等确定性阶段允许安全重跑。
- 所有阶段写入校验 `execution_token`，防止旧 Worker 在租约失效后提交结果。
- 启动恢复任务对账数据库 integration commit 与 Git ref，修复审批事务后尚未完成的 ref 同步。
- 手机命令通过 idempotency key 去重，并在任务版本不匹配时返回冲突。
- Mac 离线时手机显示 `last_seen_at`；MVP 不缓存或延迟执行高风险写命令。
- 对每个任务限制总时长、Agent 次数和修复次数。
- Worktree 创建、Commit 和清理操作记录审计事件。
- 日志和 Artifact 设置单次大小限制、总磁盘配额和保留策略；SQLite WAL 数据使用 SQLite Backup API 备份。

## 15. 前端页面

~~~text
/status
/board
/projects
/projects/:id
/tasks/:id
/runs
/runs/:id
/devices
/pair
/settings
~~~

看板默认分栏：

~~~text
草稿 | 待执行 | 执行中 | 待审核 | 已完成 | 阻塞
~~~

Electron 默认进入 `/board`，手机默认进入 `/status`。执行中列只展示摘要状态，不要求用户持续监控。用户主要操作集中在草稿、待执行和待审核。

手机状态页采用紧凑的运维面板布局，首屏必须看到：

- Mac 和 Service 在线状态、最后心跳时间。
- Worker 运行或暂停状态。
- 当前任务、阶段、耗时和最近事件。
- READY 队列数量以及 REVIEW、BLOCKED、FAILED 提醒。

手机任务页支持编辑 DRAFT、补充 BLOCKED/FAILED 任务、提交驳回意见和创建新 Revision。完整项目设置、安全授权、本地路径和 Codex 登录只在 Electron 中提供。

## 16. 代码目录规划

~~~text
devloop/
├── apps/
│   ├── desktop/
│   │   └── src/
│   │       ├── main/
│   │       └── preload/
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
- Electron Desktop、Web、Server 和共享包。
- 开发环境并行启动。
- Electron Renderer 加载 Vite 页面，Server 提供健康检查和静态页面。
- Electron Main/Preload 使用安全默认配置，不向 Renderer 暴露 Node.js。
- SQLite 迁移框架。
- Node、Git 和 Codex 路径与版本预检。
- 用测试仓库完成一次 Worktree、`codex exec`、验证和结果 Artifact 技术冒烟。
- 基础测试和代码质量命令。

通过条件：一条命令启动 Electron、Web 和 Server；桌面端显示 Service 与 Codex 预检结果，测试执行链路能够产生可审计 Artifact。

### Phase 1：任务和项目

- 注册本地 Git 项目。
- 项目策略。
- 任务 CRUD。
- 输入完整性校验。
- Task Revision。
- 持久化看板。

通过条件：重启 Service 和 Electron 后任务、项目和状态保持不变。

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
- Codex CLI 版本、参数、非交互认证和受控配置检测。
- JSONL 事件解析。
- 结构化输出 Schema。
- 超时和取消。
- 独立验证和自动修复。
- 进入 REVIEW 前创建结果 Commit，并保留结果分支。
- 审核通过时推进 DevLoop integration commit 并同步内部 Git ref，后续默认任务基于最新已通过结果执行。

通过条件：在测试仓库中完成真实代码修改、测试、结果 Commit 和审核结果；CLI 异常退出时仍能生成可解释状态。

### Phase 4：桌面产品化与可靠性

- Electron 项目目录选择、设置和诊断页面。
- Diff 和 Artifact 页面。
- 通过、驳回和人工接管。
- 服务重启恢复。
- 进程异常恢复。
- Worktree 清理。
- 系统通知。
- 用户级 launchd 安装、升级和卸载。
- macOS PATH、Codex 凭据和文件权限预检。

通过条件：Electron 窗口关闭后 Worker 继续运行；Service 重启和 Agent 异常退出后，任务状态仍然一致且可解释。

### Phase 5：手机查看和受控操作

- 响应式 `/status`、任务详情、Run 详情和审核页面。
- PWA Manifest、移动端导航和在线/离线状态。
- Electron 生成二维码和一次性配对码。
- viewer、operator、editor 设备角色和设备撤销。
- Tailscale 私有 HTTPS 接入说明与检测。
- SSE 断线补偿和状态快照重同步。
- 手机编辑 DRAFT、补充 BLOCKED/FAILED 任务并创建新 Revision。
- 手机暂停、取消、通过和驳回的确认、幂等和版本冲突处理。
- 375px、768px、1024px 和桌面视口的 Playwright 覆盖。

通过条件：已配对手机可以在外部网络通过 Tailscale 查看实时执行状态、修改允许字段并提交审核；未授权或低权限设备不能执行写操作。

### Phase 6：扩展能力

- Workflow Definition 和版本。
- 阶段节点、执行节点和条件边。
- 节点编辑器。
- ClaudeRunner。
- GitHub Issue 和 Pull Request 集成。
- 自建 Cloud Relay、多设备消息推送和端到端加密。

## 18. MVP 非目标

- 多用户协作。
- 云端 Worker。
- 自建 Cloud Relay。
- 原生 iOS 或 Android App。
- 手机直接编辑源码或 Worktree。
- 未经私有网络保护的公网访问。
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
12. Electron 窗口关闭后 Worker 继续运行。
13. 服务重启后状态和历史可以恢复。
14. 成功 Run 在进入 REVIEW 前有可追踪的结果 Commit。
15. 审核通过只推进 DevLoop integration commit 并同步内部 Git ref，后续默认任务可以继承已通过结果，用户基础分支不被自动修改。
16. Electron 可以生成配对二维码并撤销手机设备。
17. 手机可以通过 Tailscale 查看 Worker、任务、日志摘要和审核结果。
18. 手机修改 DRAFT 或补充失败任务时创建正确的 Task Revision，不能改变正在运行的 Revision。
19. 手机写操作具备角色校验、版本冲突检测、幂等处理和审计记录。

## 20. 已确定决策

- Electron Desktop 是主要入口，响应式 Web/PWA 是手机入口和浏览器备用入口。
- 本机服务是执行主体。
- Electron 和手机界面都不直接操作本地文件或启动 CLI。
- SQLite 是本地事实来源。
- 单 Worker 是 MVP 默认值。
- Git Worktree 是任务隔离方式。
- Codex CLI 是第一执行器。
- 用户只确认输入和输出。
- 中途问题转换为阻塞结果，不弹交互确认。
- 运行中的 Task Revision 不可变，手机修改只影响新 Revision。
- 手机 MVP 使用 Tailscale，不开放公网端口，不自建 Cloud Relay。
