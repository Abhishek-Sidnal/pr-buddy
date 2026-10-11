import type { AiTool } from "@pr-buddy/ai-reviewer";
import { z } from "zod";
import { MAX_READ_LINES, MAX_TOOL_RESPONSE_LENGTH } from "../limits.js";
import { PATH_REFUSALS, readTextFile, resolveInCheckout, TEXT_REFUSALS } from "./checkout.js";
import { cutLine, deliver, INVALID_INPUT, refuse, type ToolContext } from "./tool-context.js";

const inputSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  lineCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(MAX_READ_LINES),
});

/** Room kept for the first line of the answer, which says what follows. */
const HEADER_ROOM = 200;

/** Reads a range of lines of one file of the checkout, and records them as read. */
export function createReadFileTool(context: ToolContext): AiTool {
  return {
    name: "read_file",
    description: `Returns lines of one file of the repository, each with its line number. At most ${MAX_READ_LINES} lines per call; ask again with a later startLine for more.`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file, relative to the repository's root, with forward slashes.",
        },
        startLine: { type: "integer", description: "The first line to return. Defaults to 1." },
        lineCount: {
          type: "integer",
          description: `How many lines to return. Defaults to ${MAX_READ_LINES}, which is also the most.`,
        },
      },
      required: ["path"],
    },

    async run(input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return refuse(INVALID_INPUT);
      }
      const resolved = await resolveInCheckout(context.checkout, parsed.data.path);
      if (!resolved.ok) {
        return refuse(PATH_REFUSALS[resolved.refusal]);
      }
      const file = await readTextFile(resolved.absolutePath);
      if (!file.ok) {
        return refuse(TEXT_REFUSALS[file.refusal]);
      }

      const { relativePath } = resolved;
      const total = file.lines.length;
      const { startLine } = parsed.data;
      if (total === 0) {
        return deliver(context, `${relativePath} is empty.`);
      }
      if (startLine > total) {
        return refuse(`${relativePath} has ${total} lines; there is no line ${startLine}.`);
      }

      const wanted = Math.min(parsed.data.lineCount, MAX_READ_LINES, total - startLine + 1);
      const body: string[] = [];
      let length = 0;
      for (let line = startLine; line < startLine + wanted; line += 1) {
        const text = `${line}: ${cutLine(file.lines[line - 1] ?? "")}`;
        if (length + text.length + 1 > MAX_TOOL_RESPONSE_LENGTH - HEADER_ROOM) {
          break;
        }
        body.push(text);
        length += text.length + 1;
      }
      const lastLine = startLine + body.length - 1;
      const header = `${relativePath}, lines ${startLine} to ${lastLine} of ${total}:`;
      return deliver(context, [header, ...body].join("\n"), () => {
        context.record.addRange(relativePath, startLine, lastLine);
      });
    },
  };
}
