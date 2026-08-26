<p align="right"><a href="./README.md">简体中文</a> · <strong>English</strong></p>

<a id="top"></a>

<p align="center">
  <img src="./apps/web/public/devloop-mark.svg" width="112" alt="DevLoop logo" />
</p>

<h1 align="center">DevLoop</h1>

<p align="center"><strong>Define the objective, delegate execution, review the result</strong></p>

<p align="center"><a href="https://j-da-shi.github.io/devloop/">Visit the DevLoop product site →</a></p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24%2B-1B1B1F?style=flat-square&logo=nodedotjs&logoColor=4F8CFF" alt="Node.js 24+" />
  <img src="https://img.shields.io/badge/pnpm-10-1B1B1F?style=flat-square&logo=pnpm&logoColor=F69220" alt="pnpm 10" />
  <img src="https://img.shields.io/badge/TypeScript-1B1B1F?style=flat-square&logo=typescript&logoColor=4F8CFF" alt="TypeScript" />
  <img src="https://img.shields.io/badge/React-1B1B1F?style=flat-square&logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/Electron-1B1B1F?style=flat-square&logo=electron&logoColor=9FEAF9" alt="Electron" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-4F8CFF?style=flat-square" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#quick-start">
    <img src="https://img.shields.io/badge/Run%20from%20source-DevLoop-4F8CFF?style=for-the-badge&logo=github&logoColor=1B1B1F" alt="Run DevLoop from source" />
  </a>
</p>

<p align="center">
  <a href="#why-devloop">Why DevLoop</a> ·
  <a href="#capabilities">Capabilities</a> ·
  <a href="#how-it-delivers">How it delivers</a> ·
  <a href="#review-gate">Review gate</a> ·
  <a href="#quick-start">Get started</a> ·
  <a href="#managed-execution">AI managed</a> ·
  <a href="#preview-validation">Preview and validation</a> ·
  <a href="#local-boundary">Local boundary</a> ·
  <a href="#development">Development</a> ·
  <a href="#license">License</a>
</p>

---

<a id="why-devloop"></a>

## Why DevLoop

Codex CLI and Claude Code CLI are excellent at completing an individual coding request. Users should not have to supervise every Agent session: they should be able to provide an objective and acceptance criteria, delegate budgets, execution, retries, and validation to the platform, then receive a reviewable result.

DevLoop is a local-first AI-managed delivery workbench. It runs every Agent execution in an isolated Git worktree, pins the result as a commit, and keeps budgets, failure context, diffs, automated validation, conflicts, and human review on one task record. You can move several projects forward in parallel, intervene when a budget or review decision requires it, and retain human control over every branch write.

<a id="capabilities"></a>

## Capabilities

| Capability           | Supported scope                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Task types           | `DEVELOPMENT` code delivery and `RESEARCH` structured findings                                                          |
| Project sources      | SSH remote repositories or an existing local Git directory on the desktop                                               |
| Runners              | Codex CLI, Claude Code CLI, and Fake Runner; configure 1-10 concurrent workers                                          |
| Context              | Skill version snapshots, revisions, complete failed-run events, and continued iterations after rejection                |
| Agent roles          | Planner, executor, and verifier stages; plans and verification reports persist with each Run                            |
| Managed execution    | Creation-time estimates, 80% warnings, hard-limit pauses, backoff retries, and Git-checkpoint recovery                  |
| Delivery control     | Isolated worktrees, result commits, per-file diffs, conflict previews, and human or Agent-assisted resolution           |
| Automatic validation | Common Web start-command detection, isolated previews, Playwright, screenshots, console errors, and interaction results |

<a id="how-it-delivers"></a>

## From task to branch

```text
Task objective and acceptance criteria
                |
                v
Estimated range + hard limit
                |
                v
Planner Agent → Executor Agent → Verifier Agent (one isolated worktree)
                |
                v
Result commit + diff + execution log
                |
                +---- Web project: isolated preview + Playwright + screenshots
                |
                v
Human review / conflict resolution
                |
                v
Apply and push the target branch, or continue from this result
```

