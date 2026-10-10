import { describe, expect, it } from "vitest";
import {
  MAX_AI_FINDINGS,
  MAX_AI_MESSAGE_LENGTH,
  MAX_AI_SUGGESTION_LENGTH,
  MAX_RESPONSE_LENGTH,
} from "../../src/limits.js";
import { parseResponse, type Suggestion } from "../../src/output/parse-response.js";
import { AI_CONFIDENCE, AI_RULE_ID, toFindings } from "../../src/output/to-findings.js";
import { addedFile, reply } from "../helpers/context.js";

const SENT = [addedFile("src/loader.ts", "export function load() {", "  return read();", "}")];

const suggestion = (overrides: Partial<Suggestion> = {}): Suggestion => ({
  message: "The result of read is returned without checking for failure.",
  severity: "medium",
  filePath: "src/loader.ts",
  line: 2,
  ...overrides,
});

describe("parseResponse", () => {
  it("reads the suggestions of a well-formed reply", () => {
    expect(parseResponse(reply(suggestion()))).toEqual({
      suggestions: [suggestion()],
      rejectedCount: 0,
    });
  });

  it("accepts a reply with no findings", () => {
    expect(parseResponse('{"findings": []}')).toEqual({ suggestions: [], rejectedCount: 0 });
  });

  it.each([
    ["a json fence", `\`\`\`json\n${reply(suggestion())}\n\`\`\``],
    ["a bare fence", `\`\`\`\n${reply(suggestion())}\n\`\`\``],
    ["surrounding blank lines", `\n\n  ${reply(suggestion())}  \n`],
  ])("accepts a reply wrapped in %s", (_name, text) => {
    expect(parseResponse(text)?.suggestions).toHaveLength(1);
  });

  it.each([
    ["prose", "I found no problems."],
    ["prose before the JSON", `Here you go: ${reply(suggestion())}`],
    ["an array", "[]"],
    ["a string", '"findings"'],
    ["null", "null"],
    ["an object without findings", '{"result": []}'],
    ["findings that are not an array", '{"findings": "none"}'],
    ["truncated JSON", '{"findings": [{"message": "cut'],
    ["an unclosed fence", '```json\n{"findings": []}'],
    ["a fence on one line", "```{}```"],
    ["an empty reply", ""],
  ])("rejects %s", (_name, text) => {
    expect(parseResponse(text)).toBeUndefined();
  });

  it("rejects a reply that is too long without parsing it", () => {
    const padded = `${reply(suggestion())}${" ".repeat(MAX_RESPONSE_LENGTH)}`;

    expect(parseResponse(padded)).toBeUndefined();
  });

  it("drops malformed entries and keeps the others", () => {
    const text = reply(
      suggestion(),
      "not an object",
      null,
      { severity: "medium" },
      { message: "No severity." },
      { message: "Unknown severity.", severity: "urgent" },
      { message: 12, severity: "low" },
      { message: "Line is text.", severity: "low", filePath: "src/loader.ts", line: "2" },
      suggestion({ line: 3 }),
    );

    const parsed = parseResponse(text);

    expect(parsed?.suggestions.map(({ line }) => line)).toEqual([2, 3]);
    expect(parsed?.rejectedCount).toBe(7);
  });

  it("ignores unknown fields and treats null as absent", () => {
    const text = reply({
      message: "General remark.",
      severity: "low",
      filePath: null,
      line: null,
      suggestion: null,
      confidence: 1,
      ruleId: "max-changed-files",
    });

    expect(parseResponse(text)?.suggestions).toEqual([
      { message: "General remark.", severity: "low", filePath: null, line: null, suggestion: null },
    ]);
  });

  it("looks only at the first entries and counts the rest as rejected", () => {
    const many = Array.from({ length: MAX_AI_FINDINGS + 5 }, () => suggestion());

    const parsed = parseResponse(reply(...many));

    expect(parsed?.suggestions).toHaveLength(MAX_AI_FINDINGS);
    expect(parsed?.rejectedCount).toBe(5);
  });
});

describe("toFindings", () => {
  it("stamps the rule ID, confidence and evidence itself", () => {
    expect(toFindings([suggestion({ suggestion: "Check the result." })], SENT)).toEqual({
      findings: [
        {
          ruleId: AI_RULE_ID,
          severity: "medium",
          confidence: AI_CONFIDENCE,
          message: "The result of read is returned without checking for failure.",
          evidence: [{ label: "Basis", value: "AI model suggestion, not verified" }],
          filePath: "src/loader.ts",
          line: 2,
          suggestion: "Check the result.",
        },
      ],
      rejectedCount: 0,
    });
  });

  it("lowers critical to high", () => {
    const { findings } = toFindings([suggestion({ severity: "critical" })], SENT);

    expect(findings[0]?.severity).toBe("high");
  });

  it("keeps a suggestion about the pull request as a whole", () => {
    const { findings } = toFindings(
      [{ message: "The change has no tests.", severity: "low" }],
      SENT,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).not.toHaveProperty("filePath");
    expect(findings[0]).not.toHaveProperty("line");
  });

  it("keeps a suggestion about a file without a line", () => {
    const { findings } = toFindings([suggestion({ line: null })], SENT);

    expect(findings[0]).toMatchObject({ filePath: "src/loader.ts" });
    expect(findings[0]).not.toHaveProperty("line");
  });

  it.each([
    ["a file that was not sent", { filePath: "src/secrets.ts", line: 1 }],
    ["a line outside the diff", { line: 40 }],
    ["line zero", { line: 0 }],
    ["a fractional line", { line: 1.5 }],
    ["a line without a file", { filePath: null, line: 2 }],
    ["a path that climbs out of the repository", { filePath: "../../etc/passwd", line: null }],
    ["an absolute path", { filePath: "/etc/passwd", line: null }],
    ["an empty message", { message: "   " }],
    ["a message that is too long", { message: "m".repeat(MAX_AI_MESSAGE_LENGTH + 1) }],
    ["advice that is too long", { suggestion: "s".repeat(MAX_AI_SUGGESTION_LENGTH + 1) }],
  ])("drops a suggestion with %s", (_name, overrides) => {
    expect(toFindings([suggestion(overrides)], SENT)).toEqual({ findings: [], rejectedCount: 1 });
  });

  it("joins a message onto one line and leaves out empty advice", () => {
    const { findings } = toFindings(
      [suggestion({ message: "First line.\n\n  Second line.", suggestion: "  \n " })],
      SENT,
    );

    expect(findings[0]?.message).toBe("First line. Second line.");
    expect(findings[0]).not.toHaveProperty("suggestion");
  });

  it("keeps one of two identical suggestions", () => {
    expect(toFindings([suggestion(), suggestion()], SENT)).toMatchObject({
      findings: [{ line: 2 }],
      rejectedCount: 1,
    });
  });

  it("orders findings by severity", () => {
    const { findings } = toFindings(
      [suggestion({ severity: "low", line: 1 }), suggestion({ severity: "high", line: 3 })],
      SENT,
    );

    expect(findings.map(({ severity }) => severity)).toEqual(["high", "low"]);
  });
});
