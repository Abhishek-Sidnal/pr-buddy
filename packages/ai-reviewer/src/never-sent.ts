import {
  CREDENTIAL_FILE_PATTERNS,
  CREDENTIAL_TEMPLATE_PATTERNS,
  createPathMatcher,
  LOCKFILE_PATTERNS,
} from "@pr-buddy/review-engine";

const isCredentialFile = createPathMatcher(CREDENTIAL_FILE_PATTERNS);
const isCredentialTemplate = createPathMatcher(CREDENTIAL_TEMPLATE_PATTERNS);
const isLockfile = createPathMatcher(LOCKFILE_PATTERNS);

/**
 * Whether a file must never reach a model, whatever room is left: its name says it usually
 * holds credentials, or it is a lockfile, which is large and says nothing a reviewer can use.
 *
 * This is the one policy for both ways content can reach a model: the diff in a prompt, and
 * the runner's tools that read a checkout. Change it here and both follow.
 */
export function isNeverSentPath(path: string): boolean {
  return (isCredentialFile(path) && !isCredentialTemplate(path)) || isLockfile(path);
}
