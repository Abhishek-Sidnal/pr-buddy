import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { SIGN_IN_PATH } from "../api/client.js";
import { Notice } from "../components/common.js";
import { DataHandling } from "../components/data-handling.js";
import { Icon } from "../components/icon.js";

/**
 * What a visitor who is not signed in sees, at every address: what PR Buddy does, how to start,
 * and what it keeps. Every sentence is true of any deployment; nothing here is sample data.
 */
export function LandingPage(props: {
  /** Where the operator's app is installed; absent when the service does not know its app. */
  readonly installUrl: string | undefined;
}): ReactNode {
  const { installUrl } = props;
  const [search] = useSearchParams();
  const canInstall = installUrl !== undefined;

  return (
    <main className="landing">
      <span className="brand">
        <Icon name="brand" />
        PR Buddy
      </span>
      <h1>Pull request review that shows its evidence</h1>
      <p className="landing-lead">
        PR Buddy checks each pull request with fixed rules and keeps one comment on it up to date.
        It never merges, approves or changes code.
      </p>

      {search.get("sign-in") === "failed" ? (
        <Notice tone="danger" title="Sign-in did not complete" isAlert>
          <p>
            GitHub did not confirm the sign-in, or it took longer than ten minutes. Nothing was
            saved. Start again with the sign-in button below.
          </p>
        </Notice>
      ) : null}

      <div className="landing-actions">
        {canInstall ? (
          <a className="button button-primary" href={installUrl}>
            Install on GitHub
          </a>
        ) : null}
        <a
          className={canInstall ? "button button-secondary" : "button button-primary"}
          href={SIGN_IN_PATH}
        >
          Sign in with GitHub
        </a>
      </div>
      <p className="hint">
        {canInstall
          ? "New here? Install the app first. Already installed? Sign in to see its reviews."
          : "Sign in to see the reviews of the repositories where the app is installed."}
      </p>

      <section aria-labelledby="start-heading">
        <h2 id="start-heading">How to start</h2>
        <ol className="steps">
          <li>
            <strong>Install the app</strong> on your account or organisation and choose the
            repositories it may see. GitHub shows the exact permissions before you confirm.
          </li>
          <li>
            <strong>Open or update a pull request</strong> in one of those repositories. PR Buddy
            comments on it shortly after. Draft pull requests are reviewed once they are ready.
          </li>
          <li>
            <strong>Sign in here</strong> to see the history of reviews and their findings.
          </li>
          <li>
            <strong>Optional: AI suggestions.</strong> They are off until a repository opts in with
            a file of its own, and they need an AI provider: a key an owner stores for the
            installation, or a provider this service offers. They are shown apart from the rule
            findings and marked as not verified.
          </li>
        </ol>
      </section>

      <section aria-labelledby="data-heading">
        <h2 id="data-heading">What it stores</h2>
        <DataHandling />
        <p className="hint">
          Code is sent to an AI provider only for a repository that opted in, and only to the
          provider its installation chose, or this service&apos;s own if the installation set none.
        </p>
        <p>
          <Link to="/privacy">Privacy and data: the full account, and who runs this service</Link>
        </p>
      </section>

      <section aria-labelledby="share-heading">
        <h2 id="share-heading">What GitHub shares when you sign in</h2>
        <ul className="bullets">
          <li>Your GitHub login and ID, to show who is signed in.</li>
          <li>
            Which installations of the PR Buddy app you can access, to decide which repositories you
            may see, and whether you own them.
          </li>
        </ul>
        <p className="hint">
          PR Buddy keeps no GitHub token: it is used once during sign-in and dropped. Sessions end
          after eight hours.
        </p>
      </section>
    </main>
  );
}
