import type { AiToolResult } from "@pr-buddy/ai-reviewer";
import { MAX_TOOL_LINE_LENGTH, MAX_TOTAL_TOOL_OUTPUT_LENGTH } from "../limits.js";
import type { Checkout } from "./checkout.js";
import type { ReadRecord } from "./read-record.js";

/** How much the tools of one review may still return. */
export interface OutputBudget {
  /** Takes `length` characters from what is left. False, and nothing taken, if they do not fit. */
  take(length: number): boolean;
  /** True once a call was turned away. The review should then stop. */
  readonly isExhausted: boolean;
  readonly usedLength: number;
}

export function createOutputBudget(limit: number = MAX_TOTAL_TOOL_OUTPUT_LENGTH): OutputBudget {
  let usedLength = 0;
  let isExhausted = false;
  return {
    take(length) {
      if (usedLength + length > limit) {
        isExhausted = true;
        return false;
      }
      usedLength += length;
      return true;
    },
    get isExhausted() {
      return isExhausted;
    },
    get usedLength() {
      return usedLength;
    },
  };
}

/** What every tool of one review shares. */
export interface ToolContext {
  readonly checkout: Checkout;
  readonly record: ReadRecord;
  readonly budget: OutputBudget;
}

export const INVALID_INPUT = "The input does not match what this tool takes.";
export const BUDGET_REACHED =
  "The limit on what tools may return in one review is reached. Nothing more can be read.";

export function refuse(text: string): AiToolResult {
  return { text, isRefused: true };
}

/**
 * Hands `text` to the model if the review's budget allows, and only then runs `onDelivered`,
 * which records what was read. A line is never recorded as read unless it was returned.
 */
export function deliver(
  context: ToolContext,
  text: string,
  onDelivered?: () => void,
): AiToolResult {
  if (!context.budget.take(text.length)) {
    return refuse(BUDGET_REACHED);
  }
  onDelivered?.();
  return { text, isRefused: false };
}

/** A line as it is shown to the model. */
export function cutLine(text: string): string {
  return text.length <= MAX_TOOL_LINE_LENGTH ? text : `${text.slice(0, MAX_TOOL_LINE_LENGTH)}…`;
}
