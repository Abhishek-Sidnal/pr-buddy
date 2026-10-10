import { z } from "zod";
import { MAX_AI_FINDINGS, MAX_RESPONSE_LENGTH } from "../limits.js";

/** What the model is asked for. Unknown fields are ignored; `null` counts as absent. */
const suggestionSchema = z.object({
  message: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  filePath: z.string().nullish(),
  line: z.number().nullish(),
  suggestion: z.string().nullish(),
});

const responseSchema = z.object({ findings: z.array(z.unknown()) });

/** One entry of a reply that has the right shape. Its content is not yet verified. */
export type Suggestion = z.infer<typeof suggestionSchema>;

export interface ParsedResponse {
  readonly suggestions: readonly Suggestion[];
  /** Entries that were not looked at or did not have the right shape. */
  readonly rejectedCount: number;
}

const FENCE = "```";

/** Models often wrap JSON in a Markdown code fence although asked not to. */
function stripCodeFence(text: string): string {
  const firstLineEnd = text.indexOf("\n");
  if (!text.startsWith(FENCE) || !text.endsWith(FENCE) || firstLineEnd === -1) {
    return text;
  }
  return text.slice(firstLineEnd + 1, -FENCE.length);
}

/**
 * Reads a model's reply. Returns `undefined` when it is not the JSON object that was asked for.
 * Entries are judged one by one, so a single bad entry does not discard the good ones.
 */
export function parseResponse(text: string): ParsedResponse | undefined {
  if (text.length > MAX_RESPONSE_LENGTH) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text.trim()));
  } catch {
    return undefined;
  }
  const response = responseSchema.safeParse(json);
  if (!response.success) {
    return undefined;
  }

  const entries = response.data.findings;
  const suggestions: Suggestion[] = [];
  for (const entry of entries.slice(0, MAX_AI_FINDINGS)) {
    const parsed = suggestionSchema.safeParse(entry);
    if (parsed.success) {
      suggestions.push(parsed.data);
    }
  }
  return { suggestions, rejectedCount: entries.length - suggestions.length };
}
