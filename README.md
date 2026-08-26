<p align="right"><strong>简体中文</strong> · <a href="./README.en.md">English</a></p>

<a id="top"></a>

<p align="center">
  <img src="./apps/web/public/devloop-mark.svg" width="112" alt="DevLoop 项目标志" />
</p>

<h1 align="center">DevLoop</h1>

<p align="center"><strong>输入目标，托管执行，验收结果</strong></p>

<p align="center"><a href="https://j-da-shi.github.io/devloop/">访问 DevLoop 官网展示 →</a></p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24%2B-1B1B1F?style=flat-square&logo=nodedotjs&logoColor=4F8CFF" alt="Node.js 24+" />
  <img src="https://img.shields.io/badge/pnpm-10-1B1B1F?style=flat-square&logo=pnpm&logoColor=F69220" alt="pnpm 10" />
  <img src="https://img.shields.io/badge/TypeScript-1B1B1F?style=flat-square&logo=typescript&logoColor=4F8CFF" alt="TypeScript" />
  <img src="https://img.shields.io/badge/React-1B1B1F?style=flat-square&logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/Electron-1B1B1F?style=flat-square&logo=electron&logoColor=9FEAF9" alt="Electron" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-4F8CFF?style=flat-square" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#quick-start">
    <img src="https://img.shields.io/badge/从源码启动-DevLoop-4F8CFF?style=for-the-badge&logo=github&logoColor=1B1B1F" alt="从源码启动 DevLoop" />
  </a>
</p>

<p align="center">
  <a href="#why-devloop">为什么是 DevLoop</a> ·
  <a href="#capabilities">能力范围</a> ·
  <a href="#how-it-delivers">如何交付</a> ·
  <a href="#review-gate">审核闸门</a> ·
  <a href="#quick-start">开始使用</a> ·
  <a href="#managed-execution">AI 托管</a> ·
  <a href="#preview-validation">预览与验证</a> ·
  <a href="#local-boundary">本地边界</a> ·
  <a href="#development">开发</a> ·
  <a href="#license">许可</a>
</p>

---

<a id="why-devloop"></a>

## 为什么是 DevLoop

Codex CLI 和 Claude Code CLI 很擅长完成一次开发请求，但用户真正需要的不是持续盯着一次 Agent 会话，而是给出目标和验收标准后，让平台托管预算、执行、重试与验证，最后交付一个可以审核的结果。

DevLoop 是本地优先的 AI 托管交付工作台。它把每次 Agent 执行放进独立 Git Worktree，将结果固定为 Commit，并把预算、失败上下文、Diff、自动验证、冲突和人工审核汇集到同一条任务记录里。你可以同时推进多个项目，只在预算越界或结果验收时介入，并始终由人决定是否写入分支。

<a id="capabilities"></a>

## 能力范围

| 能力       | 支持内容                                                                    |
| ---------- | --------------------------------------------------------------------------- |
| 任务类型   | `DEVELOPMENT` 代码交付、`RESEARCH` 结构化研究                               |
| 项目来源   | SSH 远程仓库，或桌面上已经存在的本地 Git 目录                               |
| 执行器     | Codex CLI、Claude Code CLI、Fake Runner；Worker 并发数可配置为 1-10         |
| 上下文     | Skill 版本快照、Revision、失败上下文、驳回后的连续迭代                      |
| Agent 分工 | 规划、执行、验收三个职责阶段；计划和验收报告随 Run 持久化                   |
| 托管执行   | 创建时估算预算，80% 预警，硬上限自动暂停，失败退避重试并从 Git 检查点恢复   |
| 交付控制   | 隔离 Worktree、结果 Commit、逐文件 Diff、冲突预览、人工或 Agent 协助解决    |
| 自动验证   | 自动识别常见 Web 启动方式、隔离预览、Playwright、截图、控制台错误和交互结果 |

<a id="how-it-delivers"></a>

## 从任务到分支

