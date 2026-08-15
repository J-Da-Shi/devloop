# DevLoop 单用户自托管架构与开发方案

## 1. 文档状态

- 产品名称：DevLoop
- 当前阶段：从仅本机运行升级为本地与个人服务器均可部署
- 使用方式：单用户、自托管、安装即用
- 使用入口：Electron、桌面浏览器、手机浏览器/PWA
- 核心执行器：运行 DevLoop Server 的设备中的 Codex CLI
- 持久化：SQLite、托管 Git 仓库、Worktree、Skill 和运行事件
- 远程代码来源：用户提供的 Git SSH 地址

本文档是当前实现基线。DevLoop 不建设注册、登录、管理员账户和多租户系统。每一套安装都是独立实例，拥有自己的数据、Codex 配置、Git 凭证和执行环境。

## 2. 产品定义

DevLoop 是一个可以安装在个人电脑或个人服务器上的无人值守开发任务系统。

用户可以通过 Electron、桌面浏览器或手机完成以下操作：

1. 注册远程 Git 仓库。
2. 创建任务并指定目标分支。
3. 查看排队、执行、验证和审核状态。
4. 修改尚未执行的任务内容。
5. 取消执行中的任务，或删除非执行中的任务。
6. 审核结果，并把结果推送到远程目标分支。
7. 管理适配个人工作流的可插拔 Skill。

DevLoop Server 负责：

1. 管理 SQLite 和任务状态机。
2. 克隆并同步远程 Git 仓库。
3. 从待执行队列原子领取任务。
4. 为每次执行创建隔离 Worktree。
5. 调用 Codex CLI 修改代码。
6. 在本地解析并校验 Codex 的结构化结果。
7. 保存运行事件、Commit 和结构化验收结果。
8. 审核通过后把结果 Commit 安全推送到远程目标分支。

## 3. 使用与分发形态

DevLoop 面向普通用户是一个安装在自己电脑上的 Electron 客户端；面向开发者是一个可以 clone 并运行的 pnpm monorepo；对于确实需要多台设备连接同一实例的少数场景，另外提供可选的服务器容器化部署。三条路径运行的是同一份代码。

### 3.1 本机安装（主线）

```text
Electron 客户端 / 本机浏览器
              |
           127.0.0.1
              |
本机 DevLoop Server 进程
├── Codex CLI
├── SQLite（任务与运行事件）
├── Git 仓库 / Worktree
└── Skill
```

- Electron 客户端启动本机 DevLoop Server 进程，Web 界面通过 `127.0.0.1:4317` 连接。
- 数据保存在当前用户的应用数据目录（开发环境使用项目内 `.devloop-data`）。
- Codex CLI 使用当前用户已有的配置、Skill 和 MCP。
- 服务只监听 `127.0.0.1`，其他设备不能直接访问。

### 3.2 源码开发

面向贡献者与从源码尝试的开发者。要求 Node.js 24 与 pnpm 10，`pnpm install && pnpm dev` 即可完整启动 Electron、Web 与本地 Server；`pnpm dev:web` 用于纯浏览器调试。数据同样保存在项目内 `.devloop-data`。

### 3.3 可选：多人共享部署

```text
Electron / 桌面浏览器 / 手机 PWA
                 |
              HTTPS
                 |
       Tailscale 或宝塔 Nginx
                 |
          127.0.0.1:4317
                 |
        DevLoop Server 容器
        ├── Codex CLI
        ├── Scheduler / Worker
        ├── Web / API / SSE
        └── /data
            ├── SQLite
            ├── repositories
            ├── worktrees
            └── skills
```

- 用户把 DevLoop 部署在自己的服务器上，多台设备共享同一 SQLite 与执行队列。
- Electron 只作为服务器 Web 应用的桌面入口，不在本机重复执行任务。
- 客户端关闭不影响服务器 Worker 继续执行。

### 3.4 数据归属

- 本机安装时，SQLite 属于用户当前电脑。
- 多人共享部署时，SQLite 属于用户自己的服务器。
- 浏览器不能让远程服务器直接使用访问者手机或电脑上的 SQLite。
- 更换电脑时，若使用共享部署只要连接原服务器即可继续使用原数据；迁移本机实例时需要同时迁移数据目录和 Codex/Git 配置。
- 每套实例彼此隔离，不共享 DevLoop 中心账户或中心数据库。

## 4. 单用户身份与安全边界

### 4.1 内置实例所有者

