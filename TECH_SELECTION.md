# DevLoop 技术选型

## 1. 选型目标

DevLoop 的技术方案需要同时满足：

- 单用户安装后即可使用，不建设账户中心。
- 同一套核心可运行在个人电脑或个人服务器。
- Electron、浏览器和手机共享同一任务事实。
- 客户端关闭后 Worker 继续执行。
- Codex CLI、Git 和文件操作不进入浏览器安全边界。
- 任务状态可以崩溃恢复，并保留完整审计记录。
- 服务器部署不依赖 Redis、PostgreSQL 或 Kubernetes。
- 手机可以修改受控任务内容，但不能执行任意 Shell 或编辑任意文件。

## 2. 总体选型

| 层级 | 选择 |
| --- | --- |
| 仓库 | pnpm Workspace Monorepo |
| 语言 | TypeScript 严格模式 |
| Node.js | Node.js 24 |
| 桌面入口 | Electron |
| Web 与手机入口 | React + Vite + 响应式 PWA |
| 路由 | TanStack Router |
| 服务端状态 | TanStack Query |
| 表单与校验 | React Hook Form + Zod |
| UI 原语 | Radix UI |
| 图标 | Lucide React |
| API Server | Fastify |
| 实时更新 | Server-Sent Events |
| 数据库 | SQLite WAL |
| ORM | Drizzle ORM |
| 状态机 | XState |
| 子进程 | execa + AbortController |
| Git | 系统 Git CLI |
| Agent | Codex CLI，可替换 Runner 接口 |
| 日志 | Pino JSON 日志 |
| 测试 | Vitest，后续增加 Playwright |
| 本地交付 | Electron |
| 服务器交付 | Docker Compose + 宝塔 Nginx |
| 私有访问 | Tailscale 优先 |

## 3. 运行架构

### 3.1 统一 Server 核心

无论本地还是服务器模式，任务事实都位于 DevLoop Server：

```text
客户端
  |
HTTP / SSE
  |
DevLoop Server
├── API
├── Scheduler / Worker
├── SQLite
├── GitService
├── CodexRunner
└── SkillService
```

客户端不直接读取 SQLite，不直接启动 Codex，也不直接访问仓库绝对路径。

### 3.2 本地模式

Electron 是桌面外壳。开发阶段由根目录脚本同时启动 Server、Web 和 Electron；正式打包阶段需要把 Server 作为本地后台进程随应用交付，并把数据目录设置为操作系统应用数据目录。

本地 Server 默认只监听 `127.0.0.1`。手机需要访问时使用 Tailscale 或由用户显式允许局域网监听。

### 3.3 服务器模式

Docker 容器同时运行 API、Scheduler 和单个 Worker，数据写入 `/data`。宝塔 Nginx 只负责域名、HTTPS、SSE 反向代理和外层访问保护。

SQLite 只允许一个 DevLoop Server 实例使用，因此不运行 PM2 集群、不扩展 Compose 副本，也不让多个容器共享同一个数据库文件。

## 4. 身份与网络安全

### 4.1 不建设应用内账户

每套安装只有一个内置身份：

```text
id: instance-owner
name: 实例所有者
role: editor
kind: owner
```

保留角色检查函数是为了维持接口边界，并为未来只读模式留出空间；当前没有注册、登录、管理员表或会话表。

### 4.2 访问保护在实例外部完成

- 本机入口：回环地址。
- 手机入口：Tailscale 优先。
- 公网入口：HTTPS + Basic Auth、IP 白名单或等价保护。
- 容器端口：只绑定宿主机 `127.0.0.1`。
- Git 私钥和 Codex 凭据：通过挂载或环境变量注入，不写入 SQLite 和镜像。

DevLoop 拥有启动 Codex、修改代码和推送 Git 的能力，因此无保护公网暴露不是可接受部署方式。

## 5. 前端

### 5.1 React + Vite

DevLoop 是操作型单页应用，不需要 SEO 或服务端渲染。Vite 构建产物由 Fastify 在生产环境提供，Electron 和浏览器加载同一套页面。

### 5.2 TanStack Router

当前主要路由：

```text
/status
/board
/projects
/skills
/runs
/settings
```

设备配对和登录路由已从主流程移除。

### 5.3 TanStack Query 与 SSE

REST 提供查询和写命令，SSE 提供领域事件。前端收到事件后精确失效项目、任务、Run 或 Skill 查询，不维护第二套业务状态。

任务处于待执行或执行中时仍保留短间隔轮询，作为 SSE 断开时的兜底。

### 5.4 手机能力

手机使用同一响应式页面，可以：

- 编辑草稿任务。
- 修改目标分支和验收条件。
- 取消执行。
- 删除非执行中任务。
- 通过或驳回审核。
- 查看执行日志和结果 Commit。

手机不能：

- 浏览服务器任意目录。
- 读取 Git 私钥或 Codex 凭据。
- 执行任意 Shell。
- 绕过状态机直接改数据库。
- 直接编辑 Worktree 中的任意源码。

## 6. 后端

### 6.1 Fastify

Fastify 承载：

