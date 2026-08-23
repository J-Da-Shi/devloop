import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RunPreviewConfig } from "@devloop/shared";

export interface PreviewDependencyInstallation {
  command: string;
  workingDirectory: string;
  lockfile: string;
}

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

interface PreviewPackageManifest {
  scripts: Record<string, string>;
}

interface PreviewScriptCandidate {
  directory: string;
  script: string;
  packageManager: PackageManager;
  score: number;
}

const dependencyInstallers = [
  { lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
  { lockfile: "package-lock.json", command: "npm ci" },
  { lockfile: "yarn.lock", command: "yarn install --frozen-lockfile" },
  { lockfile: "bun.lockb", command: "bun install --frozen-lockfile" },
  { lockfile: "bun.lock", command: "bun install --frozen-lockfile" },
] as const;

const ignoredSearchDirectories = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".devloop-runtime",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
]);
const maxPreviewManifestDepth = 5;
const maxPreviewManifests = 48;
const aggregatePreviewCommandPattern =
  /\b(?:concurrently|electron|npm-run-all|run-[ps]|turbo|nx\s+run-many)\b/i;
const packageScriptInvocationPattern =
  /^\s*(?:pnpm\s+(?:run\s+)?|npm\s+run\s+|yarn\s+(?:run\s+)?|bun\s+(?:run\s+)?)([A-Za-z0-9:_-]+)(?:\s|$)/i;
const pnpmOrBunArgumentSeparatorPattern =
  /^(\s*(?:pnpm|bun)\s+(?:run\s+)?[A-Za-z0-9:_-]+)\s+--\s+(?=--(?:host|hostname|port)\b)/i;

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const parsePreviewPackageManifest = (content: string): PreviewPackageManifest | null => {
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const scriptsValue = (value as Record<string, unknown>).scripts;
    const scripts =
      scriptsValue && typeof scriptsValue === "object" && !Array.isArray(scriptsValue)
        ? Object.fromEntries(
            Object.entries(scriptsValue).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
    return { scripts };
  } catch {
    return null;
  }
};

const packageManagerForLockfile = (lockfile: string | null): PackageManager => {
  switch (lockfile) {
    case "pnpm-lock.yaml":
      return "pnpm";
    case "package-lock.json":
      return "npm";
    case "yarn.lock":
      return "yarn";
    case "bun.lockb":
    case "bun.lock":
      return "bun";
    default:
      return "npm";
  }
};

