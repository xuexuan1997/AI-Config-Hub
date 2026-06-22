import type { CancellationSignal } from "@ai-config-hub/core";
import { AppError } from "@ai-config-hub/shared";

export interface CancellationController {
  readonly signal: CancellationSignal;
  abort(): void;
}

export function createCancellationController(): CancellationController {
  let aborted = false;
  const signal: CancellationSignal = {
    get aborted() {
      return aborted;
    },
    throwIfAborted() {
      if (!aborted) return;
      throw new AppError({
        code: "USER_CANCELLED",
        message: "The operation was cancelled",
        retryable: false,
        suggestedActions: ["Start the operation again when ready"],
      });
    },
  };
  return Object.freeze({
    signal,
    abort() {
      aborted = true;
    },
  });
}