Choose Codex CLI or Claude Code CLI per project. The worker supports 1-10 concurrent tasks. Development tasks run in their own worktrees, while research tasks enter review with structured conclusions. DevLoop also retains task revisions, Skill snapshots, and complete run events, so later investigation does not depend on a terminal transcript. Runner stdout/stderr, event messages and payloads, preview command output, and Playwright output are not truncated by character count, array length, or nesting depth.

In managed mode, the same project Runner (Codex CLI, Claude Code CLI, or Fake Runner) executes the three roles in order: the read-only Planner produces a plan and planning acceptance criteria, the Executor applies changes in the worktree, and the read-only Verifier checks the diff, tests, and both original and planning criteria. When verification fails or omits any criterion, its report is sent back to the Executor for repair and re-verification in the same Run, up to three repair attempts by default. Only a blocked result or an exhausted repair loop ends the Run without review.

<a id="review-gate"></a>

## Review is the delivery gate

| Stage        | DevLoop owns                                                  | You own                                            |
| ------------ | ------------------------------------------------------------- | -------------------------------------------------- |
| Planning     | Read-only analysis, an actionable plan, and planning criteria | Objectives, acceptance criteria, runner choice     |
| Execution    | Run the CLI from the plan, capture events, commit results     | Objectives, acceptance criteria, runner choice     |
| Validation   | Isolated previews, Playwright, screenshots, reports           | Product-level judgment                             |
| Verification | Independently check the diff, tests, and each criterion       | Decide whether to approve delivery                 |
| Review       | Changed files, patches, conflicts, Agent resolutions          | Approval, rejection, or manual conflict resolution |
| Branch write | Target-state verification, application, safe push             | When a result may enter the branch                 |

When the target branch changes during execution, DevLoop produces a conflict preview. Resolve it in the UI or ask the Agent for a proposal before review; unresolved conflicts cannot be written to the target branch. A rejected task continues from the previous result commit and realigns with the latest target branch.

<a id="quick-start"></a>

## Get started

### Run from source

Requires Node.js 24 (`>=24 <27`), pnpm 10, and at least one installed and authenticated runner: `codex` or `claude`. Verify the CLI available in your shell:

```bash
codex --version
claude --version
```

You can use the built-in Fake Runner to inspect the UI and state transitions without either CLI.

```bash
git clone https://github.com/J-Da-Shi/devloop.git
cd devloop
pnpm install
pnpm dev
```

`pnpm dev` starts the local server, Web UI, and Electron client. For the browser UI only:

```bash
pnpm dev:web
```

Then open `http://127.0.0.1:5173`. To check only UI and state transitions, use the built-in fake runner:

```bash
DEVLOOP_RUNNER=fake pnpm dev:web
```

### Package the desktop client

On macOS, create a dmg / zip:

```bash
pnpm --filter @devloop/desktop make
```

Artifacts are written to `apps/desktop/out/make/`. Packaged clients start the bundled server by default; set `DEVLOOP_SERVICE_URL` to connect to an existing server instead.

Packaging automatically removes stale workspace build output and includes only the production dependencies for the current platform, the Web build, and database migrations. You do not need to maintain `apps/desktop/runtime-bundle/` manually.

### Docker Compose

For a server deployment, install Docker and Docker Compose, then create writable data and configuration directories:

```bash
cp .env.example .env
mkdir -p data config/codex config/ssh
docker compose up --build
```

Open `http://127.0.0.1:4317` when the container is healthy. The default binding is local-only. Put private-repository SSH configuration in `config/ssh` and Codex configuration or credentials in `config/codex`, or point the mounts at different directories in `.env`.

### Register projects and create tasks

