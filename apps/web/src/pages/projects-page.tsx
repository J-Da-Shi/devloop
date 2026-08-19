import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import type { Project, ProjectRunner } from "@devloop/shared";
import { api, queryKeys } from "../core/index.js";
import {
  EmptyState,
  ErrorPanel,
  InlineNotice,
  LoadingPanel,
  useNotice,
} from "../components/common/index.js";
import {
  ProjectList,
  ProjectPreviewSettingsDialog,
  ProjectRegistrationForm,
  runnerLabels,
  type PreviewFormValues,
  type ProjectRegistration,
  type ProjectRunnerOption,
} from "../components/business/projects/index.js";

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [showForm, setShowForm] = useState(false);
  const [previewProject, setPreviewProject] = useState<Project | null>(null);
  const desktopAvailable = typeof window.devloopDesktop?.selectDirectory === "function";
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: api.projects });
  const dashboard = useQuery({ queryKey: queryKeys.dashboard, queryFn: api.dashboard });
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    staleTime: 60_000,
  });
  const runnerOptions: ProjectRunnerOption[] = (["codex", "claude-code"] as ProjectRunner[]).map(
    (id) => {
      const capability = dashboard.data?.runnerCapabilities.find((runner) => runner.id === id);
      const available = capability?.available ?? true;
      return {
        value: id,
        label: available ? runnerLabels[id] : `${runnerLabels[id]}（未就绪）`,
        disabled: capability !== undefined && !available,
      };
    },
  );

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
    ]);
  };

  const createProject = useMutation({
    mutationFn: (registration: ProjectRegistration) =>
      registration.source === "local"
        ? api.createLocalProject(registration.input)
        : api.createProject(registration.input),
    onSuccess: async (_data, registration) => {
      await refresh();
      setShowForm(false);
      notify(registration.source === "local" ? "本地项目已注册" : "远程项目已注册");
    },
    onError: (error) => notify(error instanceof Error ? error.message : "项目注册失败", "danger"),
  });
  const syncProject = useMutation({
    mutationFn: (project: Project) => api.syncProject(project.id),
    onSuccess: async (data) => {
      await refresh();
      notify(
        data.project.repositoryUrl
          ? `${data.project.name} 已同步远程仓库`
          : `${data.project.name} 已重新检查`,
      );
    },
    onError: (error) => notify(error instanceof Error ? error.message : "项目同步失败", "danger"),
  });
  const updateRunner = useMutation({
    mutationFn: (input: { project: Project; runner: ProjectRunner }) =>
      api.updateProjectRunner(input.project.id, {
        runner: input.runner,
        expectedVersion: input.project.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async (data) => {
      await refresh();
      notify(`${data.project.name} 执行器已切换为 ${runnerLabels[data.project.runner]}`);
    },
    onError: (error) => notify(error instanceof Error ? error.message : "切换执行器失败", "danger"),
  });
  const updatePreview = useMutation({
    mutationFn: (input: { project: Project; values: PreviewFormValues }) =>
      api.updateProjectPreview(input.project.id, {
        previewCommand: input.values.previewCommand.trim() || null,
        previewWorkingDirectory: input.values.previewWorkingDirectory.trim(),
        previewHealthPath: input.values.previewHealthPath.trim(),
        playwrightEnabled: input.values.playwrightEnabled,
        playwrightTestCommand: input.values.playwrightTestCommand.trim() || null,
        expectedVersion: input.project.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async (data) => {
      await refresh();
      setPreviewProject(null);
      notify(`${data.project.name} 的预览配置已保存`);
    },
    onError: (error) =>
      notify(error instanceof Error ? error.message : "保存预览配置失败", "danger"),
  });

  if (projects.isPending || session.isPending) return <LoadingPanel label="正在加载项目" />;
  if (projects.isError) return <ErrorPanel error={projects.error} />;

  const canEdit = session.data?.identity.role === "editor";
  return (
    <div className="page-stack">
      <div className="page-actions page-actions-end">
        {canEdit ? (
          <Button
            type="primary"
            icon={showForm ? <X size={17} /> : <Plus size={17} />}
            onClick={() => setShowForm((value) => !value)}
          >
            {showForm ? "收起" : "注册项目"}
          </Button>
        ) : null}
      </div>

      {!canEdit ? <InlineNotice tone="info">当前角色只能查看项目。</InlineNotice> : null}
      {showForm ? (
        <ProjectRegistrationForm
          desktopAvailable={desktopAvailable}
          runnerOptions={runnerOptions}
          submitting={createProject.isPending}
          onSubmit={createProject.mutateAsync}
          onDirectoryError={(message) => notify(message, "danger")}
        />
      ) : null}

      {projects.data.projects.length === 0 ? (
        <EmptyState
          title="还没有注册项目"
          detail={desktopAvailable ? "添加远程仓库或本地 Git 目录" : "添加远程 Git 仓库"}
        />
      ) : (
        <ProjectList
          projects={projects.data.projects}
          canEdit={canEdit}
          runnerOptions={runnerOptions}
          syncing={syncProject.isPending}
          updatingRunner={updateRunner.isPending}
          onConfigurePreview={setPreviewProject}
          onSync={syncProject.mutate}
          onRunnerChange={(project, runner) => updateRunner.mutate({ project, runner })}
        />
      )}

      <ProjectPreviewSettingsDialog
        project={previewProject}
        saving={updatePreview.isPending}
        onClose={() => setPreviewProject(null)}
        onSave={(project, values) => updatePreview.mutate({ project, values })}
      />
    </div>
  );
}
