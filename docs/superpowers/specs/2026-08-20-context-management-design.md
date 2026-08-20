# 通用上下文管理设计（Context Management）

- 版本：v1（2026-08-20）
- 分支：`feature/context-management`
- 语言：中文
- 状态：草案，等待 review

---

## 1. 背景与目标

### 1.1 现状

DevLoop 的运行流程是 **单次性调用外部 CLI**（Codex CLI / Claude Code CLI）：
- `apps/server/src/agent-worker.ts` 从 DB 领取任务后组装 `RunnerInput`
- `packages/runners/src/task-prompt.ts` 拼出一整段 Prompt
- `packages/runners/src/codex-runner.ts` 或 `claude-code-runner.ts` 把 Prompt 传给 CLI 子进程
- CLI 内部完成多 turn 对话与工具调用，最终吐一个 JSON 给 DevLoop

**上下文管理只能作用在 DevLoop 自己拼接的文本上，CLI 内部的 turn 级内容 DevLoop 看不到。**

DevLoop 自己拼接文本的四个位点：

1. `packages/runners/src/task-prompt.ts` — 任务提示词（含 mode/title/goal/AC/reviewFeedback/retryContext/skills/schema/rules）
2. `packages/runners/src/skill-prompt.ts` — 硬 200 000 字符上限，超出即抛异常
3. `packages/db/src/repositories/repository-base.ts#buildRetryContext` — 上一轮失败诊断序列化，机械 truncate
4. `apps/server/src/agent-worker.ts` — 组装 RunnerInput 的最后一步

### 1.2 目标

引入一套 **通用上下文管理框架**，替代四处零散的截断/硬上限逻辑：

- 把内容按 9 种类型分类打标签
- 3 级触发（弱 / 中 / 强），按预算百分比自动升级
- 3 种压缩程度（弱 / 中 / 强），对 9 种类型形成 27 格处理矩阵
- 外部 scratchpad 存储原文，压缩期用 ref 引用，交付前展开
- 3 层死锁保护：3 次重试 → 硬切 → 抛异常

---

## 2. 关键决策速览

| # | 主题 | 决策 |
|---|---|---|
| 1 | 应用层次 | Layer A（DevLoop 拼接的 Prompt 与 Run 事件日志） |
| 2 | 接入范围 | 四处一次到位 |
| 3 | LLM 压缩器实现 | OpenAI 兼容 SDK/HTTP，未配置端点则 no-op |
| 4 | Scratchpad 存储 | Drizzle 表 `context_scratchpad`（迁移 0011） |
| 5 | Ref 使用方式 | 仅拼接期用 ref，交给 CLI 前自动展开 |
| 6 | 预算单位 | 估算 token 数（自实现 tokenizer） |
| 7 | 分类器 | 启发式为主，未分类走 LLM 兜底；LLM 与 LLM 压缩器共用端点/模型/冷却 |
| 8 | 硬上限行为 | `skill-prompt` 200 KB throw 由 pipeline 软降级替代 |

---

## 3. 数据模型

### 3.1 Fragment（内存态）

```ts
type ContentType =
  | "SYSTEM"           // 系统提示词
  | "USER_QUERY"       // 用户提问（title/goal/AC/reviewFeedback）
  | "AGENT_REASONING"  // agent 思考链（预留）
  | "TOOL_CALL"        // 工具调用记录（预留）
  | "TOOL_RESULT_SMALL"// 小工具调用结果（≤ 512 token）
  | "TOOL_RESULT_LARGE"// 大工具调用结果（> 512 token）
  | "SUB_ANSWER"       // 子问题答案（预留 taskChain）
  | "CITATION"         // 引用证据（skill/schema/conflictPaths）
  | "ERROR_TRACE";     // 错误信息

type CompressionLevel = "NONE" | "WEAK" | "MEDIUM" | "STRONG";

interface Fragment {
  id: string;
  type: ContentType;
  text: string;
  originalTokens: number;
  currentTokens: number;
  compressionLevel: CompressionLevel;
  droppable: boolean;
  metadata: FragmentMetadata;
}

interface FragmentMetadata {
  sourceRunId?: string;
  turnIndex?: number;
  ageTurns?: number;             // ERROR_TRACE 老化判据
  scratchpadRef?: string;        // MEDIUM 压缩后写入
  originalSizeBytes?: number;
  priority?: number;             // 数值越大越晚被弃
  source?: string;               // 启发式分类用的来源标签
}
```

