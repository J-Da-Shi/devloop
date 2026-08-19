import { Button, Form, Input, Segmented, Select } from "antd";
import { FolderOpen, HardDrive, Server } from "lucide-react";
import { useState } from "react";
import type { ProjectRunner } from "@devloop/shared";
import type { ProjectRegistration, ProjectRunnerOption, ProjectSource } from "./types.js";

interface ProjectRegistrationFormProps {
  desktopAvailable: boolean;
  runnerOptions: ProjectRunnerOption[];
  submitting: boolean;
  onSubmit(registration: ProjectRegistration): Promise<unknown>;
  onDirectoryError(message: string): void;
}

export function ProjectRegistrationForm({
  desktopAvailable,
  runnerOptions,
  submitting,
  onSubmit,
  onDirectoryError,
}: ProjectRegistrationFormProps) {
  const [source, setSource] = useState<ProjectSource>("remote");
  const [name, setName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [baseRef, setBaseRef] = useState("main");
  const [runner, setRunner] = useState<ProjectRunner>("codex");

  const reset = () => {
    setName("");
    setRepositoryUrl("");
    setLocalPath("");
    setBaseRef("main");
    setRunner("codex");
  };

  const chooseDirectory = async () => {
    try {
      const selectDirectory = window.devloopDesktop?.selectDirectory;
      if (!selectDirectory) {
        onDirectoryError("客户端版本过旧，请完全退出并重新启动 DevLoop");
        return;
      }
      const selected = await selectDirectory();
      if (!selected) return;
      setLocalPath(selected);
      if (!name.trim()) {
        setName(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
      }
    } catch (error) {
      onDirectoryError(error instanceof Error ? error.message : "无法打开目录选择器");
    }
  };

  return (
    <Form
      layout="vertical"
      requiredMark={false}
      className="tool-panel project-form"
      onFinish={() => {
        const registration: ProjectRegistration =
          source === "local"
            ? { source, input: { name, path: localPath, runner } }
            : { source, input: { name, repositoryUrl, defaultBaseRef: baseRef, runner } };
        void onSubmit(registration)
          .then(reset)
          .catch(() => undefined);
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
          <Select<ProjectRunner> value={runner} onChange={setRunner} options={runnerOptions} />
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
              <Button icon={<FolderOpen size={17} />} onClick={() => void chooseDirectory()}>
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
          loading={submitting}
          disabled={
            !name.trim() ||
            (source === "local" ? !localPath.trim() : !repositoryUrl.trim() || !baseRef.trim())
          }
        >
          {submitting && source === "local" ? "正在检查" : "注册项目"}
        </Button>
      </div>
    </Form>
  );
}
