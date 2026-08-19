import { Flex, Select } from "antd";
import { GitBranch, HardDrive, RefreshCw, Settings2 } from "lucide-react";
import type { Project, ProjectRunner } from "@devloop/shared";
import { formatDateTime, shortCommit } from "../../../core/index.js";
import { IconButton } from "../../common/index.js";
import { runnerLabels, type ProjectRunnerOption } from "./types.js";

interface ProjectListProps {
  projects: Project[];
  canEdit: boolean;
  runnerOptions: ProjectRunnerOption[];
  syncing: boolean;
  updatingRunner: boolean;
  onConfigurePreview(project: Project): void;
  onSync(project: Project): void;
  onRunnerChange(project: Project, runner: ProjectRunner): void;
}

export function ProjectList({
  projects,
  canEdit,
  runnerOptions,
  syncing,
  updatingRunner,
  onConfigurePreview,
  onSync,
  onRunnerChange,
}: ProjectListProps) {
  return (
    <Flex vertical className="object-list">
      {projects.map((project) => {
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
                      size="middle"
                      value={project.runner}
                      style={{ minWidth: 160 }}
                      disabled={updatingRunner}
                      onChange={(runner) =>
                        runner !== project.runner && onRunnerChange(project, runner)
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
              <div className="object-actions">
                <IconButton
                  label={`配置 ${project.name} 的预览`}
                  onClick={() => onConfigurePreview(project)}
                >
                  <Settings2 size={17} />
                </IconButton>
                <IconButton
                  label={`${local ? "检查" : "同步"} ${project.name}`}
                  disabled={syncing}
                  onClick={() => onSync(project)}
                >
                  <RefreshCw size={17} className={syncing ? "spin" : undefined} />
                </IconButton>
              </div>
            ) : null}
          </div>
        );
      })}
    </Flex>
  );
}
