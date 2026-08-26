import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const workingDirectory = process.cwd();

let repositoryRoot;
try {
  repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: workingDirectory,
    encoding: "utf8",
  }).trim();
} catch {
  console.warn("未检测到 Git 仓库，跳过提交前检查安装。");
  process.exit(0);
}

const hookPath = path.join(repositoryRoot, ".githooks", "pre-commit");
if (!existsSync(hookPath)) {
  console.warn(`未找到提交前检查脚本：${hookPath}`);
  process.exit(0);
}

try {
  execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  console.log("已启用 DevLoop 提交前格式与类型检查。");
} catch {
  console.warn("无法配置 Git hooks 路径，请手动执行 pnpm hooks:install。");
}
