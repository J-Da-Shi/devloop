# DevLoop

DevLoop 是一个本地优先的无人值守开发任务编排系统。用户通过浏览器确认任务输入和审核执行结果，本机后台服务负责调度任务、创建 Git 工作树、调用 Codex 或其他编程智能体、运行验证命令并生成可审计的结果包。

## 产品定位

- 浏览器 Task Center 是主要交互入口。
- 本机 DevLoop Service 是任务和执行状态的唯一事实来源。
- Codex CLI、Claude Code 等工具作为可替换的 Agent Runner。
- 用户只在任务确认和结果审核两个阶段参与。
- 浏览器或 Codex 客户端关闭后，后台 Worker 仍可继续运行。

## 方案文档

- [开发方案](./DEVELOPMENT_PLAN.md)
- [技术选型](./TECH_SELECTION.md)

## 当前状态

当前处于浏览器端架构确认与 MVP 设计阶段。项目只包含 Web 控制台、本机服务、Workflow、Worker 和 Agent Runner 方案。

## 计划目录

~~~text
devloop/
├── apps/
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
~~~