const frameworkForPreviewScript = (
  command: string,
): { score: number; nextStyleArguments: boolean } | null => {
  const lowered = command.toLowerCase();
  if (/[\r\n;&|`<>]|\$\(|\$\{/.test(command)) return null;
  if (aggregatePreviewCommandPattern.test(lowered)) return null;
  const definitions = [
    { pattern: /\bvite(?:\s|$)/, nextStyleArguments: false },
    { pattern: /\bnext\s+(?:dev|start)\b/, nextStyleArguments: true },
    { pattern: /\bnuxt\s+(?:dev|start)\b/, nextStyleArguments: false },
    { pattern: /\bastro\s+(?:dev|preview)\b/, nextStyleArguments: false },
    { pattern: /\b(?:svelte-kit|vite)\s+dev\b/, nextStyleArguments: false },
    { pattern: /\b(?:remix\s+vite:dev|(?:remix|vite)\s+dev)\b/, nextStyleArguments: false },
    { pattern: /\bwebpack(?:-cli)?\s+serve\b/, nextStyleArguments: false },
    { pattern: /\bparcel\b/, nextStyleArguments: false },
    { pattern: /\bstorybook\s+dev\b/, nextStyleArguments: false },
  ];
  for (const definition of definitions) {
    if (definition.pattern.test(lowered)) {
      return { score: 100, nextStyleArguments: definition.nextStyleArguments };
    }
  }
  return null;
};

const buildPreviewScriptCommand = (
  packageManager: PackageManager,
  script: string,
  nextStyleArguments: boolean,
): string => {
  const argumentsList = nextStyleArguments
    ? "--hostname 127.0.0.1 --port {{port}}"
    : "--host 127.0.0.1 --port {{port}}";
  switch (packageManager) {
    case "pnpm":
      return `pnpm run ${script} ${argumentsList}`;
    case "yarn":
      return `yarn run ${script} ${argumentsList}`;
    case "bun":
      return `bun run ${script} ${argumentsList}`;
    default:
      return `npm run ${script} -- ${argumentsList}`;
  }
};

export const normalizePreviewCommand = (command: string): string =>
  command.replace(pnpmOrBunArgumentSeparatorPattern, "$1 ");

const previewPackageManifests = async (
  root: string,
): Promise<Array<{ directory: string; manifest: PreviewPackageManifest }>> => {
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const manifests: Array<{ directory: string; manifest: PreviewPackageManifest }> = [];
  while (queue.length && manifests.length < maxPreviewManifests) {
    const current = queue.shift();
    if (!current) break;
    try {
      const manifest = parsePreviewPackageManifest(
        await readFile(join(current.directory, "package.json"), "utf8"),
      );
      if (manifest) manifests.push({ directory: current.directory, manifest });
    } catch {
      // 当前目录不是 Node.js 包，继续向下检查。
    }
    if (current.depth >= maxPreviewManifestDepth) continue;
    try {
      const entries = await readdir(current.directory, { withFileTypes: true, encoding: "utf8" });
      for (const entry of entries) {
        if (!entry.isDirectory() || ignoredSearchDirectories.has(entry.name)) continue;
        queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 });
      }
    } catch {
      continue;
    }
  }
  return manifests;
};

export const findPreviewDependencyInstallation = async (
  worktreePath: string,
  workingDirectory: string,
): Promise<PreviewDependencyInstallation | null> => {
  const root = resolve(worktreePath);
  let candidate = resolve(root, workingDirectory);
  const candidateRelativePath = relative(root, candidate);
  if (candidateRelativePath.startsWith("..") || isAbsolute(candidateRelativePath)) return null;
  while (true) {
    for (const installer of dependencyInstallers) {
      if (await isFile(join(candidate, installer.lockfile))) {
        return { ...installer, workingDirectory: candidate };
      }
    }
    if (candidate === root) return null;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
};

export const isAggregatePreviewCommand = async (
  workingDirectory: string,
  command: string,
): Promise<boolean> => {
  if (aggregatePreviewCommandPattern.test(command)) return true;
  const scriptName = packageScriptInvocationPattern.exec(command)?.[1];
  if (!scriptName) return false;
  try {
    const manifest = parsePreviewPackageManifest(
      await readFile(join(workingDirectory, "package.json"), "utf8"),
    );
    const scriptCommand = manifest?.scripts[scriptName];
    return scriptCommand ? aggregatePreviewCommandPattern.test(scriptCommand) : false;
  } catch {
    return false;
  }
};

export const detectPreviewConfig = async (
  worktreePath: string,
): Promise<RunPreviewConfig | null> => {
  const root = resolve(worktreePath);
  const manifests = await previewPackageManifests(root);
  const candidates: PreviewScriptCandidate[] = [];
  for (const { directory, manifest } of manifests) {
    const installation = await findPreviewDependencyInstallation(root, directory);
    const packageManager = packageManagerForLockfile(installation?.lockfile ?? null);
    for (const script of ["dev", "preview", "start"] as const) {
      const command = manifest.scripts[script];
      if (!command) continue;
      const framework = frameworkForPreviewScript(command);
      if (!framework) continue;
      const relativeDirectory = relative(root, directory);
      const directoryPreference = /(?:^|\/)(?:web|frontend|client|app)(?:\/|$)/i.test(
        relativeDirectory,
      )
        ? 8
        : 0;
      const scriptPreference = script === "dev" ? 3 : script === "preview" ? 2 : 1;
      candidates.push({
        directory,
        script,
        packageManager,
        score: framework.score + directoryPreference + scriptPreference,
      });
    }
  }
  const candidate = candidates.sort((left, right) => right.score - left.score)[0];
  if (!candidate) return null;
  const script = manifests.find((item) => item.directory === candidate.directory)?.manifest.scripts[
    candidate.script
  ];
  if (!script) return null;
  const framework = frameworkForPreviewScript(script);
  if (!framework) return null;
  return {
    source: "detected",
    command: buildPreviewScriptCommand(
      candidate.packageManager,
      candidate.script,
      framework.nextStyleArguments,
    ),
    workingDirectory: relative(root, candidate.directory) || ".",
    healthPath: "/",
  };
};
