import { z } from "zod";
import { severitySchema } from "../findings/severity.js";

export const ruleSettingsSchema = z.strictObject({
  /** Whether the rule runs. Defaults to `true`. */
  enabled: z.boolean().optional(),
  /** Overrides the severity of every finding the rule reports. */
  severity: severitySchema.optional(),
  /** Rule-specific options, validated by the rule's own schema. */
  options: z.record(z.string(), z.unknown()).optional(),
});

export const engineConfigSchema = z.strictObject({
  /** Settings keyed by rule ID. Rules that are not listed run with their defaults. */
  rules: z.record(z.string(), ruleSettingsSchema).optional(),
});

export type RuleSettings = z.infer<typeof ruleSettingsSchema>;
export type EngineConfig = z.infer<typeof engineConfigSchema>;
