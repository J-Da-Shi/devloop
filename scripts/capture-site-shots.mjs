import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const outputDirectory = resolve("docs/shots");
await mkdir(outputDirectory, { recursive: true });

const now = "2026-08-19T12:18:00.000Z";
const projectId = "11111111-1111-4111-8111-111111111111";
const activeRunId = "22222222-2222-4222-8222-222222222222";
const secondRunId = "33333333-3333-4333-8333-333333333333";
const reviewRunId = "44444444-4444-4444-8444-444444444444";

const project = {
  id: projectId,
  name: "Atlas Console",
  repositoryUrl: null,
  defaultBaseRef: "main",
  integrationRef: "refs/devloop/integration/atlas-console",
  integrationCommit: "7fd4a82d21a36dd807d0aa64c18d2483fb48ea51",
  runner: "codex",
  previewCommand: "pnpm dev",
  previewWorkingDirectory: ".",
  previewHealthPath: "/",
  playwrightEnabled: true,
  playwrightTestCommand: "pnpm test:e2e",
  lastFetchedAt: now,
  version: 3,
  createdAt: "2026-08-12T08:00:00.000Z",
  updatedAt: now,
};

const makeTask = (overrides) => ({
  id: crypto.randomUUID(),
  projectId,
  projectName: project.name,
  taskType: "DEVELOPMENT",
  targetBranch: "main",
  autoResolveConflicts: true,
  title: "Untitled task",
  goal: "Deliver a focused product improvement and verify the resulting user flow.",
  acceptanceCriteria: ["Behavior matches the task goal", "Automated checks pass"],
  status: "DRAFT",
  priority: 50,
  activeRevisionId: null,
  latestRunId: null,
  deletedAt: null,
  version: 1,
  createdAt: "2026-08-18T08:00:00.000Z",
  updatedAt: now,
  ...overrides,
});

const reviewTask = makeTask({
  id: "55555555-5555-4555-8555-555555555555",
  title: "完善审核页的变更对比与预览",
  goal: "让审核者在一个页面内检查文件变更、自动验证结果和产品截图，再决定是否写入目标分支。",
  acceptanceCriteria: [
    "左侧文件列表可快速切换变更文件",
    "Playwright 自动验证结果与截图进入审核页",
    "只有人工确认后才能写入 main 分支",
  ],
  status: "REVIEW",
  priority: 100,
  activeRevisionId: "66666666-6666-4666-8666-666666666666",
  latestRunId: reviewRunId,
  version: 8,
});

const tasks = [
  makeTask({
    title: "整理本地项目接入流程",
    goal: "支持直接选择桌面上的现有 Git 项目。",
    status: "DRAFT",
    priority: 62,
  }),
  makeTask({
    title: "补充发布前安全检查",
    goal: "在写入目标分支前验证工作区状态和远端分支。",
    status: "READY",
    priority: 100,
  }),
  makeTask({
    id: "77777777-7777-4777-8777-777777777777",
    title: "实现多任务并发执行",
    goal: "允许 Worker 在隔离 Worktree 中并行领取多个任务。",
    status: "RUNNING",
    priority: 100,
    activeRevisionId: "88888888-8888-4888-8888-888888888888",
    latestRunId: activeRunId,
  }),
  reviewTask,
  makeTask({
    title: "修复预览依赖安装失败",
    goal: "识别 lockfile 并在隔离预览环境安装依赖。",
    status: "BLOCKED",
    priority: 88,
  }),
  makeTask({
    title: "接入 Skill 执行快照",
    goal: "记录每轮执行实际使用的 Skill 版本。",
    status: "COMPLETED",
    priority: 100,
  }),
  makeTask({
    title: "验证任务连续迭代",
    goal: "完成任务后可以基于上一轮结果继续补充需求。",
    status: "COMPLETED",
    priority: 100,
  }),
];

const activeRun = {
  id: activeRunId,
  taskId: tasks[2].id,
  taskRevisionId: tasks[2].activeRevisionId,
  targetBranch: "main",
  runner: "codex",
  status: "AGENT_RUNNING",
  baseCommit: "1b8d530eb12f9a2a7a4ac31263bf0dfb3cba736d",
  resultCommit: null,
  branchName: "devloop/run/22222222",
  runnerVersion: "codex-cli 0.42.0",
  executionToken: "site-demo-active",
  pushedAt: null,
  pushedCommit: null,
  skillSnapshot: null,
  summary: null,
  startedAt: "2026-08-19T12:12:00.000Z",
  finishedAt: null,
};

