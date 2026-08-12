import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, GitBranch, Plus, X } from "lucide-react";
import { useState } from "react";
import { api, queryKeys } from "../api.js";
import { EmptyState, ErrorPanel, InlineNotice, LoadingPanel } from "../components/feedback.js";
import { useNotice } from "../components/notice-provider.js";
import { formatDateTime, shortCommit } from "../utils.js";

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const { notify } = useNotice();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: api.projects });
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    staleTime: 60_000,
  });
  const createProject = useMutation({
    mutationFn: api.createProject,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
      ]);
      setShowForm(false);
      setName("");
      setPath("");
      notify("项目已注册");
    },
    onError: (error) => notify(error instanceof Error ? error.message : "项目注册失败", "danger"),
  });

  if (projects.isPending) {
    return <LoadingPanel label="正在加载项目" />;
  }
  if (projects.isError) {
    return <ErrorPanel error={projects.error} />;
  }

  const local = session.data?.identity.local === true;
  const chooseDirectory = async () => {
    const selected = await window.devloopDesktop?.selectDirectory();
    if (selected) {
      setPath(selected);
      if (!name) {
        setName(selected.split("/").filter(Boolean).at(-1) ?? "");
      }
    }
  };

  return (
    <div className="page-stack">
      <div className="page-actions page-actions-end">
        {local ? (
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

      {!local ? <InlineNotice tone="info">本地项目目录只能在桌面端注册。</InlineNotice> : null}

      {showForm ? (
        <form
          className="tool-panel project-form"
          onSubmit={(event) => {
            event.preventDefault();
            createProject.mutate({ name, path, defaultBaseRef: baseRef });
          }}
        >
          <div className="section-heading">
            <h2>注册 Git 项目</h2>
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
                required
              />
            </label>
            <label className="field field-wide">
              <span>项目根目录</span>
              <span className="input-action-row">
                <input value={path} onChange={(event) => setPath(event.target.value)} required />
                {window.devloopDesktop ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={chooseDirectory}
                  >
                    <FolderOpen size={17} />
                    选择目录
                  </button>
                ) : null}
              </span>
            </label>
          </div>
          <div className="dialog-actions">
            <button
              type="submit"
              className="button button-primary"
              disabled={createProject.isPending || !name.trim() || !path.trim()}
            >
              {createProject.isPending ? "正在检查" : "注册项目"}
            </button>
          </div>
        </form>
      ) : null}

      {projects.data.projects.length === 0 ? (
        <EmptyState title="还没有注册项目" />
      ) : (
        <section className="object-list">
          {projects.data.projects.map((project) => (
            <article key={project.id} className="object-row">
              <span className="object-icon">
                <GitBranch size={19} />
              </span>
              <div className="object-main">
                <strong>{project.name}</strong>
                <code>{project.path}</code>
              </div>
              <dl className="object-facts">
                <div>
                  <dt>基线</dt>
                  <dd>{project.defaultBaseRef}</dd>
                </div>
                <div>
                  <dt>注册 Commit</dt>
                  <dd>
                    <code>{shortCommit(project.integrationCommit)}</code>
                  </dd>
                </div>
                <div>
                  <dt>更新时间</dt>
                  <dd>{formatDateTime(project.updatedAt)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