DevLoop Server 对能够访问实例的请求统一使用内置身份：

```text
id: instance-owner
name: 实例所有者
role: editor
kind: owner
```

系统不提供注册、登录、密码找回、管理员初始化、用户表或会话表。现有接口继续使用角色校验，以保留明确的授权边界，但当前实例所有者拥有完整编辑权限。

### 4.2 网络访问保护

没有应用内登录不代表可以把服务无保护地开放到公网。

- 本地模式默认只监听 `127.0.0.1`。
- 手机访问优先使用 Tailscale，不开放公网端口。
- 宝塔公网部署至少启用 HTTPS，并在 Nginx 层使用 Basic Auth、IP 白名单或实例访问密钥之一。
- Docker Compose 只向宿主机回环地址发布 `4317`，由可信网络或反向代理提供入口。
- 不允许直接把包含 Codex、Git 和文件操作能力的 API 暴露在公网。

应用内暂不保留设备配对作为主要安全模型。旧设备数据可以保留用于兼容，但导航和主流程不依赖配对；后续只有在需要按设备限制只读、审核等权限时再恢复该能力。

### 4.3 手机可修改范围

手机可以调用与桌面端相同的领域 API，允许：

- 编辑草稿任务。
- 修改尚未执行的任务目标分支和验收条件。
- 对失败或阻塞任务创建新 Revision。
- 取消执行、删除非执行中任务、通过或驳回审核。
- 启用、停用和选择已有 Skill。

手机不提供：

- 任意服务器文件浏览或编辑。
- 任意 Shell 命令执行。
- Git 私钥、Codex凭证和环境变量读取。
- 绕过任务状态机直接修改数据库或 Worktree。

## 5. 核心原则

### 5.1 Server 是实例内唯一事实来源

- SQLite 保存任务、Revision、Run、审计和状态机数据。
- 托管仓库保存执行所需的 Git 对象。
- 远程 Git 仓库保存跨设备可见的代码分支。
- 浏览器、手机和 Electron 不维护独立任务事实。
- 客户端断开不影响 Worker 执行。

### 5.2 远程仓库替代客户端本地路径

项目注册使用 `repositoryUrl`，首版支持 SSH Git 地址，例如：

```text
git@github.com:team/project.git
git@codeup.aliyun.com:team/project.git
```

运行 Server 的设备使用自己的 SSH 私钥和 `known_hosts` 访问仓库。仓库 URL 禁止携带用户名密码或访问令牌，Git 凭证不写入 SQLite。

每个项目拥有稳定托管目录：

```text
<数据目录>/repositories/<project-id>
```

绝对路径只在 Server 内部使用，不通过项目 API 返回给客户端。

### 5.3 Agent 不管理队列

Scheduler、状态机、重试、Git 同步和结构化结果校验由确定性程序控制。Codex CLI 每次只处理一个已经确认的任务，不能领取下一条任务、修改任务状态或直接访问 DevLoop 数据库。

### 5.4 不信任自然语言完成声明

任务进入审核前必须同时满足：

- Agent 结构化输出可被本地解析和校验。
- Worktree 中存在可解释的代码修改，或 Agent 明确说明无需修改。
- Codex 返回的验收结果通过 DevLoop 本地解析和字段校验。
- Worker 创建可追踪的结果 Commit。
- 日志和结果摘要已经持久化。

自定义 Provider 不使用 `--output-schema`。DevLoop 在提示词中要求返回 JSON，在本地解析和校验；格式不合格时只进行一次格式修复重试。

### 5.5 运行输入不可变

- 草稿可以编辑。
- 任务确认时创建不可变 Revision。
- Worker 领取时固定远程基线 Commit。
- 执行中对任务的修改不能注入当前 Run。
- 被驳回、失败或阻塞的任务重新执行时必须创建新 Revision。

### 5.6 全部操作可审计

系统至少保存项目同步、任务输入快照、基础 Commit、结果 Commit、目标分支、Agent 事件、验收结果、取消、删除、审核和推送记录。任务删除只做软删除，不物理清除历史。

当前尚未提供独立验证命令配置模型。后续需要把验证命令固化到 Revision，由 Worker 在 Codex 完成后独立执行并保存退出码；在此之前，页面展示的是 Codex 返回且经过本地结构校验的验收结果。

## 6. Git 生命周期

### 6.1 注册项目

