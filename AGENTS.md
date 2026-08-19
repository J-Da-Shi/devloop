# DevLoop Agent 工作规范

本文件适用于在 DevLoop 仓库中执行开发、修复、重构、审核、测试和文档同步任务的所有 Agent。规范以当前代码为准；如果代码与文档描述不一致，先核对实现和测试，再决定修改范围。

## 项目概览

DevLoop 是一个本地优先的 AI 开发交付工作台。它把 Codex CLI、Claude Code CLI 或 Fake Runner 放进隔离 Git Worktree，记录任务 Revision、执行事件、结果 Commit、Diff、预览验证和人工审核，再由用户决定是否写入目标分支。

项目支持：

- `DEVELOPMENT` 代码开发任务和 `RESEARCH` 研究任务。
- SSH 远程仓库和桌面上已有的本地 Git 目录。
- 可配置 1-10 个 Worker 并发执行任务。
- Skill 快照、失败上下文、连续迭代和驳回后的上下文恢复。
- 隔离预览、Playwright、截图、控制台错误和交互测试结果。
- 冲突预览、人工解决，以及交给 Agent 生成解决方案后再审核。
- Web 浏览器、Electron 桌面端、Docker Compose 服务端部署。

运行环境要求：Node.js `>=24 <27`，pnpm `10.24.0`。需要真实执行任务时，还要在运行环境中安装并登录 `codex` 或 `claude`；只检查界面和状态流转时可使用 `DEVLOOP_RUNNER=fake`。

不要提交 API Key、Git 凭据、个人目录、`.devloop-data` 中的数据、预览产物或桌面打包产物。

## 架构与目录职责

| 路径                                | 职责                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| `apps/server/src/`                  | Fastify API、Worker 调度、任务执行、预览、Playwright 验证和运行时配置 |
| `apps/web/src/`                     | React Web 界面、路由、API 客户端、页面和业务组件                      |
| `apps/web/src/components/common/`   | 与具体业务无关的通用 UI 和交互组件                                    |
| `apps/web/src/components/layout/`   | 应用壳、固定 Header、侧边菜单和页面布局                               |
| `apps/web/src/components/business/` | 项目、任务、运行记录、审核、冲突和验证等业务组件                      |
| `apps/web/src/core/`                | API、状态、Diff、事件和浏览器端基础能力                               |
| `apps/web/src/routes/`              | 路由定义和路由遍历入口；新增页面先更新路由数组                        |
| `apps/web/src/types/`               | Web 端共享类型；不要在页面中重复定义跨组件类型                        |
| `apps/web/src/styles/`              | SCSS、设计令牌和按职责拆分的样式文件                                  |
| `apps/desktop/src/main/`            | Electron 主进程、内置服务生命周期和窗口管理                           |
| `apps/desktop/src/preload/`         | 主进程与渲染进程之间的最小安全桥接                                    |
| `packages/db/`                      | SQLite、Drizzle schema、迁移和仓储实现                                |
| `packages/git/`                     | Git 仓库、镜像、Worktree、Diff、冲突和分支写入操作                    |
| `packages/runners/`                 | Codex、Claude、Fake Runner 适配和执行结果类型                         |
| `packages/workflow/`                | 任务状态流转、状态守卫和工作流规则                                    |
| `packages/shared/`                  | 服务端、Web 和 Runner 共同使用的领域模型、Schema 和常量               |
| `schemas/`                          | Agent 结果 JSON Schema 等外部契约                                     |
| `docs/`                             | 官网静态页面、截图和展示资源                                          |
| `deploy/`                           | 反向代理和部署示例                                                    |

核心执行链是：创建任务 → 创建隔离 Worktree → Worker 领取任务 → Runner 执行 → 生成结果 Commit → 自动预览/验证 → 待审核 → 批准写入、驳回迭代或解决冲突。任何写入目标分支的操作都必须经过状态校验，并且不能绕过未解决冲突检查。

## 常用命令