The project page accepts an SSH remote repository or an existing local Git directory on the desktop. When creating a task, provide a title, task type, target branch, objective, and acceptance criteria, then choose Codex or Claude, whether conflicts should be auto-resolved, and any project-level settings. Tasks default to managed execution: DevLoop estimates time and cost from the objective, shows the automatic stop limit, and retries failures with backoff. At the hard limit it saves a Git checkpoint and enters Budget Paused; raise the limit to resume. Before approval, the result stays in an isolated worktree and result commit.

<a id="managed-execution"></a>

## AI-managed execution

Each task can use one of two execution modes:

- `AI Managed` (default): DevLoop handles budget estimation, execution monitoring, failure retries, checkpoint recovery, and budget protection. The user mainly provides the objective, decides on policy exceptions, and reviews the final result.
- `Standard`: keeps the single-run Agent and human-review workflow without managed budgets or automatic retries.

A managed task follows this loop:

| Stage         | What DevLoop does                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Task creation | Estimates a time range, cost range, confidence level, and suggested hard limit from the task type, objective, and criteria     |
| Running       | Runs the selected Runner in an isolated worktree, estimates consumption from elapsed time, and warns at 80% by default         |
| Failure       | Attempts to save a Git checkpoint and failure context, then creates the next revision after a backoff delay                    |
| Hard limit    | Cancels the active Runner, preserves available results, and moves the Task and Run to `BUDGET_PAUSED`                          |
| Resume        | After the user raises the hard limit or narrows the objective, the next run continues from the latest checkpoint and context   |
| Completion    | Creates a result commit, checks conflicts, runs available preview validation, and enters review without writing the target ref |

The settings page controls the maximum per-task budget, warning percentage, estimation margin, automatic retry count, and hourly estimate rates for Codex and Claude Code. A CLI inactivity timeout only detects abnormal stalls; it is not a total task duration, so a healthy long-running task is not stopped for taking longer or exceeding a fixed output size. An automatic retry revision preserves every event and payload from the failed Run. The prompt sent to the next Agent may still be compressed to fit the Codex or Claude model context window, while the original database content remains intact and temporary scratchpad entries have no per-item content-size limit while in use.

Current cost values are estimates based on Runner elapsed time and configured rates, not provider invoices. Initial estimates use task-shape heuristics. They are marked low-confidence and intentionally conservative when complexity is unclear; use measured run consumption to tune later limits and rates.

<a id="preview-validation"></a>

## Preview and automatic validation

Most projects do not need a manually configured preview command. DevLoop resolves one in this order: a project-level advanced override, the Agent's Web-start suggestion, then conservative detection from `package.json` files in the result commit. It recognizes common Vite, Next.js, Nuxt, Astro, SvelteKit, Remix, Webpack, Parcel, and Storybook scripts. If an advanced override resolves to a multi-process or desktop aggregate such as `concurrently` or Electron, DevLoop skips it and automatically searches for a standalone Web entry point.

Every preview starts from an isolated worktree at the result commit. DevLoop installs dependencies using the nearest `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, or Bun lockfile, then checks page loading and console errors, captures screenshots, and can run a project-specific Playwright command. The review page can open the preview in a dedicated desktop window or browser.

Install Chromium when automatic screenshots are needed:

```bash
pnpm exec playwright install chromium
```

You can instead set `DEVLOOP_PLAYWRIGHT_EXECUTABLE` to a compatible Chrome, Chromium, or Edge binary. Without a controllable browser, the task still reaches review and the UI explains why validation was skipped.

<a id="local-boundary"></a>

## Local runtime boundary

- DevLoop binds to `127.0.0.1` by default and has no sign-up, login, or multi-tenant service.
- The database, Git mirrors, worktrees, Skills, and run artifacts live under `DEVLOOP_DATA_DIR`. Development defaults to `.devloop-data` in the repository; packaged apps use the OS application-data directory.
- Preview and Playwright processes do not inherit DevLoop API keys, Git tokens, or other sensitive environment variables. They receive only the public variables needed to start the Web application.
- Nothing is written to the target branch before review, and DevLoop never force-pushes.
- A LAN or server deployment must be protected by HTTPS, access control, and network isolation. Do not expose port `4317` directly.

Common server settings:

```bash
# Network and local data directories.
DEVLOOP_HOST=127.0.0.1
DEVLOOP_PORT=4317
DEVLOOP_ALLOW_LAN=false
DEVLOOP_REPOSITORY_ROOT=/path/to/repositories
DEVLOOP_DATA_DIR=.devloop-data