const secondRun = {
  ...activeRun,
  id: secondRunId,
  taskId: tasks[1].id,
  taskRevisionId: "99999999-9999-4999-8999-999999999999",
  status: "VERIFYING",
  branchName: "devloop/run/33333333",
  executionToken: "site-demo-verify",
  startedAt: "2026-08-19T12:14:00.000Z",
};

const reviewRun = {
  ...activeRun,
  id: reviewRunId,
  taskId: reviewTask.id,
  taskRevisionId: reviewTask.activeRevisionId,
  status: "SUCCEEDED",
  baseCommit: "ae7214b73d027640c6cb783335f22ffb1c4ad944",
  resultCommit: "c82f6b1b6c13ce2dcb634bd879d21f7f76e824de",
  branchName: "devloop/run/review-workspace",
  executionToken: "site-demo-review",
  summary:
    "已重构审核工作区：文件级 Diff、Playwright 验证结果与产品截图集中展示，写入操作继续由人工把关。",
  startedAt: "2026-08-19T11:43:00.000Z",
  finishedAt: "2026-08-19T12:03:00.000Z",
};

const revision = {
  id: reviewTask.activeRevisionId,
  taskId: reviewTask.id,
  revision: 3,
  taskType: "DEVELOPMENT",
  autoResolveConflicts: true,
  title: reviewTask.title,
  goal: reviewTask.goal,
  acceptanceCriteria: reviewTask.acceptanceCriteria,
  reviewFeedback: null,
  specHash: "e5a93c0f3261c7950c99cb8ce5b28db5021d4cbe2c55a6541c9cc58b51e1b706",
  targetBranch: "main",
  baseRef: "main",
  baseStrategy: "LATEST_ACCEPTED",
  confirmedBaseCommit: reviewRun.baseCommit,
  createdFrom: "TASK_CONFIRMED",
  createdByDeviceId: "site-demo",
  confirmedAt: "2026-08-19T11:42:00.000Z",
};

const activeEvents = [
  ["run.started", "任务已领取，正在准备隔离 Worktree"],
  ["runner.preparing", "已对齐 main 最新 Commit"],
  ["runner.agent", "Codex 正在实现并发调度与取消链路"],
  ["runner.agent", "更新 Worker 状态与运行事件"],
  ["runner.verifying", "正在执行类型检查和相关测试"],
].map(([type, message], index) => ({
  id: `event-active-${index}`,
  runId: activeRunId,
  sequence: index + 1,
  type,
  message,
  payload: {},
  createdAt: new Date(Date.parse(activeRun.startedAt) + index * 48_000).toISOString(),
}));

const reviewEvents = [
  ["run.started", "已创建隔离 Worktree"],
  ["runner.agent", "完成审核工作区布局调整"],
  ["runner.verifying", "类型检查与组件测试通过"],
  ["run.playwright.started", "启动隔离预览并运行 Playwright"],
  ["run.playwright.completed", "页面加载、交互流程和截图检查通过"],
  ["run.finished", "结果 Commit 已生成，等待人工审核"],
].map(([type, message], index) => ({
  id: `event-review-${index}`,
  runId: reviewRunId,
  sequence: index + 1,
  type,
  message,
  payload: {},
  createdAt: new Date(Date.parse(reviewRun.startedAt) + index * 180_000).toISOString(),
}));

const dashboard = {
  worker: {
    status: "RUNNING",
    heartbeatAt: now,
    activeRunId,
    activeRunIds: [activeRunId, secondRunId],
    concurrencyLimit: 3,
    version: 12,
  },
  projects: [project],
  tasks,
  activeRuns: [activeRun, secondRun],
  currentRun: activeRun,
  runnerCapabilities: [
    {
      id: "codex",
      available: true,
      version: "codex-cli 0.42.0",
      executablePath: "/usr/local/bin/codex",
      features: ["events", "cancellation", "structured-output"],
      error: null,
    },
    {
      id: "claude-code",
      available: true,
      version: "2.1.0",
      executablePath: "/usr/local/bin/claude",
      features: ["events", "cancellation"],
      error: null,
    },
  ],
};

