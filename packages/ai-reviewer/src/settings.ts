import { z } from "zod";
import { MAX_SETTINGS_ISSUE_LENGTH } from "./limits.js";

/** The `ai` section of a repository's configuration. */
export const aiSettingsSchema = z.strictObject({
  /** Whether pull requests of this repository may be sent to the operator's AI provider. */
  enabled: z.boolean().default(false),
});

export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const AI_DISABLED: AiSettings = { enabled: false };

export type ParsedAiSettings =
  | { readonly ok: true; readonly settings: AiSettings }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Validates the untrusted `ai` section. A missing section means the AI review is off. */
export function parseAiSettings(value: unknown): ParsedAiSettings {
  const parsed = aiSettingsSchema.safeParse(value ?? {});
  if (parsed.success) {
    return { ok: true, settings: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) =>
      `${["ai", ...issue.path.map(String)].join(".")}: ${issue.message}`.slice(
        0,
        MAX_SETTINGS_ISSUE_LENGTH,
      ),
    ),
  };
}