```text
提交仓库名称、SSH 地址和默认分支
  -> 校验 URL 协议和格式
  -> 检查规范化地址未重复注册
  -> 克隆到临时目录
  -> 校验默认分支存在
  -> 原子移动到 repositories/<project-id>
  -> 保存默认分支远程 Commit
  -> 返回不含服务器绝对路径的项目信息
```

克隆失败时删除未完成目录，不留下可被调度的项目记录。

### 6.2 旧本地项目原地迁移

升级前已经注册的本地项目可能只有绝对路径，没有 `repositoryUrl`。这类项目不能通过“新建远程项目”替代，否则旧任务、Revision、Run 和审核记录仍会关联旧项目。

迁移必须保留原项目 ID，并按以下顺序执行：

```text
读取旧仓库 origin
  -> 规范化并校验 SSH 地址
  -> 备份 SQLite
  -> 从旧仓库复制 Git 对象和历史结果 Commit
  -> 写入 repositories/<project-id> 托管目录
  -> 将托管仓库 origin 切换为真实远程地址
  -> fetch --prune origin 并校验默认分支
  -> 事务更新项目 path、repositoryUrl、同步 Commit 和版本
  -> 保留原项目 ID 及全部任务关联
```

迁移期间不移动或删除旧工作区。托管仓库准备失败时不更新数据库；数据库更新失败时删除未启用的托管副本。审核中的结果 Commit 必须能在托管仓库中解析后才允许完成切换。

### 6.3 领取任务

```text
READY
  -> 等待 5 秒领取延迟
  -> fetch --prune origin
  -> 解析 origin/<目标分支>
  -> 目标分支不存在时回退到默认分支
  -> 固定 baseCommit
  -> 创建 devloop/run/<run-id> 内部分支
  -> 创建 worktrees/<run-id>
  -> 进入 AGENT_RUNNING
```

用户输入的目标分支不存在时允许创建，初始基线使用项目默认分支，不使用 Server 上残留的同名本地分支。

### 6.4 执行与审核

```text
Codex 修改 Worktree
  -> DevLoop 本地校验结构化结果
  -> 创建结果 Commit
  -> 保存 resultCommit
  -> REVIEW
```

审核通过后：

```text
再次 fetch origin
  -> 检查远程目标分支是否仍位于执行基线
  -> 新分支：推送 resultCommit
  -> 已有分支且可快进：推送 resultCommit
  -> 远程已前进：拒绝推送，不强推
  -> 推送成功后标记 COMPLETED
```

网络失败不能伪装成已完成。Run 记录 `pushedAt` 和 `pushedCommit`，审核推送保持可重试。

### 6.5 取消与清理

- 取消执行会向 Codex CLI 主进程发送 SIGTERM，5 秒后 SIGKILL 兜底。进程组级取消（保证 Codex 拉起的子进程与工具调用一并退出）尚未接入。
- 执行令牌立即轮换，迟到结果不能覆盖任务状态。
- Worktree、运行事件和未提交修改保留供诊断，人工确认后由显式动作触发清理，不做定时 GC。
- 非执行中任务只做软删除。

## 7. 任务执行流程（当前实现）

本节描述"任务进入系统 → 被 Worker 领取 → 调用 Codex CLI → 生成结果 Commit → 人工审核 → 推送到远程"这条主链路当前的代码实现。所有位置均以 `file:line` 标注入口，便于按图索骥阅读源码。

### 7.1 入口

任务通过以下方式进入或重回执行队列：

- `POST /api/tasks`（`apps/server/src/app.ts:293`）：插入 DRAFT 行，随后 `autoQueueTask`（`app.ts:94`，实现见 `packages/db/src/repositories.ts:664`）在满足条件时静默将草稿转 READY。
- `POST /api/tasks/:taskId/confirm`（`app.ts:335`）：显式 DRAFT → READY，带 `baseStrategy`。
- `POST /api/runs/:runId/reject`（`app.ts:429`）：REVIEW 打回 READY，允许下一次执行。
- 启动恢复（`apps/server/src/agent-worker.ts:68-84`）：服务进程重启后把残留 `worker_state.activeRunId` 对应的 Run 标记为 FAILED，任务回到可重试状态。

暂无 CLI 投递、cron 或 Webhook 入口。

### 7.2 领取

单例 `AgentWorker`（`agent-worker.ts:42`）在 `apps/server/src/index.ts:54` 启动，通过 `setInterval(1_000ms)`（`agent-worker.ts:90`）轮询领取，同时任何变更任务队列的 HTTP 端点会额外调用 `worker.wake()`（如 `app.ts:98,341,370,441`）作为事件驱动补充。

