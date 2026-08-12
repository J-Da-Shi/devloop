# DevLoop

DevLoop 是一个本地优先的无人值守开发任务编排系统。Electron 桌面客户端是主要交互入口，独立的本机后台服务负责调度任务、创建 Git 工作树、调用 Codex 或其他编程智能体、运行验证命令并生成可审计的结果包。用户还可以通过手机 Web/PWA 查看执行状态，并在授权范围内修改任务或提交审核操作。

## 产品定位

- Electron Desktop 是主要交互入口，负责项目选择、权限配置、Codex 检测和本机管理。
- 本机 DevLoop Service 是任务和执行状态的唯一事实来源。
- 手机 Web/PWA 是远程查看和受控操作入口，不直接访问本地文件或启动 CLI。
- Codex CLI、Claude Code 等工具作为可替换的 Agent Runner。
- 用户只在任务确认和结果审核两个阶段参与。
- Electron 窗口、手机页面或 Codex 客户端关闭后，后台 Worker 仍可继续运行。
- MVP 通过同一局域网或 Tailscale 提供手机访问，不直接暴露公网端口。

## 方案文档

- [开发方案](./DEVELOPMENT_PLAN.md)
- [技术选型](./TECH_SELECTION.md)
- [项目目录说明](./PROJECT_STRUCTURE.md)

## 当前状态

当前已经具备 Electron 桌面客户端、响应式 Web/PWA、本机 Service、SQLite、固定 Workflow、自动领取任务的 Agent Worker 和真实 Codex Runner。任务执行时会创建独立 Git Worktree，通过 `codex exec` 修改代码，实时记录 JSONL 事件，并在成功后生成可审核的结果 Commit。Electron 是本机主要入口，手机继续使用相同页面连接本机 Service。

## 本地启动

启动桌面客户端、本机服务和 Web 开发服务：

```bash
pnpm dev
```

只启动本机服务与浏览器入口：

```bash
pnpm dev:web
```

桌面客户端通过安全 Preload 暴露目录选择能力，页面不能直接访问 Node.js、任意本地文件或执行任意命令。

## 执行器配置

默认使用本机已经登录的 Codex CLI：

```bash
pnpm dev
```

仅测试页面和状态流转时，可以显式切换回模拟执行器：

```bash
DEVLOOP_RUNNER=fake pnpm dev
```

可选环境变量：

```text
DEVLOOP_RUNNER=codex
DEVLOOP_CODEX_EXECUTABLE=/absolute/path/to/codex
DEVLOOP_CODEX_IGNORE_USER_CONFIG=false
DEVLOOP_CODEX_TIMEOUT_MS=1800000
```

真实执行器默认读取本机 Codex 的模型和 Provider 配置，以兼容自定义服务；DevLoop 会覆盖审批、沙箱和环境继承策略，并关闭浏览器、插件、Hooks 等非开发必需能力。需要完全忽略本机配置时，可设置 `DEVLOOP_CODEX_IGNORE_USER_CONFIG=true`，此时还会启用严格配置校验。

创建任务时需要指定目标分支，默认使用项目的默认分支。真实执行器会先读取目标分支最新 Commit；目标分支不存在时，以项目默认分支为执行基线。每次 Run 使用 `.devloop-data/worktrees/<run-id>` 下的独立工作树，成功后保留 `devloop/run/<run-id>` 内部分支供审核，不会在执行过程中直接修改当前主工作区。审核通过后，可以在本机任务详情中点击“写入目标分支”：分支不存在时自动创建，分支已存在时通过三方应用保留其后续修改。目标分支未检出时只原子更新分支引用；目标分支正在当前项目目录检出时同步更新目录文件；发生冲突时不会留下半成品。

## 计划目录

```text
devloop/
├── apps/
│   ├── desktop/
│   ├── web/
│   └── server/
├── packages/
│   ├── db/
│   ├── git/
│   ├── runners/
│   ├── shared/
│   └── workflow/
├── schemas/
├── scripts/
├── DEVELOPMENT_PLAN.md
└── TECH_SELECTION.md
```
