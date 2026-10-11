import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AiTool } from "@pr-buddy/ai-reviewer";
import { z } from "zod";
import {
  MAX_SEARCH_BYTES,
  MAX_SEARCH_ENTRIES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_MATCHES,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_TOOL_RESPONSE_LENGTH,
  MIN_SEARCH_QUERY_LENGTH,
} from "../limits.js";
import { isProtectedPath, PATH_REFUSALS, readTextFile, resolveInCheckout } from "./checkout.js";
import { byName } from "./list-files.js";
import { cutLine, deliver, INVALID_INPUT, refuse, type ToolContext } from "./tool-context.js";

/** What bounds one search. Replaceable so tests reach each limit with small folders. */
export interface SearchLimits {
  readonly maxMatches: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxEntries: number;
}

export const SEARCH_LIMITS: SearchLimits = {
  maxMatches: MAX_SEARCH_MATCHES,
  maxFiles: MAX_SEARCH_FILES,
  maxBytes: MAX_SEARCH_BYTES,
  maxEntries: MAX_SEARCH_ENTRIES,
};

const inputSchema = z.object({
  query: z
    .string()
    .min(MIN_SEARCH_QUERY_LENGTH)
    .max(MAX_SEARCH_QUERY_LENGTH)
    .refine((query) => !query.includes("\n") && !query.includes("\0")),
  path: z.string().default(""),
});

/** Room kept for the lines of the answer that are not matches. */
const HEADER_ROOM = 400;

interface Match {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

interface Scan {
  readonly matches: Match[];
  filesRead: number;
  bytesRead: number;
  entriesSeen: number;
  length: number;
  isStoppedEarly: boolean;
}

interface Place {
  readonly absolutePath: string;
  readonly relativePath: string;
}

/** Looks for the text in one file. Returns false when the search must stop. */
async function scanFile(
  scan: Scan,
  file: Place,
  query: string,
  limits: SearchLimits,
): Promise<boolean> {
  if (scan.filesRead >= limits.maxFiles || scan.bytesRead >= limits.maxBytes) {
    scan.isStoppedEarly = true;
    return false;
  }
  const text = await readTextFile(file.absolutePath);
  if (!text.ok) {
    // Too large, or not text: not searched, and not a reason to stop.
    return true;
  }
  scan.filesRead += 1;
  scan.bytesRead += text.byteLength;

  for (const [index, line] of text.lines.entries()) {
    if (!line.includes(query)) {
      continue;
    }
    const shown = `${file.relativePath}:${index + 1}: ${cutLine(line)}`;
    if (
      scan.matches.length >= limits.maxMatches ||
      scan.length + shown.length + 1 > MAX_TOOL_RESPONSE_LENGTH - HEADER_ROOM
    ) {
      scan.isStoppedEarly = true;
      return false;
    }
    scan.matches.push({ path: file.relativePath, line: index + 1, text: shown });
    scan.length += shown.length + 1;
  }
  return true;
}

/**
 * Walks a folder: its files in name order, then its subfolders the same way. Links and special
 * files are passed over without being followed or opened, and so are protected names.
 */
async function scanFolder(
  scan: Scan,
  start: Place,
  query: string,
  limits: SearchLimits,
): Promise<void> {
  const waiting: Place[] = [start];
  for (let folder = waiting.pop(); folder !== undefined; folder = waiting.pop()) {
    const entries = (await readdir(folder.absolutePath, { withFileTypes: true })).sort(byName);
    const subfolders: Place[] = [];
    for (const entry of entries) {
      scan.entriesSeen += 1;
      if (scan.entriesSeen > limits.maxEntries) {
        scan.isStoppedEarly = true;
        return;
      }
      const place: Place = {
        absolutePath: join(folder.absolutePath, entry.name),
        relativePath:
          folder.relativePath === "" ? entry.name : `${folder.relativePath}/${entry.name}`,
      };
      if (isProtectedPath(place.relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        subfolders.push(place);
      } else if (entry.isFile() && !(await scanFile(scan, place, query, limits))) {
        return;
      }
    }
    // Last in, first out: pushed backwards, the subfolders come off in name order.
    waiting.push(...subfolders.reverse());
  }
}

function render(scan: Scan): string {
  const files = `${scan.filesRead} ${scan.filesRead === 1 ? "file was" : "files were"} read`;
  const lines =
    scan.matches.length === 0
      ? [`No line contains that text; ${files}.`]
      : [
          `${scan.matches.length} matching ${scan.matches.length === 1 ? "line" : "lines"}; ${files}:`,
          ...scan.matches.map((match) => match.text),
        ];
  if (scan.isStoppedEarly) {
    lines.push(
      "The search stopped at a limit, so there may be more. Narrow it with a longer text or a folder.",
    );
  }
  return lines.join("\n");
}

/**
 * Finds lines that contain a plain text. It is a literal comparison and never a pattern, so no
 * input can make it run long (D-098). Every line it returns is recorded as read.
 */
export function createSearchTool(
  context: ToolContext,
  limits: SearchLimits = SEARCH_LIMITS,
): AiTool {
  return {
    name: "search",
    description: `Finds the lines of the repository that contain a text, exactly as written and with the same capitals. It is not a pattern: no wildcards and no regular expressions. Returns the file, the line number and the line, for at most ${MAX_SEARCH_MATCHES} lines.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: `The text to find, on one line, of ${MIN_SEARCH_QUERY_LENGTH} to ${MAX_SEARCH_QUERY_LENGTH} characters.`,
        },
        path: {
          type: "string",
          description:
            "A folder or a file to search in, relative to the repository's root. Leave it out for the whole repository.",
        },
      },
      required: ["query"],
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

      const scan: Scan = {
        matches: [],
        filesRead: 0,
        bytesRead: 0,
        entriesSeen: 0,
        length: 0,
        isStoppedEarly: false,
      };
      const { query } = parsed.data;
      if ((await lstat(resolved.absolutePath)).isDirectory()) {
        await scanFolder(scan, resolved, query, limits);
      } else {
        await scanFile(scan, resolved, query, limits);
      }

      return deliver(context, render(scan), () => {
        for (const match of scan.matches) {
          context.record.addLine(match.path, match.line);
        }
      });
    },
  };
}
