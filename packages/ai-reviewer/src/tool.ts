/** What a tool answers. It is text for the model, and is never published. */
export interface AiToolResult {
  readonly text: string;
  /** The tool did not do what was asked; `text` says why, in fixed words. */
  readonly isRefused: boolean;
}

/**
 * Something a model may ask for while it reviews. The package defines only the shape: whoever
 * runs a review decides which tools exist, and the hosted service offers none.
 */
export interface AiTool {
  /** Letters, digits and underscores, as every provider accepts. */
  readonly name: string;
  /** Fixed text that tells the model what the tool is for. */
  readonly description: string;
  /** The input as a JSON Schema object, in the form providers take. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * Runs the tool. The input comes from a model and is untrusted. A request that cannot be
   * served is answered with a refusal, not a rejection: the model can then ask differently.
   */
  run(input: unknown): Promise<AiToolResult>;
}
