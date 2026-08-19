<p align="right"><a href="./README.md">简体中文</a> · <strong>English</strong></p>

<a id="top"></a>

<p align="center">
  <img src="./apps/web/public/devloop-mark.svg" width="112" alt="DevLoop logo" />
</p>

<h1 align="center">DevLoop</h1>

<p align="center"><strong>Turn AI coding tasks into local, reviewable deliveries</strong></p>

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
  <a href="#how-it-delivers">How it delivers</a> ·
  <a href="#review-gate">Review gate</a> ·
  <a href="#quick-start">Get started</a> ·
  <a href="#preview-validation">Preview and validation</a> ·
  <a href="#local-boundary">Local boundary</a> ·
  <a href="#development">Development</a> ·
  <a href="#license">License</a>
</p>

---

<a id="why-devloop"></a>

## Why DevLoop

Codex CLI and Claude Code CLI are excellent at completing an individual coding request. A real project also needs to answer what changed, whether acceptance criteria were met, whether the result runs, when it may reach the target branch, and how to continue from a rejected result.

DevLoop is a local development-delivery console. It runs every Agent execution in an isolated Git worktree, pins the result as a commit, and keeps the diff, logs, automated validation, conflicts, and human review on one task record. You can move several projects forward in parallel while retaining human control over branch writes.

<a id="how-it-delivers"></a>

## From task to branch

```text
Task objective and acceptance criteria
                |
                v
Codex CLI / Claude Code CLI in an isolated worktree
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

Choose Codex CLI or Claude Code CLI per project. The worker supports 1-10 concurrent tasks. Development tasks run in their own worktrees, while research tasks enter review with structured conclusions. DevLoop also retains task revisions, Skill snapshots, and run events, so later investigation does not depend on a terminal transcript.

<a id="review-gate"></a>

## Review is the delivery gate

| Stage        | DevLoop owns                                         | You own                                            |
| ------------ | ---------------------------------------------------- | -------------------------------------------------- |
| Execution    | CLI scheduling, event capture, result commits        | Objectives, acceptance criteria, runner choice     |
| Validation   | Isolated previews, Playwright, screenshots, reports  | Product-level judgment                             |
| Review       | Changed files, patches, conflicts, Agent resolutions | Approval, rejection, or manual conflict resolution |
| Branch write | Target-state verification, application, safe push    | When a result may enter the branch                 |

When the target branch changes during execution, DevLoop produces a conflict preview. Resolve it in the UI or ask the Agent for a proposal before review; unresolved conflicts cannot be written to the target branch. A rejected task continues from the previous result commit and realigns with the latest target branch.

<a id="quick-start"></a>

## Get started

### Run from source

Requires Node.js 24 (`>=24 <27`), pnpm 10, and at least one installed and authenticated runner: `codex` or `claude`.

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

<a id="preview-validation"></a>

## Preview and automatic validation

Most projects do not need a manually configured preview command. DevLoop resolves one in this order: a project-level advanced override, the Agent's Web-start suggestion, then conservative detection from `package.json` files in the result commit. It recognizes common Vite, Next.js, Nuxt, Astro, SvelteKit, Remix, Webpack, Parcel, and Storybook scripts.

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
# Continuous CLI inactivity before termination; not a total task limit.
DEVLOOP_CODEX_STALL_TIMEOUT_MS=1800000
DEVLOOP_CLAUDE_CODE_STALL_TIMEOUT_MS=1800000

# Isolated preview and Playwright timeouts.
DEVLOOP_PREVIEW_STARTUP_TIMEOUT_MS=90000
DEVLOOP_PREVIEW_DEPENDENCY_INSTALL_TIMEOUT_MS=600000
DEVLOOP_PLAYWRIGHT_TIMEOUT_MS=60000
DEVLOOP_PLAYWRIGHT_TEST_TIMEOUT_MS=600000
```

See [`.env.example`](./.env.example) for the Docker Compose example and its commented variables.

<a id="development"></a>

## Development

DevLoop is a pnpm workspace with a Fastify server, React Web UI, Electron desktop client, and separate database, Git, runner, workflow, and shared-model packages.

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Issues and pull requests are welcome. Do not commit API keys, Git credentials, personal data from `.devloop-data`, or local artifacts generated by task runs.

<a id="license"></a>

## License

DevLoop is released under the [MIT License](./LICENSE).

## Acknowledgements

Thanks to Codex CLI, Claude Code, Electron, Fastify, Drizzle, Playwright, and the open-source projects used by DevLoop.

<p align="right"><a href="#top">Back to top ↑</a></p>