### 3.2 Drizzle 表 `context_scratchpad`

```sql
CREATE TABLE context_scratchpad (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  content_text TEXT NOT NULL,
  original_tokens INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_context_scratchpad_run ON context_scratchpad(run_id);
```

- 迁移编号：`packages/db/drizzle/0011_context_scratchpad.sql`
- Key 命名：`sp_<runId>_<seq>_<sha256(text)[0:8]>`
- 单条 `content_text` 上限 1 MB，超出 `save()` 抛错触发上层 STRONG 弃

### 3.3 RunnerInput 扩展

```ts
interface RunnerInput {
  // 现有字段保持不变
  contextBudget?: number;              // token 预算，默认由 runtime-config 提供
  contextPipeline?: ContextPipeline;   // 由 agent-worker 注入
}
```

现有 status 枚举、Run 状态机、DB 表（除 0011 外）均不改动。上下文压缩是 Prompt 构建期的内部行为，对领域事件透明。

---

## 4. 分类器

### 4.1 启发式规则（首选）

| 匹配 | → 类型 | 置信度 |
|---|---|---|
| Fragment 已带 type | 原样 | 1.0 |
| source == "template.header/footer/rules" | SYSTEM | 1.0 |
| source == "task.title/goal/acceptance" | USER_QUERY | 1.0 |
| source == "review.feedback" | USER_QUERY | 1.0 |
| source == "skill" | CITATION | 1.0 |
| source == "output.schema" | CITATION | 1.0 |
| source == "conflict.path" | CITATION | 1.0 |
| event.type 含 `.failed` / 含 `_check.failed` / 含 `retry_checkpoint.failed` | ERROR_TRACE | 0.95 |
| event.type ∈ {`runner.agent`, `runner.command`, `runner.review`, `runner.verifying`} | TOOL_RESULT_SMALL/LARGE 按 size | 0.9 |
| event.type ∈ {`run.playwright.completed`, `run.conflict_check.completed`, `run.conflict_resolution.completed`} | SUB_ANSWER | 0.9 |
| event.type 以 `run.preview.` / `run.continuation.` / `runner.preparing` 开头 | TOOL_RESULT_SMALL | 0.8 |
| event.type == `runner.fallback` | ERROR_TRACE | 0.9 |
| 其他 event | TOOL_RESULT_SMALL | 0.6 |

Token 估算：`Math.ceil(cjkChars * 1.6 + otherChars / 3.5)`。

### 4.2 LLM 兜底

- 启发式置信度 < 0.5 或来源未知时调用
- **仅中/强触发时才启用**（弱触发不调 LLM 分类器）
- 与 LLM 压缩器共用同一个端点、模型、5 轮冷却
- 端点未配置时降级：未分类 Fragment 一律回落到 `CITATION`（保守：不易被弃）

### 4.3 分类时机

- 首次入 pipeline 时打标签，缓存在 Fragment 上
- 每轮压缩不重分类（除非 Fragment.text 被替换）

---

## 5. 压缩器：9 × 3 矩阵

