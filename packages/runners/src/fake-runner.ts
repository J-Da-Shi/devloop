import type { RunnerCapabilities } from "@devloop/shared";
import type { AgentRunner, RunnerEvent, RunnerHandle, RunnerInput, RunnerResult } from "./types.js";

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
    const steps: RunnerEvent[] = [
      { type: "runner.preparing", message: "Preparing isolated execution context" },
      {
        type: "runner.agent",
        message:
          input.taskType === "RESEARCH"
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

    return {
      outcome: "succeeded",
      summary:
        input.taskType === "RESEARCH"
          ? `FakeRunner completed the research summary for ${input.title}.`
          : `FakeRunner completed the architecture pass for ${input.title}.`,
      risks: ["No repository files were changed by the fake runner."],
    };
  }
}
