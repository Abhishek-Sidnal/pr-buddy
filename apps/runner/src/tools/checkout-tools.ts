import type { AiTool } from "@pr-buddy/ai-reviewer";
import { createListFilesTool } from "./list-files.js";
import { createReadFileTool } from "./read-file.js";
import { createSearchTool } from "./search.js";
import type { ToolContext } from "./tool-context.js";

/**
 * Every tool a model gets in runner mode: three, and each can only read the checkout. None
 * writes, starts a process, opens a connection or reads the environment (D-098).
 */
export function createCheckoutTools(context: ToolContext): readonly AiTool[] {
  return [createReadFileTool(context), createSearchTool(context), createListFilesTool(context)];
}
