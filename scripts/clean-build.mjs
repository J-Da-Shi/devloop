import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

for (const workspaceDirectory of ["apps", "packages"]) {
  const workspaceRoot = join(repositoryRoot, workspaceDirectory);
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        rm(join(workspaceRoot, entry.name, "dist"), { recursive: true, force: true }),
      ),
  );
}
