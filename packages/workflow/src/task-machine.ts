import { createMachine } from "xstate";

export { assertTaskTransition, canTransitionTask } from "@devloop/shared";

export const taskMachine = createMachine({
  id: "task",
  initial: "DRAFT",
  states: {
    DRAFT: { on: { CONFIRM: "READY", CANCEL: "CANCELLED" } },
    READY: { on: { UNCONFIRM: "DRAFT", CLAIM: "RUNNING", CANCEL: "CANCELLED" } },
    RUNNING: {
      on: {
        REQUEST_REVIEW: "REVIEW",
        BLOCK: "BLOCKED",
        FAIL: "FAILED",
        CANCEL: "CANCELLED",
      },
    },
    REVIEW: { on: { APPROVE: "COMPLETED", REJECT: "READY", CANCEL: "CANCELLED" } },
    BLOCKED: { on: { RETRY: "READY" } },
    FAILED: { on: { RETRY: "READY" } },
    COMPLETED: { type: "final" },
    CANCELLED: { type: "final" },
  },
});
