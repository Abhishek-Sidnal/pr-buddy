/** An error name is stored and logged, so anything that is not a plain identifier is replaced. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** The name of an error, and never its message: a provider's message may echo the prompt. */
export function errorNameOf(error: unknown): string {
  return error instanceof Error && ERROR_NAME.test(error.name) ? error.name : "Error";
}
