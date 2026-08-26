import type { DevLoopRepository } from "@devloop/db";
import {
  managedBudgetEstimateInputSchema,
  updateManagedDeliverySettingsInputSchema,
} from "@devloop/shared";
import type { FastifyInstance } from "fastify";
import type { DomainEventBus } from "../infrastructure/event-bus.js";
import { requireRole } from "../infrastructure/http.js";

export function registerManagedDeliveryRoutes(
  app: FastifyInstance,
  repository: DevLoopRepository,
  eventBus: DomainEventBus,
): void {
  app.get("/api/managed-delivery/settings", async (request) => {
    requireRole(request, "viewer");
    return { settings: repository.getManagedDeliverySettings() };
  });

  app.patch("/api/managed-delivery/settings", async (request) => {
    requireRole(request, "editor");
    const input = updateManagedDeliverySettingsInputSchema.parse(request.body);
    const result = repository.updateManagedDeliverySettings(input);
    eventBus.publish(result.events);
    return { settings: result.value };
  });

  app.post("/api/managed-delivery/budget-estimate", async (request) => {
    requireRole(request, "editor");
    const input = managedBudgetEstimateInputSchema.parse(request.body);
    const budget = repository.estimateTaskBudget(input.projectId, {
      taskType: input.taskType,
      executionMode: input.executionMode,
      title: input.title,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
    });
    return { budget };
  });
}
