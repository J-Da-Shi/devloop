import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptsDirectory, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const runtimeRoot = join(desktopRoot, "runtime-bundle");
const serverRoot = join(runtimeRoot, "apps", "server");
const localPackageNames = ["context", "db", "git", "runners", "shared"];

const isRemovableRuntimeFile = (filePath) => {
  const fileName = basename(filePath);
  return (
    fileName.endsWith(".map") ||
    fileName.endsWith(".d.ts") ||
    fileName.endsWith(".d.ts.map") ||
    fileName.includes(".test.")
  );
};

const removeRuntimeDevelopmentFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (["__tests__", "test", "tests"].includes(entry.name)) {
          await rm(entryPath, { recursive: true, force: true });
          return;
        }
        await removeRuntimeDevelopmentFiles(entryPath);
        return;
      }
      if (entry.isFile() && isRemovableRuntimeFile(entryPath)) {
        await rm(entryPath, { force: true });
      }
    }),
  );
};

const removeLocalPackageSources = async () => {
  const packageLinksRoot = join(serverRoot, "node_modules", "@devloop");
  for (const packageName of localPackageNames) {
    await rm(join(packageLinksRoot, packageName, "src"), { recursive: true, force: true });
  }
};

const removeNativeBuildSources = async () => {
  const virtualStoreRoot = join(serverRoot, "node_modules", ".pnpm");
  const entries = await readdir(virtualStoreRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("better-sqlite3@"))
      .flatMap((entry) => {
        const packageRoot = join(virtualStoreRoot, entry.name, "node_modules", "better-sqlite3");
        return [
          rm(join(packageRoot, "deps"), { recursive: true, force: true }),
          rm(join(packageRoot, "src"), { recursive: true, force: true }),
          rm(join(packageRoot, "binding.gyp"), { force: true }),
        ];
      }),
  );
};

const removeUnusedNativePrebuilds = async () => {
  const virtualStoreRoot = join(serverRoot, "node_modules", ".pnpm");
  const packageEntries = await readdir(virtualStoreRoot, { withFileTypes: true });
  const targetPrebuildName = `${process.platform}-${process.arch}.node`;
  await Promise.all(
    packageEntries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("better-sqlite3@"))
      .map(async (entry) => {
        const prebuildRoot = join(
          virtualStoreRoot,
          entry.name,
          "node_modules",
          "better-sqlite3",
          "prebuilds",
        );
        const prebuildEntries = await readdir(prebuildRoot, { withFileTypes: true });
        if (!prebuildEntries.some((prebuild) => prebuild.name === targetPrebuildName)) {
          return;
        }
        await Promise.all(
          prebuildEntries
            .filter((prebuild) => prebuild.isFile() && prebuild.name !== targetPrebuildName)
            .map((prebuild) => rm(join(prebuildRoot, prebuild.name), { force: true })),
        );
      }),
  );
};

const removePlaywrightCliAssets = async () => {
  const virtualStoreRoot = join(serverRoot, "node_modules", ".pnpm");
  const entries = await readdir(virtualStoreRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("playwright-core@"))
      .flatMap((entry) => {
        const packageRoot = join(virtualStoreRoot, entry.name, "node_modules", "playwright-core");
        return [
          rm(join(packageRoot, "lib", "vite"), { recursive: true, force: true }),
          rm(join(packageRoot, "lib", "tools"), { recursive: true, force: true }),
        ];
      }),
  );
};

const collectProductionOutputs = async (sourceDirectory, sourceRoot = sourceDirectory) => {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  const outputs = new Set();
  for (const entry of entries) {
    const entryPath = join(sourceDirectory, entry.name);
    if (entry.isDirectory()) {
      for (const output of await collectProductionOutputs(entryPath, sourceRoot)) {
        outputs.add(output);
      }
      continue;
    }
    if (!entry.isFile() || entry.name.includes(".test.")) {
      continue;
    }
    const sourceRelativePath = relative(sourceRoot, entryPath);
    outputs.add(sourceRelativePath.replace(/\.(?:cts|mts|ts)$/, ".js"));
  }
  return outputs;
};

const removeStaleServerOutputs = async () => {
  const sourceRoot = join(repositoryRoot, "apps", "server", "src");
  const expectedOutputs = await collectProductionOutputs(sourceRoot);
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          return;
        }
        const outputRelativePath = relative(join(serverRoot, "dist"), entryPath);
        if (isRemovableRuntimeFile(entryPath) || !expectedOutputs.has(outputRelativePath)) {
          await rm(entryPath, { force: true });
        }
      }),
    );
  };
  await walk(join(serverRoot, "dist"));
};

const run = (command, args) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} 执行失败：${signal ? `signal ${signal}` : `exit ${code}`}`,
        ),
      );
    });
  });

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(dirname(serverRoot), { recursive: true });

await run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
  "--ignore-scripts",
  "--filter",
  "@devloop/server",
  "deploy",
  "--prod",
  "--legacy",
  "--config.shared-workspace-lockfile=false",
  serverRoot,
]);

await Promise.all([
  mkdir(join(runtimeRoot, "packages", "db"), { recursive: true }),
  mkdir(join(runtimeRoot, "apps", "web"), { recursive: true }),
]);
await Promise.all([
  cp(
    join(repositoryRoot, "packages", "db", "drizzle"),
    join(runtimeRoot, "packages", "db", "drizzle"),
    {
      recursive: true,
    },
  ),
  cp(join(repositoryRoot, "apps", "web", "dist"), join(runtimeRoot, "apps", "web", "dist"), {
    recursive: true,
  }),
  cp(join(repositoryRoot, "schemas"), join(runtimeRoot, "schemas"), { recursive: true }),
]);

await removeStaleServerOutputs();
await Promise.all([
  rm(join(serverRoot, "src"), { recursive: true, force: true }),
  rm(join(serverRoot, "tsconfig.json"), { force: true }),
]);
await removeRuntimeDevelopmentFiles(runtimeRoot);
await removeLocalPackageSources();
await removeNativeBuildSources();
await removeUnusedNativePrebuilds();
await removePlaywrightCliAssets();
await Promise.all([
  access(join(serverRoot, "dist", "index.js")),
  access(join(runtimeRoot, "apps", "web", "dist", "index.html")),
  access(join(runtimeRoot, "packages", "db", "drizzle")),
  access(join(runtimeRoot, "schemas", "agent-result.v1.schema.json")),
]);

process.stdout.write(`Desktop runtime prepared at ${runtimeRoot}\n`);
