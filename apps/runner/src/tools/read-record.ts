/**
 * Which lines of which files a review was actually given. A finding must point into this
 * record or it is dropped: a model saying that it looked is not evidence (D-099).
 */
export interface ReadRecord {
  /** Records that one line of a file was returned to the model. */
  addLine(path: string, line: number): void;
  /** Records a range of lines, both ends included. */
  addRange(path: string, firstLine: number, lastLine: number): void;
  hasLine(path: string, line: number): boolean;
  /** Whether any line of the file was returned. */
  hasFile(path: string): boolean;
  readonly fileCount: number;
  readonly lineCount: number;
}

/**
 * Creates an empty record. Paths are relative to the checkout's root, with forward slashes, as
 * GitHub names files. The record grows only by what the tools return, and that is bounded by
 * the limit on their total output.
 */
export function createReadRecord(): ReadRecord {
  const linesByPath = new Map<string, Set<number>>();
  let lineCount = 0;

  const addLine = (path: string, line: number): void => {
    let lines = linesByPath.get(path);
    if (lines === undefined) {
      lines = new Set();
      linesByPath.set(path, lines);
    }
    if (!lines.has(line)) {
      lines.add(line);
      lineCount += 1;
    }
  };

  return {
    addLine,
    addRange(path, firstLine, lastLine) {
      for (let line = firstLine; line <= lastLine; line += 1) {
        addLine(path, line);
      }
    },
    hasLine: (path, line) => linesByPath.get(path)?.has(line) === true,
    hasFile: (path) => linesByPath.has(path),
    get fileCount() {
      return linesByPath.size;
    },
    get lineCount() {
      return lineCount;
    },
  };
}