- REST API。
- SSE 长连接。
- Web 静态资源。
- 错误码和输入校验。
- Server 生命周期。

Server、Scheduler 和 Worker 首版在同一进程中，减少部署组件和状态协调成本。

### 6.2 SQLite WAL

SQLite 保存项目、任务、Revision、Run、事件、审核、幂等命令和 Skill 元数据。

选择原因：

- 单用户实例部署简单。
- 不需要额外数据库服务。
- 事务足以完成单 Worker 原子领取。
- 数据目录可以直接备份和迁移。

约束：

- 单实例写入。
- 所有写命令携带预期版本和幂等键。
- 任务删除只做软删除。
- 备份使用停机复制或 SQLite 一致性快照。

### 6.3 Drizzle

Drizzle 负责 Schema、迁移和类型推导。Server 启动时自动执行迁移；迁移文件必须与镜像一起交付。

## 7. Git 执行模型

项目通过 SSH Git 地址注册。Server 在自己的数据目录中维护托管仓库：

```text
<data>/repositories/<project-id>
<data>/worktrees/<run-id>
```

每次运行：

1. 执行 `fetch --prune origin`。
2. 解析远程目标分支。
3. 目标分支不存在时使用远程默认分支作为基线。
4. 固定 `baseCommit`。
5. 创建 `devloop/run/<run-id>` 和独立 Worktree。
6. Codex 只修改该 Worktree。
7. Worker 创建 `resultCommit`。
8. 审核通过后再次 fetch 并安全推送。

推送规则：

- 新分支可以创建。
- 远程分支仍在执行基线时可以快进。
- 远程已包含结果时按幂等成功处理。
- 远程分支独立前进时拒绝推送。
- 永不强制推送。

## 8. Codex Runner

CodexRunner 使用 `codex exec --json`，通过 JSONL 事件更新 SQLite 中的运行事件。

自动化约束：

- 审批策略固定为不交互。
- 沙箱固定为 Worktree 可写。
- 不允许 Codex 创建最终 Git Commit。
- 关闭浏览器、Hooks、插件、多 Agent 等当前任务不需要的能力。
- 保留运行环境中可用的 Codex Provider、原生 Skill 和 MCP 配置。
- 可通过 `DEVLOOP_CODEX_IGNORE_USER_CONFIG=true` 完全忽略用户配置。

自定义 Provider 不使用 `--output-schema`。Prompt 要求返回 AgentResult JSON，DevLoop 在本地解析和校验；首次格式不合格时，只运行一次只读 JSON 修复。

取消执行时 AbortController 终止 Codex，Repository 同时轮换执行令牌，迟到结果无法覆盖已取消状态。

## 9. Skill

DevLoop SkillService 当前提供：

- `SKILL.md` Frontmatter 与正文校验。
- 内容哈希。
- 不可变版本。
- 启用和停用。
- SQLite 元数据与数据目录文件存储。
- Web 编辑和版本历史。

Codex 原生 Skill 与 MCP 由运行环境的 `CODEX_HOME` 提供。DevLoop Skill 注册表与任务级自动装配尚未连接，后续需要增加任务选择、运行输入快照和 Worktree 注入，避免启用状态在执行中途改变。

## 10. 部署

### 10.1 Docker 镜像

多阶段 Dockerfile 构建 Workspace 和 Web 静态文件。运行镜像包含：

- Node.js 24。
- Git 与 OpenSSH 客户端。
- Codex CLI。
- Server 生产代码。
- 数据库迁移。
- AgentResult Schema。
- Web 静态资源。

容器使用 UID `10001` 的非特权用户。

### 10.2 持久化

```text
/data/devloop.db
/data/repositories
/data/worktrees
/data/skills
```

Codex 配置和 Git SSH 凭据独立挂载，便于轮换和备份。Pino 服务日志写到容器标准输出，由 Docker 日志驱动轮转，不写入 `/data`。

### 10.3 宝塔与 SSE

Nginx 反向代理必须设置：

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
```

宝塔不运行第二个 DevLoop 进程，只代理 Compose 暴露在回环地址的端口。

## 11. 测试策略

单元和集成测试覆盖：

- 任务状态转换与五秒领取延迟。
- 草稿 100 分自动入队。
- 取消执行和迟到结果隔离。
- 软删除。
- Codex JSON 本地解析与修复重试。
- Skill 校验和版本。
- Git Worktree 创建与结果 Commit。
- 远程新分支推送和重复推送。
- 远程分支漂移时拒绝覆盖。
- SQLite 迁移和 Repository 幂等命令。

发布前执行：

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Docker 守护进程可用时还需要构建镜像并检查健康接口。

## 12. 当前限制

- 只有一个 Worker。
- 只支持 SSH Git 地址。
- 不自动创建 Pull Request。
- 不管理 Git HTTP Token。
- 不支持多用户和多租户。
- 不支持多节点共享 SQLite。
- Electron 正式安装包中的本地 Server 生命周期管理仍需完成。
- DevLoop Skill 尚未自动装配到任务执行。
- Worker 尚未提供独立验证命令配置与退出码审计。
- 基础容器只保证 Node.js 和 pnpm 工具链。
