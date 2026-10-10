import { z } from "zod";
import { extractMeaningfulText } from "../utils/markdown.js";
import { pluralize } from "../utils/text.js";
import { defineRule } from "./rule.js";

const optionsSchema = z.strictObject({
  /** Minimum number of meaningful characters a description must have. */
  minLength: z.number().int().min(1).max(5_000).default(30),
});

export const prDescriptionRule = defineRule({
  id: "pr-description",
  version: "1.0.0",
  description: "Reports a pull request whose description is missing or too short.",
  defaultSeverity: "low",
  optionsSchema,
  run(context, options) {
    const length = extractMeaningfulText(context.pullRequest.body ?? "").length;
    if (length >= options.minLength) {
      return [];
    }

    return [
      {
        message:
          length === 0
            ? "The pull request has no description."
            : "The pull request description is too short to explain the change.",
        evidence: [
          {
            label: "Description length",
            value: `${pluralize(length, "character")}, not counting headings and HTML comments`,
          },
          { label: "Configured minimum", value: pluralize(options.minLength, "character") },
        ],
        suggestion: "Describe what the change does, why it is needed and how it was tested.",
      },
    ];
  },
});
