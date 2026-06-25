import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-trial logging context propagated via AsyncLocalStorage.
 *
 * When trials run in parallel their stdout interleaves and their structured log
 * lines land in a single shared .jsonl. Carrying this context across awaits lets
 * the logger stamp every line with which trial produced it — so the jsonl stays
 * fully attributable (jq-grep-able) and stdout lines get a readable tag — without
 * threading a logger object through every function.
 */
export interface TrialContext {
  /** Stable id for the trial, e.g. "adeu/form-fill#0". */
  trialId: string;
  /** Tool-under-test id, e.g. "adeu". */
  toolId: string;
  /** Scenario id, e.g. "form-fill". */
  scenario: string;
  /** Zero-based repetition index. */
  rep: number;
}

const storage = new AsyncLocalStorage<TrialContext>();

/** Run `fn` with the given trial context bound for all nested async work. */
export function runWithTrialContext<T>(ctx: TrialContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** The active trial context, or undefined when running outside a trial. */
export function getTrialContext(): TrialContext | undefined {
  return storage.getStore();
}

/** Short stdout prefix like "[adeu/form-fill#0]", or "" outside a trial. */
export function trialTag(): string {
  const ctx = storage.getStore();
  return ctx ? `[${ctx.trialId}]` : "";
}
