import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Image, Space, Tag } from "antd";
import { CheckCircle2, ExternalLink, Play, Square, TestTube2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PlaywrightValidationReport, RunArtifact, RunPreviewConfig } from "@devloop/shared";
import { api, queryKeys } from "../../../core/index.js";
import { useNotice } from "../../common/index.js";

interface RunValidationPanelProps {
  runId: string;
  report: PlaywrightValidationReport | null;
  artifacts: RunArtifact[];
  previewConfiguration: RunPreviewConfig | null;
  canPreview: boolean;
  previewTitle: string;
  title?: string;
}

const reportStatus: Record<PlaywrightValidationReport["status"], string> = {
  passed: "通过",
  failed: "发现问题",
  skipped: "已跳过",
};

const previewSourceLabels: Record<RunPreviewConfig["source"], string> = {
  project: "人工高级覆盖",
  agent: "Agent 识别",
  detected: "自动识别",
};

export function RunValidationPanel({
  runId,
  report,
  artifacts,
  previewConfiguration,
  canPreview,
  previewTitle,
  title = "预览与自动验证",
}: RunValidationPanelProps) {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const previewMutation = useMutation({
    mutationFn: () => api.startRunPreview(runId),
    onSuccess: async (data) => {
      setPreview({ id: data.preview.id, url: data.preview.url });
      try {
        if (window.devloopDesktop?.openPreview) {
          await window.devloopDesktop.openPreview({
            previewId: data.preview.id,
            runId,
            url: data.preview.url,
            title: previewTitle,
          });
        } else {
          window.open(data.preview.url, "_blank", "noopener,noreferrer");
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : "无法打开预览窗口", "danger");
      }
    },
    onError: (error) => notify(error instanceof Error ? error.message : "启动预览失败", "danger"),
  });
  const stopMutation = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error("预览尚未启动");
      return api.stopPreview(preview.id);
    },
    onSuccess: () => {
      if (preview && window.devloopDesktop?.closePreview) {
        void window.devloopDesktop.closePreview(preview.id);
      }
      setPreview(null);
    },
    onError: (error) => notify(error instanceof Error ? error.message : "停止预览失败", "danger"),
  });

  useEffect(() => {
    const close = window.devloopDesktop?.onPreviewClosed;
    if (!close) return;
    return close((previewId) => {
      if (preview?.id === previewId) {
        setPreview(null);
        void queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
      }
    });
  }, [preview?.id, queryClient, runId]);

  const screenshotArtifacts = useMemo(
    () =>
      artifacts.filter(
        (artifact) =>
          artifact.kind === "playwright-screenshot" &&
          (!report?.screenshotArtifactId || artifact.id === report.screenshotArtifactId),
      ),
    [artifacts, report],
  );
  const status = report?.status ?? null;
  const selectedPreviewConfiguration = report?.previewConfiguration ?? previewConfiguration;

  return (
    <section className="run-validation-panel" aria-label={title}>
      <header className="run-validation-heading">
        <div>
          <h3>{title}</h3>
          <span>基于当前结果 Commit 的隔离环境</span>
        </div>
        <TestTube2 size={18} aria-hidden="true" />
      </header>

      {selectedPreviewConfiguration ? (
        <Space size={8} wrap>
          <Tag color="blue">{previewSourceLabels[selectedPreviewConfiguration.source]}</Tag>
          <span className="run-validation-config">
            {selectedPreviewConfiguration.workingDirectory} · {selectedPreviewConfiguration.command}
          </span>
        </Space>
      ) : null}

      <div className="run-validation-actions">
        {canPreview ? (
          preview ? (
            <Space>
              <Button
                type="primary"
                icon={<ExternalLink size={16} />}
                onClick={() => {
                  if (window.devloopDesktop?.openPreview) {
                    void window.devloopDesktop.openPreview({
                      previewId: preview.id,
                      runId,
                      url: preview.url,
                      title: previewTitle,
                    });
                  } else {
                    window.open(preview.url, "_blank", "noopener,noreferrer");
                  }
                }}
              >
                打开预览
              </Button>
              <Button
                danger
                icon={<Square size={15} />}
                loading={stopMutation.isPending}
                onClick={() => stopMutation.mutate()}
              >
                停止预览
              </Button>
            </Space>
          ) : (
            <Button
              type="primary"
              icon={<Play size={16} />}
              loading={previewMutation.isPending}
              onClick={() => previewMutation.mutate()}
            >
              启动预览
            </Button>
          )
        ) : null}
      </div>

      {!report ? (
        <Alert
          type="info"
          showIcon
          message="自动验证尚未生成结果"
          description="任务完成后会自动运行；正在执行时请稍候刷新审核页。"
        />
      ) : (
        <>
          <Alert
            type={status === "passed" ? "success" : status === "failed" ? "error" : "warning"}
            showIcon
            icon={status === "passed" ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}
            message={`Playwright 验证${reportStatus[report.status]}`}
            description={`完成于 ${new Date(report.finishedAt).toLocaleString()}`}
          />
          <ul className="run-validation-checks">
            {report.checks.map((check, index) => (
              <li key={`${check.name}-${index}`}>
                <Tag
                  color={
                    check.status === "passed"
                      ? "success"
                      : check.status === "failed"
                        ? "error"
                        : "default"
                  }
                >
                  {check.status === "passed" ? "通过" : check.status === "failed" ? "失败" : "跳过"}
                </Tag>
                <strong>{check.name}</strong>
                <span>{check.message}</span>
              </li>
            ))}
          </ul>
          {report.pageErrors.length || report.consoleErrors.length ? (
            <Alert
              type="error"
              showIcon
              message="页面运行时错误"
              description={
                <pre className="run-validation-output">
                  {[...report.pageErrors, ...report.consoleErrors].join("\n")}
                </pre>
              }
            />
          ) : null}
          {report.customTestOutput ? (
            <details className="run-validation-output-details">
              <summary>项目交互测试输出</summary>
              <pre className="run-validation-output">{report.customTestOutput}</pre>
            </details>
          ) : null}
          {screenshotArtifacts.length ? (
            <Image.PreviewGroup>
              <div className="run-validation-screenshots">
                {screenshotArtifacts.map((artifact) => (
                  <Image
                    key={artifact.id}
                    src={api.runArtifactUrl(runId, artifact.id)}
                    alt="Playwright 页面截图"
                    preview={{ mask: "查看截图" }}
                  />
                ))}
              </div>
            </Image.PreviewGroup>
          ) : null}
        </>
      )}
    </section>
  );
}