```text
任务目标与验收标准
          |
          v
预算范围 + 硬上限
          |
          v
规划 Agent → 执行 Agent → 验收 Agent（共享同一隔离 Worktree）
          |
          v
结果 Commit + Diff + 执行日志
          |
          +---- Web 项目：隔离预览 + Playwright + 截图
          |
          v
人工审核 / 冲突解决
          |
          v
应用并推送目标分支，或以本轮结果继续迭代
```

每个项目可选择 Codex CLI 或 Claude Code CLI；Worker 可配置 1-10 个并发任务。开发任务在独立 Worktree 中运行，研究任务则以结构化结论进入审核。DevLoop 还会保存任务 Revision、Skill 快照和运行事件，让后续追溯不依赖某次终端输出。

托管模式下，三个职责阶段由同一个项目 Runner（Codex CLI、Claude Code CLI 或 Fake Runner）按顺序执行：规划 Agent 只读分析并输出计划和规划验收标准，执行 Agent 根据计划修改 Worktree，验收 Agent 只读检查 Diff、测试以及原始和规划阶段的验收标准。验收失败或漏检任一标准时，报告会回传给执行 Agent 在当前 Run 内修复并重新验收，默认最多修复 3 轮；仍未通过或被阻塞时才结束本轮，不能进入待审核。

<a id="review-gate"></a>

## 审核是交付闸门

| 阶段 | DevLoop 负责什么                                         | 人负责什么                 |
| ---- | -------------------------------------------------------- | -------------------------- |
| 规划 | 读取项目和目标，拆解实施步骤、细化规划验收标准并记录计划 | 定义目标、验收标准和执行器 |
| 执行 | 根据计划调度 CLI、修改 Worktree、生成结果 Commit         | 定义目标、验收标准和执行器 |
| 验证 | 启动隔离预览、运行 Playwright、保存截图与检查结果        | 判断产品行为是否符合预期   |
| 验收 | 独立核对 Diff、测试和每条验收标准，形成验收报告          | 判断是否批准交付           |
| 审核 | 展示文件列表、补丁、冲突和 Agent 解决结果                | 批准、驳回，或手动解决冲突 |
| 写入 | 校验目标分支状态后应用并安全推送                         | 决定何时让结果进入目标分支 |

若目标分支在执行期间发生变化，DevLoop 会生成冲突预览。你可以在页面中处理冲突，也可以让 Agent 先生成解决方案再审核；未处理的冲突不能写入目标分支。驳回后的下一轮会以上一轮结果 Commit 为基础，再对齐最新目标分支继续执行。

<a id="quick-start"></a>

## 开始使用

### 从源码启动

需要 Node.js 24（`>=24 <27`）、pnpm 10，以及至少一个已安装并登录的执行器：`codex` 或 `claude`。先确认 CLI 可以在当前终端使用：

```bash
codex --version
claude --version
```

没有 CLI 时也可以使用内置 Fake Runner 检查界面和状态流转。

```bash
git clone https://github.com/J-Da-Shi/devloop.git
cd devloop
pnpm install
pnpm dev
```

`pnpm dev` 会启动本地服务、Web 页面和 Electron 客户端。只需浏览器界面时运行：

```bash
pnpm dev:web
```

然后访问 `http://127.0.0.1:5173`。若只想检查界面和状态流转，可使用内置模拟执行器：

```bash
DEVLOOP_RUNNER=fake pnpm dev:web
```

### 桌面打包

在 macOS 上生成 dmg / zip：

```bash
pnpm --filter @devloop/desktop make
```

产物位于 `apps/desktop/out/make/`。打包客户端默认启动内置服务；设置 `DEVLOOP_SERVICE_URL` 后可改为连接已有服务。

打包会自动清理旧的 workspace 编译产物，只携带当前平台所需的生产依赖、Web 构建文件和数据库迁移；无需手动维护 `apps/desktop/runtime-bundle/`。

### Docker Compose

服务端部署需要 Docker、Docker Compose，以及可写的数据和配置目录：

```bash
cp .env.example .env
mkdir -p data config/codex config/ssh
docker compose up --build
```

