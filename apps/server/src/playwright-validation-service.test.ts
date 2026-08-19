import { describe, expect, it } from "vitest";
import type { PlaywrightValidationReport } from "@devloop/shared";
import type { ArtifactService } from "./artifact-service.js";
import { PlaywrightValidationService } from "./playwright-validation-service.js";
import type { PreviewService } from "./preview-service.js";

describe("PlaywrightValidationService", () => {
  it("没有预览命令时记录跳过报告", async () => {
    const reports: PlaywrightValidationReport[] = [];
    const artifactService = {
      writeValidationReport: async (_runId: string, report: PlaywrightValidationReport) => {
        reports.push(report);
        return {};
      },
    } as unknown as ArtifactService;
    const previewService = {
      start: () => {
        throw new Error("不应启动预览");
      },
      stop: async () => true,
    } as unknown as PreviewService;
    const service = new PlaywrightValidationService(
      previewService,
      artifactService,
      null,
      1_000,
      1_000,
    );

    const report = await service.validate({
      runId: crypto.randomUUID(),
      repositoryPath: "/tmp/repository",
      resultCommit: "result-commit",
      previewCommand: null,
      previewWorkingDirectory: ".",
      previewHealthPath: "/",
      playwrightEnabled: true,
      playwrightTestCommand: null,
    });

    expect(report).toMatchObject({
      status: "skipped",
      checks: [{ name: "启动预览", status: "skipped" }],
    });
    expect(reports).toEqual([report]);
  });

  it("浏览器不可用时仍停止预览并生成可审核的跳过报告", async () => {
    const reports: PlaywrightValidationReport[] = [];
    const stopped: string[] = [];
    const artifactService = {
      writeValidationReport: async (_runId: string, report: PlaywrightValidationReport) => {
        reports.push(report);
        return {};
      },
    } as unknown as ArtifactService;
    const previewId = crypto.randomUUID();
    const previewService = {
      start: async () => ({
        id: previewId,
        runId: "run-id",
        url: "http://127.0.0.1:45678",
        status: "running",
        startedAt: new Date().toISOString(),
        workingDirectory: "/tmp",
      }),
      stop: async (id: string) => {
        stopped.push(id);
        return true;
      },
    } as unknown as PreviewService;
    const service = new PlaywrightValidationService(
      previewService,
      artifactService,
      "/path/that/does/not/exist/chromium",
      500,
      500,
    );

    const report = await service.validate({
      runId: crypto.randomUUID(),
      repositoryPath: "/tmp/repository",
      resultCommit: "result-commit",
      previewCommand: "preview",
      previewWorkingDirectory: ".",
      previewHealthPath: "/",
      playwrightEnabled: true,
      playwrightTestCommand: null,
    });

    expect(report.status).toBe("skipped");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "启动 Playwright 浏览器", status: "skipped" }),
      ]),
    );
    expect(stopped).toEqual([previewId]);
    expect(reports).toEqual([report]);
  });
});