| Type | WEAK | MEDIUM | STRONG |
|---|---|---|---|
| SYSTEM | 保留 | 保留 | 保留 |
| USER_QUERY | 保留 | 保留 | 摘要（LLM，不弃） |
| AGENT_REASONING | 头尾截断 | ref 引用 | **弃** |
| TOOL_CALL | 参数摘要 | ref 引用（看 `metadata.scratchpad_ref`） | **弃** |
| TOOL_RESULT_SMALL | 保留 | 头 500 + 尾 500 字 | 摘要一句 |
| TOOL_RESULT_LARGE | 头 2000 + 尾 500 字 | ref 引用（key 由 `metadata.scratchpad_ref`） | **弃** |
| SUB_ANSWER | 保留 | 保留 | 摘要（LLM，不弃） |
| CITATION | 保留 | 保留 | 保留 |
| ERROR_TRACE | 头 1000 + 尾 1000 字 | ref 引用 | `ageTurns ≥ 2` → **弃**；否则头尾截断 |

### 5.1 压缩器接口

```ts
interface Compressor {
  readonly type: ContentType;
  compress(fragment: Fragment, level: CompressionLevel, ctx: CompressionContext): Promise<Fragment | null>;
}

interface CompressionContext {
  scratchpad: ScratchpadStore;
  llm: LlmCompressor | null;
  budget: BudgetSnapshot;
  logger: Logger;
}
```

返回 `null` 表示 Fragment 被弃。

### 5.2 LLM 压缩器接口

```ts
interface LlmCompressor {
  summarize(text: string, opts: { targetTokens: number; hint?: string }): Promise<string>;
  isReady(): boolean;   // 冷却中或未配置端点返回 false
  cooldown(): void;     // 消费一次配额，冷却 5 轮
}
```

- 默认实现：OpenAI 兼容 HTTP 客户端，走 `fetch`（不加 `openai` 包依赖）
- 端点未配置返回 no-op 实现，pipeline 自动降级为规则型压缩

### 5.3 Ref 展开

Pipeline 输出前调用 `expandRefs(fragments, budget)`：
1. 从数组末尾开始遍历带 ref 的 Fragment（最近产生的先展开）
2. 累加 tokens 判断能否展开
3. 展开则 Fragment.text 替换为原文；无法展开则保留占位 `[REF:<key>] (原文 <bytes> 字节，因预算未展开)`

**MVP 阶段 CLI 无法回调 DevLoop，因此 ref 只是拼接期的中间态。**

---

## 6. 三级触发

### 6.1 触发决策

```
if (currentTokens <= budget * 0.60)  → "pass"
if (currentTokens <= budget * 0.60 附近) → "weak"（每轮都跑，只走规则型）
if (currentTokens <= budget * 0.90):
  if cooldownRemaining > 0 或 llm.isReady() == false → "weak"
  else → "medium"（消费 LLM 一次，冷却 5 轮）
else → "strong"
```

**「一轮」= 一次 taskPrompt 组装。** 冷却计数按 Task 维度（跨 Run 累加）存内存 map；进程重启清空。

### 6.2 主循环

```ts
async function compressUntilFits(fragments, budget) {
  let level = BudgetPolicy.decide(fragments);
  let attempts = 0;
  const MAX_STRONG_ATTEMPTS = 3;

  while (totalTokens(fragments) > budget && attempts < MAX_STRONG_ATTEMPTS) {
    fragments = await applyCompression(fragments, level);
    if (totalTokens(fragments) <= budget) break;
    level = "strong";
    attempts++;
  }

  if (totalTokens(fragments) > budget) fragments = hardCut(fragments, budget);
  if (totalTokens(fragments) > budget) {
    throw new ContextBudgetExceededError({ totalTokens, budgetTokens, remainingFragments, attempts });
  }

  return fragments;
}
```

### 6.3 硬切（`hardCut`）

- 保留全部 SYSTEM + USER_QUERY
- 其余按数组顺序**从尾部保留**，累加不超预算的加入结果
- 保留后再判 tokens

### 6.4 事件与日志

每次触发写入 `run_events`：
- `context.compress.weak`  — `{ before, after, droppedCount, refCount }`
- `context.compress.medium` — 同上 + `llmCalls`
- `context.compress.strong` — 同上 + `hardCutApplied`
- `context.compress.fatal`  — 抛异常前
- `context.compress.llm_failed` — LLM 网络失败降级

