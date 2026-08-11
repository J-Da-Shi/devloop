import { describe, expect, it } from "vitest";
import { assertTaskTransition, canTransitionTask } from "./task-machine.js";

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
});
