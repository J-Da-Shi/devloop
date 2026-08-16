import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2];
if (command !== "package" && command !== "make") {
  throw new Error("run-forge 只支持 package 或 make");
}

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(
  desktopRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-forge.cmd" : "electron-forge",
);
const child = spawn(executable, [command, ...process.argv.slice(3)], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    npm_config_hoist_pattern: "*",
  },
});

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (code === 0) {
    return;
  }
  process.exitCode = code ?? 1;
  if (signal) {
    process.stderr.write(`electron-forge ${command} 被信号 ${signal} 终止\n`);
  }
});