启动后访问 `http://127.0.0.1:4317`。默认只绑定本机地址；私有仓库需要把 SSH 配置放入 `config/ssh`，Codex 配置或凭据放入 `config/codex`，也可以在 `.env` 中改为其它挂载目录。

### 注册项目与创建任务

在项目页可以选择 SSH 远程仓库，也可以直接选择桌面上已有的本地 Git 目录。创建任务时填写标题、任务类型、目标分支、任务目标和验收标准，再选择 Codex 或 Claude、是否自动解决冲突以及其它项目级设置。任务默认使用 AI 托管模式：平台根据目标估算时间与金额，展示自动停止上限，并在失败后退避重试；达到硬上限时保存 Git 检查点并进入“预算已暂停”，提高上限后可继续。审核通过前，结果只存在于隔离 Worktree 和结果 Commit 中。

<a id="managed-execution"></a>

## AI 托管执行

创建任务时可以选择两种执行方式：

- `AI 托管`（默认）：平台负责预算估算、执行监控、失败重试、检查点恢复和预算保护，用户主要处理目标输入、越界决策和最终验收。
- `标准执行`：保留单轮 Agent 执行与人工审核流程，不启用托管预算和自动重试。

托管任务会按以下闭环运行：

| 阶段       | DevLoop 的处理                                                                |
| ---------- | ----------------------------------------------------------------------------- |
| 创建任务   | 根据任务类型、目标和验收标准给出时间范围、金额范围、置信度与建议硬上限        |
| 执行中     | 在隔离 Worktree 运行所选 Runner，按运行时长记录估算消耗，并在默认 80% 时预警  |
| 执行失败   | 尝试保存当前 Git 检查点和失败上下文，按退避策略自动创建下一轮 Revision        |
| 达到上限   | 取消当前 Runner，保存已有结果，将 Task 和 Run 置为 `BUDGET_PAUSED`            |
| 调整后继续 | 用户提高硬上限或缩小目标后重新确认，下一轮从最近检查点和已有上下文继续        |
| 完成       | 固化结果 Commit，执行冲突检查和可用的预览验证，然后进入待审核，不自动写入分支 |

设置页可以调整单任务最高预算、预警比例、预算余量、失败自动重试次数，以及 Codex 和 Claude Code 的小时估算费率。CLI 的“连续无输出超时”只用于识别异常停滞，不是任务总执行时限，正常的长任务不会因为运行时间较长而被提前终止。

当前金额由 Runner 实际运行时长和配置费率估算，不等同于模型提供商账单。首次预算预测使用任务特征启发式计算，复杂度不明确时会标记为低置信度并倾向保守；执行后的实际估算消耗应作为调整后续硬上限和费率的依据。

<a id="preview-validation"></a>

## 预览与自动验证

大多数项目不需要手动填写预览命令。DevLoop 按“项目高级覆盖 → Agent 返回的 Web 启动建议 → 结果 Commit 的 `package.json` 自动识别”确定预览方式，保守支持 Vite、Next.js、Nuxt、Astro、SvelteKit、Remix、Webpack、Parcel 与 Storybook 的常见脚本。若高级配置实际指向 `concurrently`、Electron 等多进程或桌面聚合脚本，DevLoop 会跳过该命令并自动寻找单独的 Web 启动入口。

预览从结果 Commit 的隔离 Worktree 启动，并根据最近的 `pnpm-lock.yaml`、`package-lock.json`、`yarn.lock` 或 Bun 锁文件安装依赖。服务就绪后，DevLoop 会检查页面加载与控制台错误、生成截图，并可执行项目自定义的 Playwright 命令。审核页可直接在桌面独立窗口或浏览器中打开预览。

需要自动截图时安装 Chromium：

```bash
pnpm exec playwright install chromium
```

也可设置 `DEVLOOP_PLAYWRIGHT_EXECUTABLE` 指向兼容的 Chrome、Chromium 或 Edge。没有可控浏览器时，任务仍会进入审核，页面会显示跳过原因。

<a id="local-boundary"></a>

## 本地运行边界

