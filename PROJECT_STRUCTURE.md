# DevLoop 项目目录说明

## 1. 为什么目录看起来很多

当前仓库采用 pnpm Workspace Monorepo，将可以独立运行的程序放在 `apps`，将可复用的代码放在 `packages`。

目录数量主要来自两部分：

- `desktop`、`web`、`server` 具有真实的运行和安全边界。
- 数据库、Git、Runner 和 Workflow 按长期架构提前拆成了独立 Workspace 包。

第一部分有保留价值，第二部分对当前 MVP 来说拆分得偏早，可以适当合并。

## 2. 必须保留的运行边界

```text
Electron 客户端
├── desktop：窗口和受控的系统能力
└── web：桌面端与手机端共用的用户界面
        │ HTTP / SSE
        ▼
server：文件、Git、SQLite 和 Codex CLI
```

浏览器页面不能直接启动 Codex CLI，也不能任意访问本地文件。因此，本地文件、Git、数据库和命令执行能力必须位于 Server 或 Electron 主进程中，不能直接放进 Web 页面。

手机端同样只连接本机 Server，不直接连接 Electron，也不直接操作本地文件系统。

## 3. apps 目录

| 目录           | 当前职责                                                | 判断         |
| -------------- | ------------------------------------------------------- | ------------ |
| `apps/desktop` | Electron 主进程、窗口、菜单、原生目录选择和安全 Preload | 应当独立保留 |
| `apps/web`     | React 页面，同时服务于 Electron 和手机 Web/PWA          | 应当独立保留 |
| `apps/server`  | 本机 API、实时事件、任务调度和 Worker 生命周期          | 应当独立保留 |

这三个目录分别对应桌面壳、用户界面和本机后台服务。即使精简项目，也不建议把它们合并成一个目录。

## 4. packages 目录

| 目录                | 当前职责                                          | 当前判断                             |
| ------------------- | ------------------------------------------------- | ------------------------------------ |
| `packages/shared`   | Web 与 Server 共用的领域类型、状态和 Zod 校验规则 | 应当独立保留                         |
| `packages/db`       | SQLite、Drizzle Schema 和 Repository              | 当前可以并入 Server                  |
| `packages/git`      | Git 仓库检测与 Git 命令封装                       | 规模较小，拆分偏早                   |
| `packages/runners`  | Codex Runner、Fake Runner 和 Runner 接口          | 当前可以并入 Server                  |
| `packages/workflow` | 任务状态机与状态转换                              | 当前代码很少，且尚未形成独立使用边界 |

目前只有 `shared` 同时被 Web 和 Server 使用。`db`、`git`、`runners` 和 `workflow` 基本都只有 Server 一个消费者，因此暂时不需要承担独立 Workspace 的构建和维护成本。

## 5. 不属于业务拆分的目录

以下目录虽然会出现在编辑器中，但不代表系统又增加了一层架构：

- `node_modules`：pnpm 为各 Workspace 建立的依赖链接。
- `dist`：TypeScript 或 Vite 生成的构建结果，可以重新生成。
- `design-system`：界面设计规范和视觉约束。
- `schemas`：Codex 等 Agent 结构化输出使用的 JSON Schema。
- 根目录的 Markdown 文件：开发方案、技术选型和项目说明文档。

在编辑器中可以隐藏 `node_modules` 和 `dist`，让目录树更容易阅读。

## 6. 当前建议的精简结构

当前阶段建议收缩为三个应用和一个共享包：

```text
devloop/
├── apps/
│   ├── desktop/
│   ├── web/
│   └── server/
│       └── src/
│           ├── db/
│           ├── git/
│           ├── runners/
│           └── workflow/
├── packages/
│   └── shared/
├── schemas/
├── DEVELOPMENT_PLAN.md
├── PROJECT_STRUCTURE.md
└── TECH_SELECTION.md
```

这样可以将当前 8 个 Workspace 收缩为 4 个，同时继续维持 Electron、Web、Server 之间必要的安全边界。

## 7. 什么时候再拆成独立 package

满足以下任一条件时，再将 Server 内部模块拆为独立 package 更合适：

- 同一个模块开始被两个或更多应用使用。
- 模块需要独立发布、独立版本或独立构建。
- 模块具有稳定的公共接口，并且内部实现需要被隔离。
- 出现独立 Worker、插件系统、CLI 或其他服务，需要复用相同能力。

在这些条件出现以前，优先使用 Server 内部目录能够减少配置、构建和依赖管理成本。

## 8. 结论

当前整体架构方向没有问题，但包级拆分超前于实际规模。`desktop`、`web`、`server` 和 `shared` 应继续保留；`db`、`git`、`runners` 和 `workflow` 更适合作为 Server 内部模块，等出现真实的复用边界后再拆分。
