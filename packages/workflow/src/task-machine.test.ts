import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { assertTaskTransition, canTransitionTask, taskMachine } from "./task-machine.js";

describe("task transitions", () => {
  it("allows the fixed MVP path", () => {
    expect(canTransitionTask("DRAFT", "READY")).toBe(true);
    expect(canTransitionTask("READY", "RUNNING")).toBe(true);
    expect(canTransitionTask("RUNNING", "REVIEW")).toBe(true);
    expect(canTransitionTask("REVIEW", "COMPLETED")).toBe(true);
  });

  it("rejects client-side status jumps", () => {
    expect(() => assertTaskTransition("DRAFT", "COMPLETED")).toThrow(
      "Invalid task transition",
    );
  });

  it("allows blocked and failed tasks to retry directly or return to draft", () => {
    expect(canTransitionTask("BLOCKED", "READY")).toBe(true);
    expect(canTransitionTask("BLOCKED", "DRAFT")).toBe(true);
    expect(canTransitionTask("FAILED", "READY")).toBe(true);
    expect(canTransitionTask("FAILED", "DRAFT")).toBe(true);

    const actor = createActor(taskMachine).start();
    actor.send({ type: "CONFIRM" });
    actor.send({ type: "CLAIM" });
    actor.send({ type: "FAIL" });
    actor.send({ type: "REVISE" });
    expect(actor.getSnapshot().value).toBe("DRAFT");
    actor.stop();
  });
});
