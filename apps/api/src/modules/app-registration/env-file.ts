/**
 * Puts settings into the text of an environment file. A setting that is already there is
 * replaced where it stands, so comments and order survive; one that is only there as a comment,
 * or not at all, is added at the end. Nothing else in the file is touched.
 * @throws {Error} if a name or a value could not be written as one line.
 */
export function mergeEnvFile(text: string, values: Readonly<Record<string, string>>): string {
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error("A setting's name must be capital letters, digits and underscores.");
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`The value of ${name} must be a single line.`);
    }
  }

  const remaining = new Map(Object.entries(values));
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);

  const merged = lines.map((line) => {
    const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    const value = name === undefined ? undefined : remaining.get(name);
    if (name === undefined || value === undefined) {
      return line;
    }
    remaining.delete(name);
    return `${name}=${value}`;
  });

  if (remaining.size > 0) {
    if (merged.length > 0 && merged.at(-1) !== "") {
      merged.push("");
    }
    merged.push("# Written when the GitHub App was registered.");
    for (const [name, value] of remaining) {
      merged.push(`${name}=${value}`);
    }
  }
  return merged.join(newline) + newline;
}
