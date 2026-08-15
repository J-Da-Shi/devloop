import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, GitBranch, HardDrive, Plus, RefreshCw, Server, X } from "lucide-react";
import { useState } from "react";
import type { Project } from "@devloop/shared";
import { api, queryKeys } from "../api.js";
import { EmptyState, ErrorPanel, InlineNotice, LoadingPanel } from "../components/feedback.js";
import { useNotice } from "../components/notice-provider.js";
import { formatDateTime, shortCommit } from "../utils.js";

type ProjectSource = "remote" | "local";

type ProjectRegistration =
  | {
      source: "remote";
      input: { name: string; repositoryUrl: string; defaultBaseRef: string };
    }
  | { source: "local"; input: { name: string; path: string } };

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [showForm, setShowForm] = useState(false);
  const [source, setSource] = useState<ProjectSource>("remote");
  const [name, setName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [baseRef, setBaseRef] = useState("main");
  const desktopAvailable = typeof window.devloopDesktop?.selectDirectory === "function";
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: api.projects });
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    staleTime: 60_000,
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
          <button
            type="button"
            className="button button-primary"
            onClick={() => setShowForm((value) => !value)}
          >
            {showForm ? <X size={17} /> : <Plus size={17} />}
            {showForm ? "收起" : "注册项目"}
          </button>
        ) : null}
      </div>

      {!canEdit ? <InlineNotice tone="info">当前角色只能查看项目。</InlineNotice> : null}

      {showForm ? (
        <form
          className="tool-panel project-form"
          onSubmit={(event) => {
            event.preventDefault();
            createProject.mutate(
              source === "local"
                ? { source, input: { name, path: localPath } }
                : { source, input: { name, repositoryUrl, defaultBaseRef: baseRef } },
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
            <div className="project-source-control" role="group" aria-label="项目来源">
              <button
                type="button"
                className={source === "remote" ? "active" : undefined}
                aria-pressed={source === "remote"}
                onClick={() => setSource("remote")}
              >
                <Server size={16} />
                远程仓库
              </button>
              <button
                type="button"
                className={source === "local" ? "active" : undefined}
                aria-pressed={source === "local"}
                onClick={() => setSource("local")}
              >
                <FolderOpen size={16} />
                本地目录
              </button>
            </div>
          ) : null}
          <div className="form-grid">
            <label className="field">
              <span>项目名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            {source === "remote" ? (
              <>
                <label className="field">
                  <span>默认分支</span>
                  <input
                    value={baseRef}
                    onChange={(event) => setBaseRef(event.target.value)}
                    placeholder="main"
                    required
                  />
                </label>
                <label className="field field-wide">
                  <span>SSH 仓库地址</span>
                  <input
                    value={repositoryUrl}
                    onChange={(event) => setRepositoryUrl(event.target.value)}
                    placeholder="git@github.com:team/project.git"
                    autoComplete="off"
                    required
                  />
                </label>
              </>
            ) : (
              <label className="field field-wide">
                <span>项目根目录</span>
                <span className="input-action-row">
                  <input value={localPath} placeholder="选择 Git 仓库根目录" readOnly required />
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => void chooseDirectory()}
                  >
                    <FolderOpen size={17} />
                    选择目录
                  </button>
                </span>
              </label>
            )}
          </div>
          <div className="dialog-actions">
            <button
              type="submit"
              className="button button-primary"
              disabled={
                createProject.isPending ||
                !name.trim() ||
                (source === "local" ? !localPath.trim() : !repositoryUrl.trim() || !baseRef.trim())
              }
            >
              {createProject.isPending
                ? source === "local"
                  ? "正在检查"
                  : "正在克隆"
                : "注册项目"}
            </button>
          </div>
        </form>
      ) : null}

      {projects.data.projects.length === 0 ? (
        <EmptyState
          title="还没有注册项目"
          detail={desktopAvailable ? "添加远程仓库或本地 Git 目录" : "添加远程 Git 仓库"}
        />
      ) : (
        <section className="object-list">
          {projects.data.projects.map((project) => {
            const local = project.repositoryUrl === null;
            return (
              <article key={project.id} className="object-row">
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
                </dl>
                {canEdit ? (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${local ? "检查" : "同步"} ${project.name}`}
                    title={local ? "重新检查本地仓库" : "同步远程仓库"}
                    disabled={syncProject.isPending}
                    onClick={() => syncProject.mutate(project)}
                  >
                    <RefreshCw size={17} className={syncProject.isPending ? "spin" : undefined} />
                  </button>
                ) : null}
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