- 并发上限：1。由 `this.pulling` 和 `this.execution`（`agent-worker.ts:137-178`）互斥。
- 领取 SQL：`claimNextTask`（`packages/db/src/repositories.ts:748`）在 SQLite 事务内，选 `status=READY`、`repositoryUrl` 非空的项目，按 `priority DESC, createdAt` 排序，并要求 `updatedAt <= now - DEVLOOP_AGENT_CLAIM_DELAY_MS`（默认 5000ms，见 `runtime-config.ts`），避免刚编辑就被抢走。
- 幂等：领取时生成 `executionToken`（uuid），后续每次落库都校验令牌一致，令牌不匹配的写入视为迟到结果被丢弃（见 `isInvalidExecutionError`，`agent-worker.ts:383-393`）。

### 7.3 准备工作区

`AgentWorker.prepareWorkspace`（`agent-worker.ts:294`）：

1. `GitService.fetchRepository`（`packages/git/src/git-service.ts`）：`git fetch --prune origin`。
2. `resolveRemoteTargetBase(targetBranch, fallback=defaultBaseRef)`：解析 `origin/<targetBranch>`，不存在则回退到项目默认分支的 Commit 作为基线。
3. `createWorktree`：在 `data/worktrees/<runId>` 创建 Worktree，分支名 `devloop/run/<runId>`。
4. `taskRuns.baseCommit` 与 `worktreePath` 落库。

### 7.4 调用 Codex CLI

`CodexRunner.runAttempt`（`packages/runners/src/codex-runner.ts:534`）通过 `execa` 启动 Codex CLI：

```text
codex exec --json --output-last-message <runId>.json
  --sandbox workspace-write --ephemeral --ignore-rules
  --config approval_policy="never"
  --config shell_environment_policy.inherit="core"
  --color never --cd <worktreePath>
  --disable <features…> -
```

Prompt 通过 stdin 送入。

- `cwd`：Run 对应的 Worktree。
- `env`：显式白名单（`codex-runner.ts:43-64`），只放行 `HOME / PATH / CODEX_HOME / OPENAI_API_KEY / CODEX_API_KEY / CODEX_ACCESS_TOKEN / *_PROXY / SSL_*`。
- 超时：`DEVLOOP_CODEX_TIMEOUT_MS`（默认 30 分钟，`runtime-config.ts:71`）。
- 取消：`AbortController` → `cancelSignal`；当前只 SIGTERM 到 Codex 主进程，`taskRuns.processGroupId` 列存在但写入 `null`（`repositories.ts:815`），进程组级取消尚未接入。

Codex 的 stdout 逐行解析为 JSON 事件，映射为 `RunnerEvent` 后经 `emit`（`agent-worker.ts:271-292`）驱动 `setRunPhase`，把 Run 依次推进到 PREPARING → AGENT_RUNNING → VERIFYING → PREPARING_REVIEW。

若最终 JSON 解析失败，`CodexRunner` 再跑一次 `sandbox=read-only`、`disableTools=true` 的修复回合（`codex-runner.ts:492-517`）要求 Codex 重新输出格式化 JSON。若仍失败，Run 判定为 FAILED。

### 7.5 状态迁移写者

| 迁移 | 位置 | 触发 |
| --- | --- | --- |
| DRAFT → READY | `repositories.ts:589` `confirmTask` | HTTP confirm 或 `autoQueueTask` |
| READY → RUNNING + 新 Run CLAIMED | `repositories.ts:748` `claimNextTask` | Worker 领取，SQLite 事务 |
| CLAIMED → …PREPARING_REVIEW | `agent-worker.ts:271` `handleRunnerEvent` + `setRunPhase` | Codex 事件流 |
| RUNNING → REVIEW / BLOCKED / FAILED | `repositories.ts:1001/1088/1165` `completeRun / failRun / blockRun` | Runner 结果 outcome |
| REVIEW → COMPLETED | `repositories.ts:1377` `approvePublishedRun` | HTTP approve，且 `gitService.pushResult` 成功后 |
| REVIEW → READY | `repositories.ts:1530` `rejectRun` | HTTP reject |
| RUNNING → CANCELLED | `repositories.ts:1242` `cancelRunningTask` | HTTP cancel → `agent-worker.ts:121` `cancelTask` |