- DevLoop 默认只监听 `127.0.0.1`，没有注册、登录或多租户服务。
- 数据库、Git 镜像、Worktree、Skill 与运行产物存放在 `DEVLOOP_DATA_DIR`；开发模式默认是仓库内 `.devloop-data`，打包应用使用系统应用数据目录。
- 预览和 Playwright 进程不会继承 DevLoop 的 API Key、Git Token 等敏感环境变量，只保留启动 Web 所需的公开变量。
- 审核通过前不会写入目标分支，也不会强制推送。
- 如需局域网或服务器部署，必须在外层部署 HTTPS、访问控制和网络隔离；不要直接暴露 `4317` 端口。

常用服务端配置：

```bash
# 网络与本地数据目录。
DEVLOOP_HOST=127.0.0.1
DEVLOOP_PORT=4317
DEVLOOP_ALLOW_LAN=false
DEVLOOP_REPOSITORY_ROOT=/path/to/repositories
DEVLOOP_DATA_DIR=.devloop-data

# 默认执行器和可执行文件路径；项目任务仍可选择 Codex 或 Claude。
DEVLOOP_RUNNER=codex
DEVLOOP_CODEX_EXECUTABLE=codex
DEVLOOP_CLAUDE_CODE_EXECUTABLE=claude

# CLI 连续无输出多久后终止；不是任务总执行时限。
DEVLOOP_CODEX_STALL_TIMEOUT_MS=1800000
DEVLOOP_CLAUDE_CODE_STALL_TIMEOUT_MS=1800000
DEVLOOP_AGENT_CLAIM_DELAY_MS=5000
DEVLOOP_FAKE_RUNNER_DELAY_MS=850
DEVLOOP_LOG_LEVEL=info

# 隔离预览与 Playwright 的超时设置。
DEVLOOP_PREVIEW_STARTUP_TIMEOUT_MS=90000
DEVLOOP_PREVIEW_DEPENDENCY_INSTALL_TIMEOUT_MS=600000
DEVLOOP_PLAYWRIGHT_TIMEOUT_MS=60000
DEVLOOP_PLAYWRIGHT_TEST_TIMEOUT_MS=600000
DEVLOOP_PLAYWRIGHT_EXECUTABLE=/path/to/chromium
```

Docker Compose 的完整示例及每个变量的注释见 [`.env.example`](./.env.example)，服务器反向代理示例见 [`deploy/baota-nginx.conf`](./deploy/baota-nginx.conf)。

<a id="development"></a>

## 开发

DevLoop 使用 pnpm workspace：Fastify 服务端、React Web、Electron 桌面端，以及数据库、Git、Runner 和共享模型包。

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
pnpm format
git diff --check
```

Pull Request 会在 Node.js 24 和 26 上执行 packages build、类型检查、Vitest、ESLint、Prettier 与空白错误检查，并分别验证 Server、Web 构建和 Desktop 类型检查。高危依赖变更会被依赖审查阻止；pnpm 与 GitHub Actions 依赖每周检查更新。

目录职责：`apps/server` 提供 API 和 Worker，源码按 `agent`、`preview`、`skills`、`routes`、`config` 和 `infrastructure` 分组；`apps/web` 提供 React 界面，`apps/desktop` 提供 Electron 客户端。`packages/context` 按压缩、LLM 和存储分组，`packages/db` 按数据库、预算和仓储分组，`packages/git` 按命令、服务和类型分组，`packages/runners` 按适配器、执行、输出、提示词和类型分组；`packages/shared` 承载共享模型。开发约定见 [`AGENTS.md`](./AGENTS.md)。

欢迎提交 Issue 和 Pull Request。请勿提交 API Key、Git 凭据、`.devloop-data` 中的个人数据，或任务生成的本地运行产物。

<a id="license"></a>

## 许可

DevLoop 采用 [MIT License](./LICENSE) 开源。

## 致谢

感谢 Codex CLI、Claude Code、Electron、Fastify、Drizzle、Playwright 及本项目使用的开源软件。

<p align="right"><a href="#top">返回顶部 ↑</a></p>
