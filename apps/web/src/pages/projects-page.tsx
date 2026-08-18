import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Flex, Form, Input, Segmented, Select } from "antd";
import { FolderOpen, GitBranch, HardDrive, Plus, RefreshCw, Server, X } from "lucide-react";
import { useState } from "react";
import type { Project, ProjectRunner } from "@devloop/shared";
import { api, queryKeys } from "../api.js";
import { EmptyState, ErrorPanel, InlineNotice, LoadingPanel } from "../components/feedback.js";
import { IconButton } from "../components/icon-button.js";
import { useNotice } from "../components/notice-provider.js";
import { formatDateTime, shortCommit } from "../utils.js";

type ProjectSource = "remote" | "local";

type ProjectRegistration =
  | {
      source: "remote";
      input: {
        name: string;
        repositoryUrl: string;
        defaultBaseRef: string;
        runner: ProjectRunner;
      };
    }
  | { source: "local"; input: { name: string; path: string; runner: ProjectRunner } };

const runnerLabels: Record<ProjectRunner, string> = {
  codex: "Codex CLI",
  "claude-code": "Claude Code CLI",
};

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [showForm, setShowForm] = useState(false);
  const [source, setSource] = useState<ProjectSource>("remote");
  const [name, setName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [baseRef, setBaseRef] = useState("main");
  const [runner, setRunner] = useState<ProjectRunner>("codex");
  const desktopAvailable = typeof window.devloopDesktop?.selectDirectory === "function";
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: api.projects });
  const dashboard = useQuery({ queryKey: queryKeys.dashboard, queryFn: api.dashboard });
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    staleTime: 60_000,
  });
  const runnerOptions: { value: ProjectRunner; label: string; disabled?: boolean }[] = (
    ["codex", "claude-code"] as ProjectRunner[]
  ).map((id) => {
    const capability = dashboard.data?.runnerCapabilities.find((cap) => cap.id === id);
    const available = capability?.available ?? true;
    return {
      value: id,
      label: available ? runnerLabels[id] : `${runnerLabels[id]}（未就绪）`,
      disabled: capability !== undefined && !available,
    };
  });
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
      setName("");
      setRepositoryUrl("");
      setLocalPath("");
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
    onError: (error) =>
      notify(error instanceof Error ? error.message : "切换执行器失败", "danger"),
  });
  const chooseDirectory = async () => {
    try {
      const selectDirectory = window.devloopDesktop?.selectDirectory;
      if (!selectDirectory) {
        notify("客户端版本过旧，请完全退出并重新启动 DevLoop", "danger");
        return;
      }
      const selected = await selectDirectory();
      if (!selected) {
        return;
      }
      setLocalPath(selected);
      if (!name.trim()) {
        setName(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法打开目录选择器", "danger");
    }
  };

  if (projects.isPending || session.isPending) {
    return <LoadingPanel label="正在加载项目" />;
  }
  if (projects.isError) {
    return <ErrorPanel error={projects.error} />;
  }

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
        <Form
          layout="vertical"
          requiredMark={false}
          className="tool-panel project-form"
          onFinish={() => {
            createProject.mutate(
              source === "local"
                ? { source, input: { name, path: localPath, runner } }
                : {
                    source,
                    input: { name, repositoryUrl, defaultBaseRef: baseRef, runner },
                  },
            );
          }}
        >
          <div className="section-heading">
            <div>
              <h2>{source === "local" ? "注册本地 Git 项目" : "注册远程 Git 项目"}</h2>
              <span>{source === "local" ? "使用桌面上已有的仓库" : "克隆仓库并托管执行目录"}</span>
            </div>
            {source === "local" ? <HardDrive size={19} /> : <Server size={19} />}
          </div>
          {desktopAvailable ? (
            <Segmented
              className="project-source-control"
              aria-label="项目来源"
              value={source}
              onChange={(value) => setSource(value as ProjectSource)}
              options={[
                {
                  value: "remote",
                  label: (
                    <span>
                      <Server size={16} />
                      远程仓库
                    </span>
                  ),
                },
                {
                  value: "local",
                  label: (
                    <span>
                      <FolderOpen size={16} />
                      本地目录
                    </span>
                  ),
                },
              ]}
            />
          ) : null}
          <div className="form-grid">
            <Form.Item label="项目名称" required>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </Form.Item>
            <Form.Item label="执行器" required>
              <Select<ProjectRunner>
                value={runner}
                onChange={(value) => setRunner(value)}
                options={runnerOptions}
              />
            </Form.Item>
            {source === "remote" ? (
              <>
                <Form.Item label="默认分支" required>
                  <Input
                    value={baseRef}
                    onChange={(event) => setBaseRef(event.target.value)}
                    placeholder="main"
                  />
                </Form.Item>
                <Form.Item label="SSH 仓库地址" required className="field-wide">
                  <Input
                    value={repositoryUrl}
                    onChange={(event) => setRepositoryUrl(event.target.value)}
                    placeholder="git@github.com:team/project.git"
                    autoComplete="off"
                  />
                </Form.Item>
              </>
            ) : (
              <Form.Item label="项目根目录" required className="field-wide">
                <span className="input-action-row">
                  <Input value={localPath} placeholder="选择 Git 仓库根目录" readOnly />
                  <Button
                    icon={<FolderOpen size={17} />}
                    onClick={() => void chooseDirectory()}
                  >
                    选择目录
                  </Button>
                </span>
              </Form.Item>
            )}
          </div>
          <div className="dialog-actions">
            <Button
              type="primary"
              htmlType="submit"
              loading={createProject.isPending}
              disabled={
                !name.trim() ||
                (source === "local" ? !localPath.trim() : !repositoryUrl.trim() || !baseRef.trim())
              }
            >
              {createProject.isPending && source === "local" ? "正在检查" : "注册项目"}
            </Button>
          </div>
        </Form>
      ) : null}

      {projects.data.projects.length === 0 ? (
        <EmptyState
          title="还没有注册项目"
          detail={desktopAvailable ? "添加远程仓库或本地 Git 目录" : "添加远程 Git 仓库"}
        />
      ) : (
        <Flex vertical className="object-list">
          {projects.data.projects.map((project) => {
            const local = project.repositoryUrl === null;
            return (
              <div key={project.id} className="object-row">
                <span className="object-icon">
                  {local ? <HardDrive size={19} /> : <GitBranch size={19} />}
                </span>
                <div className="object-main">
                  <strong>{project.name}</strong>
                  <code>{project.repositoryUrl ?? "本地 Git 项目"}</code>
                </div>
                <dl className="object-facts">
                  <div>
                    <dt>默认分支</dt>
                    <dd>{project.defaultBaseRef}</dd>
                  </div>
                  <div>
                    <dt>基线 Commit</dt>
                    <dd>
                      <code>{shortCommit(project.integrationCommit)}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>{local ? "最近检查" : "最近同步"}</dt>
                    <dd>{formatDateTime(local ? project.updatedAt : project.lastFetchedAt)}</dd>
                  </div>
                  <div>
                    <dt>执行器</dt>
                    <dd>
                      {canEdit ? (
                        <Select<ProjectRunner>
                          size="small"
                          value={project.runner}
                          style={{ minWidth: 160 }}
                          disabled={updateRunner.isPending}
                          onChange={(value) =>
                            value !== project.runner &&
                            updateRunner.mutate({ project, runner: value })
                          }
                          options={runnerOptions}
                        />
                      ) : (
                        runnerLabels[project.runner]
                      )}
                    </dd>
                  </div>
                </dl>
                {canEdit ? (
                  <IconButton
                    label={`${local ? "检查" : "同步"} ${project.name}`}
                    disabled={syncProject.isPending}
                    onClick={() => syncProject.mutate(project)}
                  >
                    <RefreshCw size={17} className={syncProject.isPending ? "spin" : undefined} />
                  </IconButton>
                ) : null}
              </div>
            );
          })}
        </Flex>
      )}
    </div>
  );
}