所有迁移返回 `EventfulResult`，由 `apps/server/src/event-bus.ts` 的 `DomainEventBus` 广播给 SSE 订阅者，并写入 `domain_events` 表（`packages/db/src/schema.ts:133`）。

### 7.6 审核推送

`POST /api/runs/:runId/approve`（`app.ts:408`）→ `GitService.pushResult`（`git-service.ts:314`）：

1. 再次 `fetch origin`。
2. 校验远程 `<targetBranch>` 仍位于本次执行的 `baseCommit`（快进检查），或该分支在远程不存在。
3. 推送 `<resultCommit>:refs/heads/<targetBranch>`。
4. 远端已前进时拒绝推送，不做强推。
5. 推送成功后 `approvePublishedRun` 将 Run 记录的 `pushedAt` 与 `pushedCommit` 落库，并把任务置 COMPLETED。

### 7.7 客户端实时同步

- Fastify 监听 `DEVLOOP_HOST:DEVLOOP_PORT`（默认 `127.0.0.1:4317`）。`apps/web/dist` 存在时静态挂载在 `/`（`app.ts:485-488`）。
- `GET /api/events?after=<id>`（`app.ts:455-483`）：先从 `domain_events` 表回放 `> afterId` 的事件，再订阅实时 `DomainEventBus`，15 秒心跳。
- Web 客户端 `apps/web/src/components/realtime-sync.tsx:19` 使用 `EventSource`，`last-event-id` 存储于 `sessionStorage`，事件到达时按 key 让 react-query 缓存失效。
- Desktop 只是外壳，`apps/desktop/src/main/index.ts` 仅暴露 `desktop:get-service-url` 与 `desktop:is-full-screen` 两个 IPC。

### 7.8 边界与已知遗留

以下项在代码中可见并已确认为"当前不做"或"待接入"，记录在此以避免误读文档：

- **Worktree 清理**：`agent-worker.prepareWorkspace` 只创建 `data/worktrees/<runId>`。当前代码中没有任何路径调用 `git worktree remove` 或 `prune`。等"人工 dismiss"路径接入后由该动作触发清理。
- **`taskRuns.processGroupId`**：Schema 列存在但始终写入 `null`。进程组级取消尚未实现。
- **`packages/workflow`**：XState 状态机作为规格文档存在，不被 `apps/server` 引用；运行时状态机在 `packages/shared/src/transitions.ts` 与 Repository 中。
- **`autoQueueTask` 触发条件**：以 `priority === 100`（`repositories.ts:666`）作为自动确认信号，属于当前的隐式约定。

## 8. 数据模型

### 8.1 项目公开字段

```text
id
name
repositoryUrl
defaultBaseRef
integrationRef
integrationCommit
lastFetchedAt
version
createdAt
updatedAt
```

数据库内部继续保存 `path` 作为托管仓库绝对路径，但 API 不返回该字段。

### 8.2 Run 推送字段

```text
pushedAt
pushedCommit
```

它们用于区分“本地结果已生成”“审核已通过”和“远程分支已更新”。

### 8.3 不新增的表

当前不新增以下表：

```text
admin_users
auth_sessions
tenants
organizations
```

每套安装只使用自己的 SQLite 文件。

## 9. API 边界

项目相关接口：

```text
POST /api/projects
POST /api/projects/:projectId/sync
```

项目创建请求：

```json
{
  "name": "示例项目",
  "repositoryUrl": "git@github.com:team/project.git",
  "defaultBaseRef": "main"
}
```

- 项目响应不包含服务器绝对路径。
- `/api/setup/*`、`/api/session/login` 和 DevLoop 账户接口不存在。
- `/api/session` 只返回内置实例所有者，供前端判断能力。
- 审核接口负责安全推送远程目标分支。
- 旧的本机工作区覆盖接口不在远程仓库模式中暴露。

## 10. 持久化目录

### 10.1 本地安装

生产版 Electron 使用操作系统应用数据目录，例如 macOS：

```text
~/Library/Application Support/DevLoop/
├── devloop.db
├── repositories
├── worktrees
└── skills
```

开发环境继续使用项目内 `.devloop-data`，避免污染正式数据。

### 10.2 Docker 与宝塔

容器统一使用 `/data`：

```text
/data/devloop.db
/data/repositories
/data/worktrees
/data/skills
```

必须把 `/data` 映射到服务器持久目录。容器重建不得丢失该目录。Git SSH 凭证和 Codex 配置分别以只读或受控方式挂载，敏感内容不写入镜像。

