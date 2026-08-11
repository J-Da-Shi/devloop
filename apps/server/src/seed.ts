import { randomUUID } from "node:crypto";
import type { DevLoopRepository } from "@devloop/db";
import type { GitService } from "@devloop/git";
import type { DomainEventBus } from "./event-bus.js";

export async function seedDevelopmentData(
  repository: DevLoopRepository,
  gitService: GitService,
  eventBus: DomainEventBus,
  repositoryRoot: string,
): Promise<void> {
  if (repository.listProjects().length > 0) {
    return;
  }

  const git = await gitService.inspectRepository(repositoryRoot);
  const projectResult = repository.createProject({
    name: "DevLoop",
    path: git.path,
    defaultBaseRef: git.branch,
    headCommit: git.headCommit,
  });
  eventBus.publish(projectResult.events);

  const draft = repository.createTask({
    projectId: projectResult.value.id,
    title: "完善手机端任务编辑",
    goal: "让已授权手机可以修改草稿任务，并清楚看到版本冲突和保存结果。",
    acceptanceCriteria: [
      "手机端可以打开草稿详情并编辑目标与验收标准",
      "提交时携带预期版本和幂等键",
      "冲突时重新加载服务端版本而不是静默覆盖",
    ],
    priority: 70,
  });
  eventBus.publish(draft.events);

  const ready = repository.createTask({
    projectId: projectResult.value.id,
    title: "验证本地服务与移动端状态同步",
    goal: "跑通任务确认、Worker 领取、阶段事件推送和移动端审核入口。",
    acceptanceCriteria: [
      "任务可以从 READY 自动进入 RUNNING",
      "执行阶段通过 SSE 更新到桌面和手机",
      "成功后进入 REVIEW 并显示审核操作",
    ],
    priority: 90,
  });
  eventBus.publish(ready.events);
  const confirmed = repository.confirmTask(ready.value.id, "local-desktop", {
    expectedVersion: ready.value.version,
    idempotencyKey: randomUUID(),
    baseStrategy: "LATEST_ACCEPTED",
    baseRef: git.branch,
  });
  eventBus.publish(confirmed.events);
}