# Default runner and executable paths; individual tasks can still choose Codex or Claude.
DEVLOOP_RUNNER=codex
DEVLOOP_CODEX_EXECUTABLE=codex
DEVLOOP_CLAUDE_CODE_EXECUTABLE=claude

# Continuous CLI inactivity before termination; not a total task limit.
DEVLOOP_CODEX_STALL_TIMEOUT_MS=1800000
DEVLOOP_CLAUDE_CODE_STALL_TIMEOUT_MS=1800000
DEVLOOP_AGENT_CLAIM_DELAY_MS=5000
DEVLOOP_FAKE_RUNNER_DELAY_MS=850
DEVLOOP_LOG_LEVEL=info

# Isolated preview and Playwright timeouts.
DEVLOOP_PREVIEW_STARTUP_TIMEOUT_MS=90000
DEVLOOP_PREVIEW_DEPENDENCY_INSTALL_TIMEOUT_MS=600000
DEVLOOP_PLAYWRIGHT_TIMEOUT_MS=60000
DEVLOOP_PLAYWRIGHT_TEST_TIMEOUT_MS=600000
DEVLOOP_PLAYWRIGHT_EXECUTABLE=/path/to/chromium
```

See [`.env.example`](./.env.example) for the complete Docker Compose example and commented variables. The reverse-proxy example is [`deploy/baota-nginx.conf`](./deploy/baota-nginx.conf).

<a id="development"></a>

## Development

DevLoop is a pnpm workspace with a Fastify server, React Web UI, Electron desktop client, and separate database, Git, runner, and shared-model packages.

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
pnpm format
git diff --check
```

Installing dependencies automatically enables the repository's built-in `.githooks/pre-commit`. Every commit runs the Prettier format check, the full workspace typecheck, and the staged-file whitespace check; any failure blocks the commit. If dependencies were installed with `--ignore-scripts`, run `pnpm hooks:install` manually. The same checks are available at any time through `pnpm quality:pre-commit`.

Pull requests run the package build, typecheck, Vitest, ESLint, Prettier, and whitespace checks on Node.js 24 and 26, with separate Server and Web builds plus a Desktop typecheck. Dependency review blocks high-severity dependency changes, while pnpm and GitHub Actions dependencies are checked for updates weekly.

Directory responsibilities: `apps/server` owns the API and Worker, grouped into `agent`, `preview`, `skills`, `routes`, `config`, and `infrastructure`; `apps/web` owns the React UI, and `apps/desktop` owns the Electron client. `packages/context` is split into compression, LLM, and storage, while `packages/db` uses database, budget, and repository groups; `packages/git` uses commands, services, and types; `packages/runners` uses adapters, execution, output, prompts, and types. `packages/shared` contains shared models. Development conventions live in [`AGENTS.md`](./AGENTS.md).

Issues and pull requests are welcome. Do not commit API keys, Git credentials, personal data from `.devloop-data`, or local artifacts generated by task runs.

<a id="license"></a>

## License

DevLoop is released under the [MIT License](./LICENSE).

## Acknowledgements

Thanks to Codex CLI, Claude Code, Electron, Fastify, Drizzle, Playwright, and the open-source projects used by DevLoop.

<p align="right"><a href="#top">Back to top ↑</a></p>
