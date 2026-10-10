import type { ReactNode } from "react";

/**
 * What the service stores and what it never stores. One list, shown both to a visitor who has
 * not signed in and on the settings page, so that the two cannot say different things.
 */
export function DataHandling(): ReactNode {
  return (
    <ul className="bullets">
      <li>
        Stored: repository names, pull request numbers, commit IDs, findings with file paths, counts
        and timings.
      </li>
      <li>
        Never stored: pull request titles and descriptions, source code, diffs, the text of AI
        suggestions, and GitHub tokens.
      </li>
      <li>
        An installation&apos;s AI key, if an owner sets one, is stored encrypted and is never sent
        back to a browser. It is deleted when it is removed in the settings or the app is
        uninstalled.
      </li>
      <li>Your session keeps your GitHub login and ID for at most eight hours.</li>
    </ul>
  );
}