---

## 7. 四处接入点改造

### 7.1 `packages/runners/src/task-prompt.ts`

- 由拼字符串数组改为构造 `FragmentSpec[]`，走 `pipeline.compressUntilFits(fragments, budget)`
- 三个模式（implementation / conflict-resolution / research）共用一处 pipeline 入口
- `buildTaskPrompt` 签名变更：新增 `ctx: { pipeline, budget }` 参数

### 7.2 `packages/runners/src/skill-prompt.ts`

- 去掉 `MAX_SKILLS_PROMPT_CHARACTERS = 200_000` 硬上限
- 每个 skill 作为 CITATION Fragment 提交 pipeline
- 极端超大情况下 STRONG 会尝试摘要（LLM/规则型）；CITATION 类型保留策略保证不会被弃
- 原「超限抛异常」用例改成「走 ref 摘要不抛异常」

### 7.3 `packages/db/src/repositories/repository-base.ts#buildRetryContext`

- 仍从 `run_events` 表查最近 16 条（DB 层限流保留）
- 事件不再机械截断，原样带出
- 新增 helper `serializeRetryContextForPrompt(retryContext): FragmentSpec[]` 由 runners 侧调用
- `RetryContext` 类型与持久化 codec 不变

### 7.4 `apps/server/src/agent-worker.ts`

- `execute` 中构造 pipeline 与 scratchpad 注入 RunnerInput
- Run 结束（succeed/fail/block/cancel）后调用 `scratchpadStore.purgeByRun(runId)`
- 捕获 `ContextBudgetExceededError` → `finishUnsuccessfulRun("FAILED", "上下文超预算无法压缩至预算内")`

### 7.5 配置

`apps/server/src/runtime-config.ts` 新增：

```ts
context: {
  budgetTokens: {
    codex: 60_000,
    "claude-code": 100_000,
    fake: 20_000,
  },
  compressor: {
    endpoint: string | null,
    apiKey: string | null,
    model: "gpt-4o-mini",
    maxCallsPerRun: 3,
  },
}
```

环境变量：`DEVLOOP_CONTEXT_BUDGET_CODEX`、`DEVLOOP_CONTEXT_BUDGET_CLAUDE_CODE`、`DEVLOOP_CONTEXT_COMPRESSOR_ENDPOINT`、`DEVLOOP_CONTEXT_COMPRESSOR_API_KEY`、`DEVLOOP_CONTEXT_COMPRESSOR_MODEL`。

---

## 8. Package 结构

```
packages/context/
├── package.json          @devloop/context
├── tsconfig.json
├── src/
│   ├── index.ts          公开 API
│   ├── types.ts          Fragment / ContentType / CompressionLevel 等
│   ├── classifier.ts     启发式 + LLM 兜底
│   ├── budget-policy.ts  三级触发决策
│   ├── pipeline.ts       compressUntilFits 主循环 + 硬切 + 异常
│   ├── token-counter.ts  估算
│   ├── scratchpad.ts     ScratchpadStore 接口
│   ├── scratchpad-in-memory.ts
│   ├── llm-compressor.ts LlmCompressor 接口 + no-op 实现
│   ├── llm-compressor-openai.ts OpenAI 兼容 HTTP 实现
│   └── compressors/
│       ├── index.ts      9 个 compressor 注册
│       ├── system.ts
│       ├── user-query.ts
│       ├── agent-reasoning.ts
│       ├── tool-call.ts
│       ├── tool-result-small.ts
│       ├── tool-result-large.ts
│       ├── sub-answer.ts
│       ├── citation.ts
│       └── error-trace.ts
└── *.test.ts             27 格矩阵 + pipeline + classifier + policy 单元测试
```

