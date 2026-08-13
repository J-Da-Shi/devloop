import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Plus, RefreshCw, Server, X } from "lucide-react";
import { useState } from "react";
import type { Project } from "@devloop/shared";
import { api, queryKeys } from "../api.js";
import { EmptyState, ErrorPanel, InlineNotice, LoadingPanel } from "../components/feedback.js";
import { useNotice } from "../components/notice-provider.js";
import { formatDateTime, shortCommit } from "../utils.js";

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [baseRef, setBaseRef] = useState("main");
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
    mutationFn: api.createProject,
    onSuccess: async () => {
      await refresh();
      setShowForm(false);
      setName("");
      setRepositoryUrl("");
      notify("远程项目已注册");
    },
    onError: (error) => notify(error instanceof Error ? error.message : "项目注册失败", "danger"),
  });
  const syncProject = useMutation({
    mutationFn: (project: Project) => api.syncProject(project.id),
    onSuccess: async (data) => {
      await refresh();
      notify(`${data.project.name} 已同步远程仓库`);
    },
    onError: (error) => notify(error instanceof Error ? error.message : "项目同步失败", "danger"),
  });

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
            createProject.mutate({ name, repositoryUrl, defaultBaseRef: baseRef });
          }}
        >
          <div className="section-heading">
            <div>
              <h2>注册远程 Git 项目</h2>
              <span>服务器会克隆仓库并托管执行目录</span>
            </div>
            <Server size={19} />
          </div>
          <div className="form-grid">
            <label className="field">
              <span>项目名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
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
          </div>
          <div className="dialog-actions">
            <button
              type="submit"
              className="button button-primary"
              disabled={
                createProject.isPending ||
                !name.trim() ||
                !repositoryUrl.trim() ||
                !baseRef.trim()
              }
            >
              {createProject.isPending ? "正在克隆" : "注册项目"}
            </button>
          </div>
        </form>
      ) : null}

      {projects.data.projects.length === 0 ? (
        <EmptyState title="还没有注册远程项目" detail="先添加一个服务器可访问的 SSH Git 仓库" />
      ) : (
        <section className="object-list">
          {projects.data.projects.map((project) => (
            <article key={project.id} className="object-row">
              <span className="object-icon">
                <GitBranch size={19} />
              </span>
              <div className="object-main">
                <strong>{project.name}</strong>
                <code>{project.repositoryUrl ?? "旧本地项目，需要重新注册远程仓库"}</code>
              </div>
              <dl className="object-facts">
                <div>
                  <dt>默认分支</dt>
                  <dd>{project.defaultBaseRef}</dd>
                </div>
                <div>
                  <dt>同步 Commit</dt>
                  <dd>
                    <code>{shortCommit(project.integrationCommit)}</code>
                  </dd>
                </div>
                <div>
                  <dt>最近同步</dt>
                  <dd>{formatDateTime(project.lastFetchedAt)}</dd>
                </div>
              </dl>
              {canEdit && project.repositoryUrl ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`同步 ${project.name}`}
                  title="同步远程仓库"
                  disabled={syncProject.isPending}
                  onClick={() => syncProject.mutate(project)}
                >
                  <RefreshCw size={17} className={syncProject.isPending ? "spin" : undefined} />
                </button>
              ) : null}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
