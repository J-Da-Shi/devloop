import type { RunnerCapabilities } from "@devloop/shared";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerHandle,
  RunnerInput,
  RunnerResult,
} from "../types/runner-types.js";

const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Runner cancelled", "AbortError"));
      },
      { once: true },
    );
  });

export class FakeRunner implements AgentRunner {
  readonly id = "fake";

  public constructor(private readonly stepDelayMs = 450) {}

  async detectCapabilities(): Promise<RunnerCapabilities> {
    return {
      id: this.id,
      available: true,
      version: "built-in",
      executablePath: null,
      features: ["events", "cancellation", "deterministic-result"],
      error: null,
    };
  }

  start(input: RunnerInput, emit: (event: RunnerEvent) => void): RunnerHandle {
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (input.signal.aborted) {
      controller.abort();
    } else {
      input.signal.addEventListener("abort", relayAbort, { once: true });
    }

    const result = this.run(input, controller.signal, emit).finally(() => {
      input.signal.removeEventListener("abort", relayAbort);
    });

    return {
      result,
      cancel: () => controller.abort(),
    };
  }

  private async run(
    input: RunnerInput,
    signal: AbortSignal,
    emit: (event: RunnerEvent) => void,
  ): Promise<RunnerResult> {
    const role = input.role ?? "executor";
    const steps: RunnerEvent[] = [
      { type: "runner.preparing", message: "Preparing isolated execution context" },
      {
        type: "runner.agent",
        message:
          role === "planner"
            ? `Planning ${input.title}`
            : role === "verifier"
              ? `Verifying ${input.title}`
              : input.taskType === "RESEARCH"
                ? `Researching ${input.title}`
                : `Implementing ${input.title}`,
      },
      { type: "runner.verifying", message: "Running configured verification checks" },
      { type: "runner.review", message: "Preparing review package" },
    ];

    for (const step of steps) {
      if (signal.aborted) {
        throw new DOMException("Runner cancelled", "AbortError");
      }
      emit(step);
      await wait(this.stepDelayMs, signal);
    }

    const result: RunnerResult = {
      outcome: "succeeded",
      summary:
        input.taskType === "RESEARCH"
          ? `FakeRunner completed the research summary for ${input.title}.`
          : `FakeRunner completed the architecture pass for ${input.title}.`,
      risks: ["No repository files were changed by the fake runner."],
    };
    if (role === "planner") {
      result.plan = {
        summary: `FakeRunner planned ${input.title}.`,
        steps: [
          {
            id: "step-1",
            description: "完成任务目标并保持现有行为兼容",
            files: [],
            verification: "运行现有测试并核对验收标准",
          },
        ],
        acceptanceCriteria: input.acceptanceCriteria.length
          ? [...input.acceptanceCriteria]
          : ["任务目标已完成并有对应验证证据"],
        assumptions: ["FakeRunner 不会修改仓库文件"],
        risks: [],
      };
    }
    if (role === "verifier") {
      result.verification = {
        status: "passed",
        summary: `FakeRunner verified ${input.title}.`,
        criteria: input.acceptanceCriteria.map((criterion) => ({
          criterion,
          status: "passed" as const,
          evidence: "FakeRunner verification",
        })),
        checks: [],
        issues: [],
      };
    }
    return result;
  }
}
