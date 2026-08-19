# DevLoop

中文版：[README.md](./README.md)

DevLoop is a single-user, locally-running task execution system for AI-assisted development. You install an Electron client on your own machine; it spawns a local server process that only listens on `127.0.0.1` and manages the task queue, Git worktrees, structured acceptance results, and review-and-push flow. All data stays on the current device.

Each project can independently choose whether to run tasks with **Codex CLI** or **Claude Code CLI**. The choice is persisted in the local database and takes effect on the next run.

## Getting started

### End users: download the Electron installer

Coming soon. Once published you can grab the `.dmg` / `.exe` from the Releases page and use it directly.

Until then, please run from source (below).

### Developers: run from source

Requires Node.js 24 and pnpm 10.

```bash
git clone <this-repo>
cd devloop
pnpm install
pnpm dev
```

`pnpm dev` starts the local server, the web UI, and the Electron client concurrently. `pnpm dev:web` starts only the server and web UI so you can open `http://127.0.0.1:5173` in a browser.

By default the server talks to the Codex CLI already installed and logged in on your machine. You can also switch a project to Claude Code CLI from the project card (requires a working `claude` login on your machine). To verify UI and state transitions only, use the fake runner:

```bash
DEVLOOP_RUNNER=fake pnpm dev:web
```

The server supports the following environment variables. `pnpm dev` does not automatically load a root `.env` file; set them before the command, export them from your shell, or inject them through a process manager.

```bash
# Repository root used to resolve migrations, web assets, and the output schema; defaults to this repository in source runs.
DEVLOOP_REPOSITORY_ROOT=/absolute/path/to/devloop

# Server bind address; defaults to loopback-only access.
DEVLOOP_HOST=127.0.0.1

# Server bind port.
DEVLOOP_PORT=4317

# Permit binding to a non-loopback address; required when DEVLOOP_HOST is not local-only.
DEVLOOP_ALLOW_LAN=false

# Storage for the database, Git mirrors, worktrees, and skills; relative paths are resolved from the repository root.
DEVLOOP_DATA_DIR=.devloop-data

# Server log level passed to Fastify/Pino, such as trace, debug, info, warn, or error.
DEVLOOP_LOG_LEVEL=info

# Fallback runner when a project does not specify one; accepts codex or fake.
DEVLOOP_RUNNER=codex

# Codex CLI command name or absolute path.
DEVLOOP_CODEX_EXECUTABLE=codex

# Make Codex CLI ignore the user's config.toml and rule files.
DEVLOOP_CODEX_IGNORE_USER_CONFIG=false

# Continuous Codex inactivity before termination, in milliseconds; this is not a total run limit.
DEVLOOP_CODEX_STALL_TIMEOUT_MS=1800000

# Claude Code CLI command name or absolute path.
DEVLOOP_CLAUDE_CODE_EXECUTABLE=claude

# Continuous Claude Code inactivity before termination, in milliseconds; this is not a total run limit.
DEVLOOP_CLAUDE_CODE_STALL_TIMEOUT_MS=1800000

# Minimum delay before the worker claims a newly ready task, in milliseconds.
DEVLOOP_AGENT_CLAIM_DELAY_MS=5000

# Simulated execution delay for the fake runner, in milliseconds.
DEVLOOP_FAKE_RUNNER_DELAY_MS=850
```

`DEVLOOP_CODEX_TIMEOUT_MS` remains only as a compatibility alias for older releases. New configurations should use `DEVLOOP_CODEX_STALL_TIMEOUT_MS`.

### Packaging the desktop client

On macOS, produce a dmg / zip:

```bash
pnpm --filter @devloop/desktop make
```

Artifacts land in `apps/desktop/out/make/`. The desktop main process supports these environment variables:

```bash
# Use an external DevLoop Server; packaged clients do not start the bundled server when this is set.
DEVLOOP_SERVICE_URL=http://127.0.0.1:4317

# Override the renderer URL; development defaults to http://127.0.0.1:5173 and packaged builds default to the service URL.
DEVLOOP_WEB_URL=http://127.0.0.1:5173

# Open Chromium DevTools at startup; enabled only when the value is 1.
DEVLOOP_OPEN_DEVTOOLS=1

# Forward renderer console messages, load failures, and crashes to main-process stderr; enabled only when the value is 1.
DEVLOOP_LOG_RENDERER=1
```

