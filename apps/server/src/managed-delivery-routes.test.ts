import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DevLoopRepository, openDatabase } from "@devloop/db";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { DomainEventBus } from "./event-bus.js";
import { registerManagedDeliveryRoutes } from "./managed-delivery-routes.js";

const migrationsFolder = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

it("读取和更新托管设置，并按项目 Runner 返回预算估算", async () => {
  const database = openDatabase({ filePath: ":memory:", migrationsFolder });
  const repository = new DevLoopRepository(database);
  const project = repository.createProject({
    name: "预算接口测试项目",
    repositoryUrl: null,
    repositoryPath: `/tmp/devloop-budget-api-${randomUUID()}`,
    defaultBaseRef: "main",
    headCommit: "base-commit",
    lastFetchedAt: null,
  }).value;
  const app = Fastify({ logger: false });
  registerManagedDeliveryRoutes(app, repository, new DomainEventBus());

  try {
    const initial = await app.inject({ method: "GET", url: "/api/managed-delivery/settings" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      settings: { maxTaskBudgetCents: 10_000, warningPercent: 80, autoRetryLimit: 2 },
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/managed-delivery/settings",
      payload: {
        maxTaskBudgetCents: 20_000,
        warningPercent: 75,
        budgetOverrunPercent: 30,
        autoRetryLimit: 3,
        runnerHourlyRatesCents: { codex: 3_000, "claude-code": 4_000, fake: 0 },
        expectedVersion: 0,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      settings: {
        maxTaskBudgetCents: 20_000,
        warningPercent: 75,
        runnerHourlyRatesCents: { codex: 3_000 },
        version: 1,
      },
    });

    const estimate = await app.inject({
      method: "POST",
      url: "/api/managed-delivery/budget-estimate",
      payload: {
        projectId: project.id,
        taskType: "DEVELOPMENT",
        executionMode: "MANAGED",
        title: "实现长任务托管",
        goal: "让平台负责执行、失败恢复、预算控制和最终交付。",
        acceptanceCriteria: ["生成预算", "超过硬上限自动停止"],
      },
    });
    expect(estimate.statusCode).toBe(200);
    expect(estimate.json()).toMatchObject({
      budget: { currency: "CNY", warningPercent: 75, consumedCents: 0 },
    });
    expect(estimate.json().budget.highCents).toBeGreaterThan(0);
  } finally {
    await app.close();
    database.close();
  }
});
