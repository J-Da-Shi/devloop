import { access, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptsDirectory, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const runtimeRoot = join(desktopRoot, "runtime-bundle");
const serverRoot = join(runtimeRoot, "apps", "server");

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

await Promise.all([
  rm(join(serverRoot, "src"), { recursive: true, force: true }),
  rm(join(serverRoot, "tsconfig.json"), { force: true }),
]);
await Promise.all([
  access(join(serverRoot, "dist", "index.js")),
  access(join(runtimeRoot, "apps", "web", "dist", "index.html")),
  access(join(runtimeRoot, "packages", "db", "drizzle")),
  access(join(runtimeRoot, "schemas", "agent-result.v1.schema.json")),
]);

process.stdout.write(`Desktop runtime prepared at ${runtimeRoot}\n`);
