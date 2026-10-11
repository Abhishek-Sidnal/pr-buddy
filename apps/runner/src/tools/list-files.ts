import { readdir } from "node:fs/promises";
import type { AiTool } from "@pr-buddy/ai-reviewer";
import { z } from "zod";
import { MAX_LIST_ENTRIES } from "../limits.js";
import { PATH_REFUSALS, resolveInCheckout } from "./checkout.js";
import { deliver, INVALID_INPUT, refuse, type ToolContext } from "./tool-context.js";

const inputSchema = z.object({ path: z.string().default("") });

const GIT_FOLDER = ".git";

/** Names sort the same way on every runner. */
export function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
}

/**
 * Lists one folder of the checkout, without going into its subfolders. Names are returned and
 * nothing is read, so nothing is recorded as read.
 */
export function createListFilesTool(context: ToolContext): AiTool {
  return {
    name: "list_files",
    description: `Lists the files and folders directly inside one folder of the repository. A folder's name ends with a slash. At most ${MAX_LIST_ENTRIES} entries.`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The folder, relative to the repository's root, with forward slashes. Leave it out for the root.",
        },
      },
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
      let entries;
      try {
        entries = await readdir(resolved.absolutePath, { withFileTypes: true });
      } catch {
        return refuse("That path is not a folder. Use read_file for a file.");
      }

      const names: string[] = [];
      let leftOutCount = 0;
      for (const entry of entries.sort(byName)) {
        if (entry.name === GIT_FOLDER) {
          continue;
        }
        if (entry.isDirectory()) {
          names.push(`${entry.name}/`);
        } else if (entry.isFile()) {
          names.push(entry.name);
        } else {
          // A symbolic link or a special file: it could not be read, so it is not offered.
          leftOutCount += 1;
        }
      }

      const where = resolved.relativePath === "" ? "The root" : `${resolved.relativePath}/`;
      const shown = names.slice(0, MAX_LIST_ENTRIES);
      const lines = [`${where} has ${names.length} ${names.length === 1 ? "entry" : "entries"}:`];
      lines.push(...shown);
      if (shown.length < names.length) {
        lines.push(`${names.length - shown.length} more are not listed.`);
      }
      if (leftOutCount > 0) {
        lines.push(`${leftOutCount} that are links or special files are left out.`);
      }
      return deliver(context, lines.join("\n"));
    },
  };
}