const reviewDetails = {
  run: reviewRun,
  task: reviewTask,
  revision,
  reviewDecision: null,
  events: reviewEvents,
  validation: {
    report: {
      status: "passed",
      startedAt: "2026-08-19T11:58:00.000Z",
      finishedAt: "2026-08-19T12:02:00.000Z",
      previewConfiguration: {
        source: "detected",
        command: "pnpm dev",
        workingDirectory: ".",
        healthPath: "/",
      },
      checks: [
        { name: "页面可访问", status: "passed", message: "首页返回 200，主内容已渲染" },
        { name: "控制台错误", status: "passed", message: "未发现页面异常或未处理错误" },
        { name: "审核交互", status: "passed", message: "文件切换、预览和审核按钮均可操作" },
        { name: "响应式布局", status: "passed", message: "桌面与移动视口未发生内容溢出" },
      ],
      pageErrors: [],
      consoleErrors: [],
      screenshotArtifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      customTestOutput: "4 passed (18.7s)",
    },
    artifacts: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        runId: reviewRunId,
        kind: "playwright-screenshot",
        size: 184320,
        checksum: "f12ac70c",
        createdAt: "2026-08-19T12:02:00.000Z",
      },
    ],
  },
  previewConfiguration: {
    source: "detected",
    command: "pnpm dev",
    workingDirectory: ".",
    healthPath: "/",
  },
};

const changedFiles = {
  files: [
    {
      path: "apps/web/src/components/business/runs/diff-file-detail.tsx",
      status: "added",
      additions: 126,
      deletions: 0,
      isBinary: false,
    },
    {
      path: "apps/web/src/components/business/runs/run-diff-panel.tsx",
      status: "modified",
      additions: 48,
      deletions: 21,
      isBinary: false,
    },
    {
      path: "apps/web/src/styles/_diff.scss",
      status: "modified",
      additions: 39,
      deletions: 14,
      isBinary: false,
    },
    {
      path: "apps/web/src/core/unified-diff.test.ts",
      status: "added",
      additions: 74,
      deletions: 0,
      isBinary: false,
    },
  ],
  conflictPreview: {
    status: "clean",
    targetBranch: "main",
    targetCommit: "7fd4a82d21a36dd807d0aa64c18d2483fb48ea51",
    files: [],
    message: "结果可干净写入目标分支",
  },
  agentResolution: null,
};

const patches = {
  "apps/web/src/components/business/runs/diff-file-detail.tsx": `diff --git a/apps/web/src/components/business/runs/diff-file-detail.tsx b/apps/web/src/components/business/runs/diff-file-detail.tsx
new file mode 100644
index 0000000..54d818e
--- /dev/null
+++ b/apps/web/src/components/business/runs/diff-file-detail.tsx
@@ -0,0 +1,18 @@
+import { FileDiff, TestTube2 } from "lucide-react";
+
+export function ReviewWorkspace({ run }: ReviewWorkspaceProps) {
+  const [selectedPath, setSelectedPath] = useState(run.files[0]?.path);
+
+  return (
+    <section className="review-workspace">
+      <FileNavigator
+        files={run.files}
+        selectedPath={selectedPath}
+        onSelect={setSelectedPath}
+      />
+      <DiffViewer path={selectedPath} />
+      <ValidationSummary icon={<TestTube2 size={16} />} run={run} />
+    </section>
+  );
+}
`,
  "apps/web/src/components/business/runs/run-diff-panel.tsx": `diff --git a/apps/web/src/components/business/runs/run-diff-panel.tsx b/apps/web/src/components/business/runs/run-diff-panel.tsx
index 82661b4..bc164cc 100644
--- a/apps/web/src/components/business/runs/run-diff-panel.tsx
+++ b/apps/web/src/components/business/runs/run-diff-panel.tsx
@@ -42,7 +42,12 @@ export function RunDiffPanel({ runId }: RunDiffPanelProps) {
-  return <pre className="diff-output">{patch}</pre>;
+  return (
+    <ReviewWorkspace
+      files={files}
+      selectedPath={selectedPath}
+      onSelectedPathChange={setSelectedPath}
+    />
+  );
 }
`,
  "apps/web/src/styles/_diff.scss": `diff --git a/apps/web/src/styles/_diff.scss b/apps/web/src/styles/_diff.scss
index 3a9081c..cca395c 100644
--- a/apps/web/src/styles/_diff.scss
+++ b/apps/web/src/styles/_diff.scss
@@ -1180,6 +1180,15 @@
+.review-workspace {
+  display: grid;
+  grid-template-columns: 280px minmax(0, 1fr);
+  min-height: 520px;
+  border: 1px solid var(--border);
+  background: #fff;
+}
+
+.review-workspace__files {
+  overflow-y: auto;
+  border-right: 1px solid var(--border);
+}
`,
  "apps/web/src/core/unified-diff.test.ts": `diff --git a/apps/web/src/core/unified-diff.test.ts b/apps/web/src/core/unified-diff.test.ts
new file mode 100644
index 0000000..912eba2
--- /dev/null
+++ b/apps/web/src/core/unified-diff.test.ts
@@ -0,0 +1,9 @@
+it("switches the selected file without leaving review", async () => {
+  render(<ReviewWorkspace run={fixtureRun} />);
+  await user.click(screen.getByRole("button", { name: /styles.css/ }));
+  expect(screen.getByTestId("diff-path")).toHaveTextContent("styles.css");
+});
`,
};

