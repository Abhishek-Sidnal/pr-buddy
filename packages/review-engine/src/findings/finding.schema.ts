import { z } from "zod";
import { repoPathSchema } from "../context/repo-path.js";
import {
  MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_LABEL_LENGTH,
  MAX_EVIDENCE_VALUE_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_SUGGESTION_LENGTH,
} from "../limits.js";
import { ruleIdSchema } from "./rule-id.js";
import { severitySchema } from "./severity.js";

/** One fact a finding is based on, for example `{ label: "Files changed", value: "42" }`. */
export const evidenceSchema = z.strictObject({
  label: z.string().min(1).max(MAX_EVIDENCE_LABEL_LENGTH),
  value: z.string().min(1).max(MAX_EVIDENCE_VALUE_LENGTH),
});

const findingDetails = {
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  evidence: z.array(evidenceSchema).min(1).max(MAX_EVIDENCE_ITEMS),
  filePath: repoPathSchema.optional(),
  /** 1-based line on the new side of the diff. Requires `filePath`. */
  line: z.number().int().min(1).optional(),
  suggestion: z.string().min(1).max(MAX_SUGGESTION_LENGTH).optional(),
};

const confidenceSchema = z.number().min(0).max(1);

/** What a rule returns. The engine adds the rule ID and resolves severity and confidence. */
export const findingDraftSchema = z.strictObject({
  ...findingDetails,
  severity: severitySchema.optional(),
  confidence: confidenceSchema.optional(),
});

/** A validated finding as reported to the caller. */
export const findingSchema = z.strictObject({
  ...findingDetails,
  ruleId: ruleIdSchema,
  severity: severitySchema,
  confidence: confidenceSchema,
});

export type Evidence = z.infer<typeof evidenceSchema>;
export type RuleFindingDraft = z.infer<typeof findingDraftSchema>;
export type ReviewFinding = z.infer<typeof findingSchema>;