```bash
# 安装和启动
pnpm install
pnpm dev                 # 启动 server、web 和 Electron
pnpm dev:web             # 只启动 server 和 Web
DEVLOOP_RUNNER=fake pnpm dev:web

# 构建和类型检查
pnpm packages:build      # 先构建 packages
pnpm build               # 构建所有 workspace
pnpm typecheck           # packages 构建后执行全 workspace 类型检查

# 质量检查
pnpm test                # Vitest 全量测试
pnpm test:watch          # Vitest 监听模式
pnpm lint                # ESLint
pnpm format              # Prettier 检查
pnpm format:write        # Prettier 写入格式
git diff --check

# 数据库
pnpm db:generate         # 生成 Drizzle migration
pnpm db:studio

# 桌面端
pnpm --filter @devloop/desktop build
pnpm --filter @devloop/desktop typecheck
pnpm --filter @devloop/desktop make

# 预览官网或 Web 构建产物
python3 -m http.server 4173 --directory docs
pnpm --filter @devloop/web preview
```

修改哪一层，就运行与影响范围相称的检查。跨包契约、数据库、Worker、Runner、状态流转或审核写入逻辑变更时，至少运行 `pnpm packages:build`、`pnpm typecheck`、相关测试和 `pnpm lint`。只修改 Markdown 或官网静态页面时，运行 Prettier、`git diff --check`，并检查桌面和移动视口布局。

## 开发约定

### 通用代码规范

- 先阅读与任务直接相关的源码、类型和测试，再决定修改方式；不要用方案文档替代代码事实。
- 遵循现有架构、命名、依赖和错误处理方式，优先复用已有模块，避免无关重构。
- 每个手写源码文件不得超过 700 行。新增或修改后可能超出限制时，必须按清晰职责拆分；已经超限的文件被修改时，也应在本次改动中拆分到限制以内。
- 文件名必须准确反映内容和职责，使用项目既有命名风格。禁止使用含义模糊的 `utils`、`helpers`、`common`、`misc`、`new` 等名称作为新模块名；通用能力也应使用具体领域或用途命名。
- 一个模块只承担内聚职责。页面、业务流程、数据访问、Runner 适配、类型定义和可复用 UI 应按职责拆分。
- 注释一律使用中文，并说明“为什么”而不是复述代码；没有必要时不要添加注释。
- TypeScript 保持严格类型，不使用无依据的 `any`、非空断言或隐式类型逃逸来掩盖问题。
- 对外输入、文件路径、命令参数、环境变量和持久化数据必须校验；错误信息应包含可操作的原因。
- 不引入未使用的依赖、导出、代码或配置；除非任务需要，不修改生成文件、构建产物和锁文件。
- 每次开发完成后，根据开发内容判断是否需要同步更新 `README.md`、`README.en.md` 和官网 `docs/`。

### Web 前端

- 使用 React、Ant Design 和项目已有的图标库；不要重新引入 Radix UI 或另建一套基础控件。
- 页面布局遵循固定 Header、侧边菜单和右侧内容区域内部滚动；不要让整个页面因为业务列表或日志无限撑高。
- 通用组件放在 `components/common/`，布局组件放在 `components/layout/`，业务组件放在 `components/business/<领域>/`，页面只负责组合和数据协调。
- 路由集中放在 `routes/`，用定义数组遍历注册；不要在多个入口重复维护路由分支。
- 跨组件、跨页面和 API 契约类型统一放在 `apps/web/src/types/` 或 `packages/shared/`，不要在页面内复制类型。
- 样式使用现有 SCSS 结构和设计令牌；新增样式按页面、组件或领域拆分，避免继续增长单一全局样式文件。
- 按钮、弹框、表单、表格、Tabs、通知和加载状态要使用 Ant Design 的语义组件，并补齐禁用、错误、空数据和加载状态。
- 变更用户可见文字时，检查桌面和移动视口，确保文字不溢出、不遮挡、不把固定区域顶开。
- 新增或修改交互时，优先补充组件测试或端到端检查；至少手动验证关键路径和键盘焦点。

### 服务端、Worker 与 Runner

