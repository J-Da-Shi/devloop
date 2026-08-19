<p align="right"><strong>简体中文</strong> · <a href="./README.en.md">English</a></p>

<a id="top"></a>

<p align="center">
  <img src="./apps/web/public/devloop-mark.svg" width="112" alt="DevLoop 项目标志" />
</p>

<h1 align="center">DevLoop</h1>

<p align="center"><strong>把 AI 编程任务变成可审核、可验证的本地交付</strong></p>

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
  <a href="#how-it-delivers">如何交付</a> ·
  <a href="#review-gate">审核闸门</a> ·
  <a href="#quick-start">开始使用</a> ·
  <a href="#preview-validation">预览与验证</a> ·
  <a href="#local-boundary">本地边界</a> ·
  <a href="#development">开发</a> ·
  <a href="#license">许可</a>
</p>

---

<a id="why-devloop"></a>

## 为什么是 DevLoop

Codex CLI 和 Claude Code CLI 很擅长完成一次开发请求，但一个真实项目还需要知道：任务改了什么、是否满足验收、是否能运行、何时可以写入目标分支，以及驳回后如何在原结果上继续。

DevLoop 是运行在本机的开发交付控制台。它把每次 Agent 执行放进独立 Git Worktree，将结果固定为 Commit，并把 Diff、日志、自动验证、冲突和人工审核汇集到同一条任务记录里。你可以同时推进多个项目，但仍由人决定最终是否写入分支。

<a id="how-it-delivers"></a>

## 从任务到分支

```text
任务目标与验收标准
          |
          v
隔离 Worktree 中的 Codex CLI / Claude Code CLI
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

<a id="review-gate"></a>

## 审核是交付闸门

| 阶段 | DevLoop 负责什么                                  | 人负责什么                 |
| ---- | ------------------------------------------------- | -------------------------- |
| 执行 | 调度 CLI、记录事件、生成结果 Commit               | 定义目标、验收标准和执行器 |
| 验证 | 启动隔离预览、运行 Playwright、保存截图与检查结果 | 判断产品行为是否符合预期   |
| 审核 | 展示文件列表、补丁、冲突和 Agent 解决结果         | 批准、驳回，或手动解决冲突 |
| 写入 | 校验目标分支状态后应用并安全推送                  | 决定何时让结果进入目标分支 |

若目标分支在执行期间发生变化，DevLoop 会生成冲突预览。你可以在页面中处理冲突，也可以让 Agent 先生成解决方案再审核；未处理的冲突不能写入目标分支。驳回后的下一轮会以上一轮结果 Commit 为基础，再对齐最新目标分支继续执行。

<a id="quick-start"></a>

## 开始使用

### 从源码启动

需要 Node.js 24（`>=24 <27`）、pnpm 10，以及至少一个已安装并登录的执行器：`codex` 或 `claude`。

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

<a id="preview-validation"></a>

## 预览与自动验证

大多数项目不需要手动填写预览命令。DevLoop 按“项目高级覆盖 → Agent 返回的 Web 启动建议 → 结果 Commit 的 `package.json` 自动识别”确定预览方式，保守支持 Vite、Next.js、Nuxt、Astro、SvelteKit、Remix、Webpack、Parcel 与 Storybook 的常见脚本。

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
# CLI 连续无输出多久后终止；不是任务总执行时限。
DEVLOOP_CODEX_STALL_TIMEOUT_MS=1800000
DEVLOOP_CLAUDE_CODE_STALL_TIMEOUT_MS=1800000

# 隔离预览与 Playwright 的超时设置。
DEVLOOP_PREVIEW_STARTUP_TIMEOUT_MS=90000
DEVLOOP_PREVIEW_DEPENDENCY_INSTALL_TIMEOUT_MS=600000
DEVLOOP_PLAYWRIGHT_TIMEOUT_MS=60000
DEVLOOP_PLAYWRIGHT_TEST_TIMEOUT_MS=600000
```

Docker Compose 示例及其环境变量注释见 [`.env.example`](./.env.example)。

<a id="development"></a>

## 开发

DevLoop 使用 pnpm workspace：Fastify 服务端、React Web、Electron 桌面端，以及数据库、Git、Runner、工作流和共享模型包。

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

欢迎提交 Issue 和 Pull Request。请勿提交 API Key、Git 凭据、`.devloop-data` 中的个人数据，或任务生成的本地运行产物。

<a id="license"></a>

## 许可

DevLoop 采用 [MIT License](./LICENSE) 开源。

## 致谢

感谢 Codex CLI、Claude Code、Electron、Fastify、Drizzle、Playwright 及本项目使用的开源软件。

<p align="right"><a href="#top">返回顶部 ↑</a></p>
