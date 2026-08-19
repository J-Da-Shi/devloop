import type { ProjectRunner } from "@devloop/shared";

export type ProjectSource = "remote" | "local";

export type ProjectRegistration =
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

export interface PreviewFormValues {
  previewCommand: string;
  previewWorkingDirectory: string;
  previewHealthPath: string;
  playwrightEnabled: boolean;
  playwrightTestCommand: string;
}

export interface ProjectRunnerOption {
  value: ProjectRunner;
  label: string;
  disabled?: boolean;
}

export const runnerLabels: Record<ProjectRunner, string> = {
  codex: "Codex CLI",
  "claude-code": "Claude Code CLI",
};
