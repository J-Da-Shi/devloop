# DevLoop

DevLoop 是一个单用户、自托管的开发任务执行系统。它在用户自己的电脑或服务器上运行 Codex CLI，管理任务队列、Git Worktree、结构化验收结果和审核推送；Electron、桌面浏览器和手机浏览器只是同一实例的不同入口。

## 部署模式

### 本地模式

```text
Electron / 本机浏览器
          |
       127.0.0.1
          |
本机 DevLoop Server
├── Codex CLI
├── SQLite（任务与运行事件）
├── Git 仓库与 Worktree
└── Skill
```

开发环境的数据默认保存在项目内 `.devloop-data`。正式 Electron 安装将使用操作系统应用数据目录。

### 个人服务器模式

```text
Electron / 桌面浏览器 / 手机
                 |
       Tailscale 或 HTTPS
                 |
        用户自己的 DevLoop Server
        ├── Codex CLI
        ├── SQLite（任务与运行事件）
        ├── Git 仓库与 Worktree
        └── Skill
```

Docker 部署的数据保存在服务器的 `/data` 持久化卷。更换电脑时只需连接原服务器，不需要复制浏览器数据。

## 访问边界

DevLoop 不提供注册、登录、管理员账户或多租户。所有请求使用内置的“实例所有者”身份。

这意味着服务入口必须由部署环境保护：

- 本地模式只监听 `127.0.0.1`。
- 手机访问优先使用 Tailscale。
- 宝塔公网入口必须启用 HTTPS，并增加 Basic Auth、IP 白名单或其他外层保护。
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
- 执行中的任务可取消，并阻止迟到结果覆盖状态。
- 非执行中任务可软删除，历史记录继续保留。
- 审核通过后安全推送远程目标分支，不进行强制推送。
- 管理版本化的 DevLoop Skill 内容。
- 读取运行环境中 Codex 已有的 Provider、原生 Skill 和 MCP 配置。

DevLoop Skill 注册表当前负责内容校验、版本和启停管理；任务级 Skill 选择与自动装配仍属于后续执行链路工作。

当前 Worker 会校验 Codex 最终 JSON 并创建结果 Commit，但还没有独立验证命令配置。独立测试命令及退出码审计属于下一阶段。

## 本地开发

要求 Node.js 24 和 pnpm 10。

安装依赖：

```bash
pnpm install
```

启动 Electron、Server 和 Web：

```bash
pnpm dev
```

只启动 Server 和 Web：

```bash
pnpm dev:web
```

默认调用当前用户已经可用的 Codex CLI。只测试页面和任务状态时使用模拟执行器：

```bash
DEVLOOP_RUNNER=fake pnpm dev:web
```

常用配置：

```text
DEVLOOP_RUNNER=codex
DEVLOOP_CODEX_EXECUTABLE=/absolute/path/to/codex
DEVLOOP_CODEX_IGNORE_USER_CONFIG=false
DEVLOOP_CODEX_TIMEOUT_MS=1800000
DEVLOOP_AGENT_CLAIM_DELAY_MS=5000
DEVLOOP_DATA_DIR=.devloop-data
```

## 服务器部署

项目已经提供：

- [Dockerfile](./Dockerfile)
- [Docker Compose](./compose.yaml)
- [环境变量示例](./.env.example)
- [宝塔 Nginx 模板](./deploy/baota-nginx.conf)
- [完整部署说明](./DEPLOYMENT.md)

基本启动命令：

```bash
mkdir -p data config/codex config/ssh
cp .env.example .env
docker compose up -d --build
```

部署前必须先配置 Codex 凭据和 Git SSH Deploy Key。

## 项目文档

- [开发方案](./DEVELOPMENT_PLAN.md)
- [技术选型](./TECH_SELECTION.md)
- [项目目录说明](./PROJECT_STRUCTURE.md)
- [服务器部署说明](./DEPLOYMENT.md)

## 验证命令

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```