`apps/server/src/context/`：
- `db-scratchpad-store.ts`     DevLoopRepository 适配层
- `llm-compressor-factory.ts`  按 runtime-config 构造实例

---

## 9. 测试策略

### 9.1 单元测试（`@devloop/context`）
- `classifier.test.ts` — 每种来源正确落到 9 种类型；LLM 兜底桩
- `budget-policy.test.ts` — pass/weak/medium(冷却/非冷却)/strong/3 次升级/硬切/抛异常
- `compressors/*.test.ts` — 27 格全覆盖
- `pipeline.test.ts` — 端到端：小/中/大输入 → 强度 → 展开 → 交付文本
- `token-counter.test.ts` — CJK/ASCII 混合稳定性
- `scratchpad-in-memory.test.ts` — save/load/purge 语义

### 9.2 DB 层
- `repositories-scratchpad.test.ts` — CRUD + purgeByRun + purgeOlderThan + 迁移 0011 幂等

### 9.3 Runners 层
- `task-prompt.test.ts` — mock pipeline，新增「超预算走 ref」用例
- `skill-prompt.test.ts` — 原「抛异常」用例改「走 ref 不抛异常」

### 9.4 Server 层
- `agent-worker.test.ts` — 「Run 结束后 purgeByRun 被调用」
- `context-integration.test.ts` — 端到端：伪 runner + 大 retryContext + 大 skill → 中触发 → 检查最终 prompt

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 压缩器网络失败 | 15s timeout + 单次重试；失败降级为规则型头尾截断，写 `context.compress.llm_failed` |
| Token 估算与 CLI 真实使用偏差 | 保守估算（CJK×1.6）；支持环境变量覆盖 |
| 迁移 0011 幂等 | Drizzle 生成的 `CREATE TABLE IF NOT EXISTS` 自动幂等 |
| Scratchpad 堆积 | Run 结束调用 `purgeByRun`；启动时执行 `purgeOlderThan(7 days)` |
| skill 被强触发弃掉 | CITATION 类型强级为「保留」，实际不会被弃 |
| 三种模式（impl/conflict/research）共用 pipeline | `buildTaskPrompt` 已是单入口，模式判断在函数内部；pipeline 接入一处即可 |

---

## 11. PR 拆分建议

1. **PR 1**：迁移 0011 + DB 层 CRUD + repository 测试（对现有行为零影响）
2. **PR 2**：`@devloop/context` package + 完整单元测试（独立，无接入）
3. **PR 3**：接入 task-prompt + skill-prompt + agent-worker + 集成测试（LLM 关闭，pipeline 默认只跑弱压缩）
4. **PR 4**：接入 `buildRetryContext` + 启用 LLM 压缩器（配置端点即可）

---

## 12. 验收

- 所有单元测试通过 (`pnpm test`)
- Typecheck 通过 (`pnpm typecheck`)
- ESLint 通过 (`pnpm lint`)
- 端到端：一个显然会超预算的 taskPrompt 输入 → pipeline 触发 medium → LLM 摘要或规则型压缩 → 最终 prompt ≤ 预算 → CLI 正常执行
- 兜底：一个极端超大的输入 → 3 次 strong 都失败 → 硬切保留 SYSTEM+USER_QUERY → 若仍超 → 抛 `ContextBudgetExceededError` → agent-worker 标记 Run 为 FAILED

---

## 附：Fragment 生命周期图

```
task 输入
   │
   ▼
FragmentSpec[]  ── classify ──▶  Fragment[]（带 type / droppable）
                                     │
                                     ▼
                            BudgetPolicy.decide()
                                     │
                        ┌────────────┼────────────┐
                        ▼            ▼            ▼
                      pass         weak         medium/strong
                        │            │            │
                        │       规则型压缩    LLM 摘要 / ref
                        │            │            │
                        └────────────┼────────────┘
                                     ▼
                              expandRefs(fragments)
                                     │
                                     ▼
                              最终文本 → CLI
```