const browser = await chromium.launch({ headless: true });

const previewPage = await browser.newPage({ viewport: { width: 1280, height: 760 } });
await previewPage.setContent(`
  <!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; color: #172033; background: #f3f6fa; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        header { display: flex; height: 68px; align-items: center; justify-content: space-between; padding: 0 34px; border-bottom: 1px solid #dce2ea; background: #fff; }
        .brand { display: flex; align-items: center; gap: 12px; font-weight: 760; }
        .brand i { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 8px; background: #101014; color: #d2ffb3; font-style: normal; }
        nav { display: flex; gap: 24px; color: #667085; font-size: 13px; }
        main { padding: 38px; }
        .heading { display: flex; align-items: end; justify-content: space-between; margin-bottom: 24px; }
        h1 { margin: 0 0 7px; font-size: 28px; }
        p { margin: 0; color: #667085; }
        button { height: 40px; padding: 0 16px; border: 0; border-radius: 6px; background: #111827; color: #fff; font-weight: 650; }
        .metrics { display: grid; grid-template-columns: repeat(4, 1fr); margin-bottom: 22px; border: 1px solid #dce2ea; border-radius: 8px; background: #fff; }
        .metric { padding: 18px; border-right: 1px solid #dce2ea; }
        .metric:last-child { border: 0; }
        .metric span { display: block; color: #667085; font-size: 12px; }
        .metric strong { display: block; margin-top: 9px; font-size: 27px; }
        .grid { display: grid; grid-template-columns: 1.5fr 1fr; gap: 20px; }
        .panel { min-height: 318px; overflow: hidden; border: 1px solid #dce2ea; border-radius: 8px; background: #fff; }
        .panel h2 { margin: 0; padding: 18px 20px; border-bottom: 1px solid #dce2ea; font-size: 15px; }
        .bars { display: grid; gap: 13px; padding: 22px; }
        .bar { display: grid; grid-template-columns: 112px 1fr 38px; align-items: center; gap: 12px; font-size: 12px; }
        .track { height: 8px; border-radius: 6px; background: #edf0f4; }
        .track i { display: block; height: 100%; border-radius: 6px; background: #559cff; }
        .activity { display: grid; gap: 0; }
        .row { display: grid; grid-template-columns: 12px 1fr auto; gap: 11px; padding: 15px 18px; border-bottom: 1px solid #edf0f4; font-size: 12px; }
        .row i { width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: #2ca76d; }
        .row span { color: #667085; }
        .row time { color: #98a2b3; }
      </style>
    </head>
    <body>
      <header><div class="brand"><i>A</i>Atlas Console</div><nav><strong>Overview</strong><span>Deployments</span><span>Usage</span><span>Settings</span></nav></header>
      <main>
        <div class="heading"><div><h1>Workspace overview</h1><p>Production activity across your team</p></div><button>Create deployment</button></div>
        <section class="metrics"><div class="metric"><span>Active projects</span><strong>18</strong></div><div class="metric"><span>Deployments</span><strong>143</strong></div><div class="metric"><span>Success rate</span><strong>99.8%</strong></div><div class="metric"><span>Build minutes</span><strong>4,281</strong></div></section>
        <div class="grid"><section class="panel"><h2>Weekly usage</h2><div class="bars"><div class="bar"><span>Mon</span><div class="track"><i style="width:62%"></i></div><b>62</b></div><div class="bar"><span>Tue</span><div class="track"><i style="width:78%"></i></div><b>78</b></div><div class="bar"><span>Wed</span><div class="track"><i style="width:91%"></i></div><b>91</b></div><div class="bar"><span>Thu</span><div class="track"><i style="width:72%"></i></div><b>72</b></div><div class="bar"><span>Fri</span><div class="track"><i style="width:86%"></i></div><b>86</b></div></div></section><section class="panel"><h2>Recent activity</h2><div class="activity"><div class="row"><i></i><span>Dashboard deployed</span><time>2m</time></div><div class="row"><i></i><span>Checks passed</span><time>7m</time></div><div class="row"><i></i><span>Design tokens updated</span><time>21m</time></div><div class="row"><i></i><span>Release approved</span><time>36m</time></div></div></section></div>
      </main>
    </body>
  </html>
`);
await previewPage.screenshot({ path: resolve(outputDirectory, "validation-preview.png") });
await previewPage.close();