## 11. 网络与宝塔配置

Compose 默认只向宿主机回环地址发布端口：

```text
127.0.0.1:4317:4317
```

宝塔 Nginx 负责 HTTPS 和外层访问保护。SSE 反向代理必须关闭缓冲：

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
```

正式环境要求：

- 优先使用 Tailscale 私有访问。
- 公网入口必须启用 HTTPS 和至少一种外层认证。
- 禁止直接开放 `4317` 端口。
- 防火墙只开放必要端口。
- SQLite 备份使用一致性快照或停机复制。
- 单个 SQLite 数据库只能由一个 DevLoop Server 实例使用。

## 12. 容器运行约束

镜像内需要 Node.js、Git、OpenSSH 客户端、Codex CLI、生产依赖、构建后的 Web 静态资源和 DevLoop Server。

首版基础镜像保证 Node.js 和 pnpm 工具链。其他语言通过自定义镜像扩展，不允许任务任意修改宿主机。Codex 和 Git 使用同一个非特权用户运行，持久化目录必须属于该用户。

SQLite 不支持多个服务实例并行调度，因此禁止 PM2 集群、Compose 多副本或多个容器共享同一个数据库。

## 13. 失败处理

- `git clone` 失败：项目注册失败，不保留半成品。
- `git fetch` 失败：任务进入阻塞或失败状态并保留错误摘要。
- Codex 不可用：Worker 进入降级状态，不领取新任务。
- Codex 执行失败：Run 进入失败状态，随后继续下一任务。
- JSON 格式错误：进行一次格式修复重试，仍失败则结束 Run。
- 远程分支前进：审核推送返回冲突，不强推、不覆盖他人提交。
- 服务重启：未结束 Run 标记为中断，由用户决定是否重新排队。
- SQLite 不可写：健康检查失败并停止领取任务。

## 14. 开发顺序

### 阶段一：单用户实例边界

1. 删除管理员、登录和会话模型。
2. API 使用内置实例所有者身份。
3. 页面移除登录入口和退出登录操作。
4. 主流程不再依赖设备配对。

### 阶段二：远程 Git 闭环

1. 项目模型增加 `repositoryUrl` 和内部托管路径。
2. 增加 clone、fetch、远程分支解析和安全 push。
3. Worker 执行前同步 `origin`。
4. 审核通过后推送目标分支，成功后再进入完成状态。
5. 补充远程仓库集成测试。

### 阶段三：双部署交付

1. 明确本地和服务器数据目录。
2. 增加多阶段 Dockerfile。
3. 增加 Docker Compose 和环境变量示例。
4. 增加宝塔 Nginx 配置。
5. 增加中文安装、升级、备份和恢复文档。

### 阶段四：验证

1. 类型检查通过。
2. 单元和集成测试通过。
3. 生产构建通过。
4. 使用临时远程裸仓库验证分支创建、快进推送和冲突拒绝。
5. 确认 Markdown、代码注释和界面文案均为中文。

## 15. 首版不做

- DevLoop 注册、登录、管理员账户和多租户。
- 多节点 Worker。
- PostgreSQL、Redis 和 Kubernetes。
- Git HTTP 密码或令牌托管。
- 自动创建 Pull Request。
- 强制推送远程分支。
- 浏览器或手机直接编辑服务器任意文件。
- 手机直接启动任意 Shell 命令。
- 多个客户端各自维护一份数据库并自动合并。

## 16. 验收标准

1. 本地 Electron 安装后无需注册即可使用。
2. 新服务器可以通过 Docker Compose 启动，无需初始化管理员。
3. 每套安装使用自己的 SQLite 和数据目录。
4. 项目通过 SSH Git 地址注册，页面看不到服务器绝对路径。
5. 任务执行前自动拉取远程最新状态。
6. 目标分支不存在时可以从默认分支创建。
7. Codex CLI 在隔离 Worktree 中真实修改文件。
8. 任务取消会终止 CLI，迟到结果不能覆盖状态。
9. 审核通过后安全推送远程目标分支。
10. 远程分支冲突时拒绝强推并给出清晰提示。
11. 手机、浏览器和 Electron 看到同一份实时状态，并能进行受控修改。
12. 重建容器后数据库、仓库、Skill 和运行事件仍然存在。
13. 本机模式只监听回环地址，服务器入口由 Tailscale 或反向代理保护。
14. 全部 Markdown、代码注释和界面文案保持中文。