- API 路由只负责输入解析、鉴权边界、调用领域服务和返回结果；复杂业务放到独立服务或仓储模块。
- Worker 的领取、并发、取消、重试和进程组终止必须保持可观测；不要吞掉 AbortSignal、退出码或原始日志。
- Runner 适配必须通过 `packages/runners` 的统一接口，Codex、Claude 和 Fake Runner 不得在页面或 API 路由中直接调用。
- CLI 的“无输出停滞时间”不是任务总时限。除非检测到异常、死循环、取消或配置的停滞超时，否则不要提前终止正常执行。
- 执行结果、失败上下文、Skill 快照和 Revision 要保持可追溯；重试和连续迭代不能丢失上一轮结果 Commit。
- 预览与 Playwright 运行在结果 Commit 的隔离环境中，不要把 DevLoop 的密钥、Token 或私有环境变量透传给项目进程。

### Git、冲突与审核

- 所有任务执行都在隔离 Worktree 中进行；不要直接在目标分支工作或覆盖用户未提交修改。
- 结果必须以 Commit、Diff 和执行事件的形式记录，审核前不得写入目标分支。
- 目标分支变化、索引冲突或 Worktree 状态异常时，应返回明确的冲突信息，不要强制覆盖或自动 reset 用户内容。
- 未解决的冲突必须阻止写入接口；冲突预览、人工编辑和 Agent 解决方案都要经过再次校验。
- 审核驳回后的下一轮应以上一轮结果 Commit 为基础，对齐最新目标分支后继续执行，并保留失败/驳回意见作为上下文。
- 禁止在没有用户明确授权的情况下执行 `git reset --hard`、`git clean -fd`、强制推送或批量删除。

### 数据库与共享契约

- schema、migration、仓储和共享 Schema 必须一起考虑；数据库结构变更要补 migration 和对应测试。
- 迁移文件按 Drizzle 现有方式生成，不手写与 schema 不一致的快照或 journal。
- API 返回体、SSE 事件、Agent 结果 Schema 和前端类型必须保持兼容；修改契约时同步更新消费方和测试。
- 时间、路径、状态枚举、任务类型和 Runner ID 使用共享类型或常量，不在多个包中重复写字符串。

## 测试与验证要求

1. TypeScript、Web、服务端或共享包变更：运行 `pnpm packages:build`、`pnpm typecheck` 和相关 Vitest 测试。
2. API、Worker、Runner、Git 或状态流转变更：运行对应包测试，并覆盖取消、失败、重试、冲突和并发边界。
3. 数据库 schema 或仓储变更：运行 migration 相关测试、仓储测试和全量类型检查。
4. Web UI 变更：运行 `pnpm lint`、Prettier 检查，并在桌面和移动视口验证固定布局、内部滚动、弹框和关键交互。
5. 官网 `docs/` 变更：使用静态服务器检查资源路径、导航、图片、响应式布局和 `prefers-reduced-motion`；不要把临时截图或服务器产物提交进仓库。
6. Electron 主进程、preload 或打包脚本变更：运行桌面端类型检查；需要时执行 `pnpm --filter @devloop/desktop make`。
7. 无法运行某项检查时，说明具体原因和未覆盖范围，不要把未执行写成已通过。

## Git 与交付边界

- 开始工作前检查当前分支和工作区，保留用户已有的未提交改动；不要还原、删除或覆盖无关文件。
- 新需求使用独立分支，分支名应体现领域和目的，例如 `feature/task-iteration` 或 `docs/readme-refresh`。
- 提交信息使用清晰的动词和范围，说明实际行为变化；不要把无关格式化、构建产物或个人配置混入提交。
- 用户要求提交或推送时，先检查 diff、测试和分支目标，再执行非破坏性的 Git 操作；没有明确要求时不要擅自提交或推送。
- 不提交 `.devloop-data/`、`apps/*/dist/`、`apps/desktop/out/`、本地预览目录、密钥、Token、SSH 私钥和个人路径。

## 安全与禁止事项

- 默认服务只监听 `127.0.0.1`；启用局域网或服务器监听时必须同时配置访问控制、HTTPS 和网络隔离。
- 不要把 API Key、Git Token、CLI 登录状态或系统环境变量写入日志、截图、测试夹具、README 或官网。
- 不要从目标项目执行未经用户授权的破坏性命令，不要把宿主机敏感目录挂载给预览进程。
- 不要为了让检查通过而关闭类型检查、删除测试、放宽冲突校验或吞掉异常。
- 不要读取或修改与当前任务无关的方案、个人数据和外部项目文件；若任务明确要求参考其他项目的规范，只读取必要的规范文件。