const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
});

await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path === "/api/session") {
    await route.fulfill({
      json: { identity: { id: "site-demo", name: "本机开发者", role: "editor", kind: "owner" } },
    });
    return;
  }
  if (path === "/api/dashboard") {
    await route.fulfill({ json: dashboard });
    return;
  }
  if (path === `/api/runs/${activeRunId}`) {
    await route.fulfill({
      json: {
        run: activeRun,
        task: tasks[2],
        revision: {
          ...revision,
          id: activeRun.taskRevisionId,
          taskId: activeRun.taskId,
          title: tasks[2].title,
          goal: tasks[2].goal,
          acceptanceCriteria: tasks[2].acceptanceCriteria,
        },
        reviewDecision: null,
        events: activeEvents,
        validation: { report: null, artifacts: [] },
        previewConfiguration: null,
      },
    });
    return;
  }
  if (path === `/api/runs/${secondRunId}`) {
    await route.fulfill({
      json: {
        run: secondRun,
        task: tasks[1],
        revision: {
          ...revision,
          id: secondRun.taskRevisionId,
          taskId: secondRun.taskId,
          title: tasks[1].title,
          goal: tasks[1].goal,
          acceptanceCriteria: tasks[1].acceptanceCriteria,
        },
        reviewDecision: null,
        events: activeEvents.map((event) => ({ ...event, runId: secondRunId })),
        validation: { report: null, artifacts: [] },
        previewConfiguration: null,
      },
    });
    return;
  }
  if (path === `/api/runs/${reviewRunId}`) {
    await route.fulfill({ json: reviewDetails });
    return;
  }
  if (path === `/api/runs/${reviewRunId}/changed-files`) {
    await route.fulfill({ json: changedFiles });
    return;
  }
  if (path === `/api/runs/${reviewRunId}/patch`) {
    await route.fulfill({
      json: { patch: patches[url.searchParams.get("path")] ?? "", isBinary: false },
    });
    return;
  }
  if (path === `/api/runs/${reviewRunId}/artifacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`) {
    await route.fulfill({
      path: resolve(outputDirectory, "validation-preview.png"),
      contentType: "image/png",
    });
    return;
  }
  if (path === "/api/events") {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "retry: 60000\n\n",
    });
    return;
  }
  if (path === "/api/projects") {
    await route.fulfill({ json: { projects: [project] } });
    return;
  }
  if (path === "/api/runs") {
    await route.fulfill({ json: { runs: [reviewRun, activeRun, secondRun] } });
    return;
  }
  await route.fulfill({
    status: 404,
    json: { error: { code: "NOT_FOUND", message: "Demo endpoint not found" } },
  });
});

await page.goto("http://127.0.0.1:5188/status", { waitUntil: "networkidle" });
await page.locator(".worker-strip").waitFor();
await page.screenshot({ path: resolve(outputDirectory, "execution-overview.png") });

await page.goto("http://127.0.0.1:5188/board", { waitUntil: "networkidle" });
await page.locator(".board-columns").waitFor();
await page.screenshot({ path: resolve(outputDirectory, "task-board.png") });

await page.getByText(reviewTask.title, { exact: true }).click();
await page.locator(".task-dialog").waitFor();
await page.locator(".diff-preview-button").waitFor();
await page.locator(".diff-preview-button").click();
await page.locator(".diff-dialog").waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: resolve(outputDirectory, "review-diff.png") });
await page.locator(".diff-dialog .ant-modal-close").click();

await page.locator(".task-dialog-scroll-region").evaluate((element) => {
  const heading = Array.from(element.querySelectorAll("h3")).find(
    (node) => node.textContent === "预览与自动验证",
  );
  if (heading) element.scrollTop = heading.offsetTop - 12;
});
await page.waitForTimeout(500);
await page.screenshot({ path: resolve(outputDirectory, "playwright-review.png") });

await browser.close();

console.log(`Captured website shots in ${outputDirectory}`);