### Optional: shared deployment

If you need multiple devices to connect to the same instance, DevLoop can be deployed to a server you control. This is not the primary path; see [DEPLOYMENT.md](./DEPLOYMENT.md).

## Runtime topology

```text
Electron client / local browser
              |
           127.0.0.1
              |
Local DevLoop Server process
├── Runner registry (Codex CLI / Claude Code CLI / Fake)
├── SQLite (tasks, run events, per-project runner config)
├── Git repositories and worktrees
└── Skills
```

In development, data lives in `.devloop-data` inside the repo. The packaged Electron app uses the OS application-data directory instead.

## Runners

The server keeps a runner registry. When `AgentWorker` claims a task, it picks a runner instance based on `project.runner`:

| Runner          | ID            | Notes                                                                                                                                                                      |
| --------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI       | `codex`       | Default runner. Requires `codex` to be installed and logged in on the host.                                                                                                |
| Claude Code CLI | `claude-code` | Contract-identical to Codex (same AgentResult schema, stall watchdog, JSON repair, process-group management). Requires `claude` to be installed and logged in on the host. |
| Fake            | `fake`        | Built-in mock runner for verifying UI and state flow. Never touches your working tree.                                                                                     |

- Switch the runner inline on the project card. `fake` is a system-level fallback and is not offered as a project choice.
- If a project points to a runner that isn't registered (for example, a CLI has been uninstalled), the worker falls back to the default runner and emits a `runner.fallback` event into the run log.
- For CLI flags, event-stream parsing, and prompt-rule details, see `packages/runners/src/codex-runner.ts` and `packages/runners/src/claude-code-runner.ts`.

## Access boundary

DevLoop has no sign-up, no login, no admin accounts, no multi-tenancy. All requests use a built-in "instance owner" identity. The deployment environment must protect the entry point:

- Local mode listens only on `127.0.0.1`.
- For the optional shared deployment, the public entry point MUST use HTTPS and add Basic Auth, IP allow-listing, or another layer of protection.
- Never expose port `4317` directly to the public internet.

## Current capabilities

- Register remote projects via SSH Git URLs, or register local Git directories directly.
- Choose Codex CLI or Claude Code CLI per project.
- Drafts with priority 100 automatically move to `READY`.
- The worker atomically claims a task 5 seconds after it becomes `READY`.
- `fetch --prune origin` runs automatically before every execution.
- When the target branch doesn't exist, the base is created from the default branch.
- Real CLI runs happen inside an isolated Git worktree.
- Final JSON output from the CLI is parsed locally, with one automatic format-repair retry.
- Server-Sent Events keep desktop and mobile views live.
- In-flight tasks can be cancelled; the CLI main process receives SIGTERM. Process-group-level cancellation (terminating CLI child processes and tool calls) is not yet wired.
- Execution tokens rotate so late-arriving results can't overwrite task state.
- Non-running tasks can be soft-deleted with history preserved.
- Approved runs are safely pushed to the target branch — never force-pushed.
- Manage versioned DevLoop Skill content and snapshot the enabled versions into each execution.
- Reuse the Provider, native Skill, and MCP configuration already available to the CLI on the host.

The worker reads all enabled Skills' current versions when claiming a task and injects the same snapshot into both the main run and the automatic conflict-resolution prompt. Task-level Skill selection is future work.

The worker validates the CLI's final JSON and produces the result commit, but there is no independent verification-command configuration yet. Standalone test commands and exit-code auditing are on the roadmap.

## Documentation

- [Development plan](./DEVELOPMENT_PLAN.md)
- [Technology selection](./TECH_SELECTION.md)
- [Project structure](./PROJECT_STRUCTURE.md)
- [Optional: shared deployment](./DEPLOYMENT.md)

## License

This project is released under the [MIT License](./LICENSE).

## Verification commands

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```
