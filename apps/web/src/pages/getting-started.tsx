import type { ReactNode } from "react";
import { Link } from "react-router";
import { aiKeys } from "../api/client.js";
import { Icon } from "../components/icon.js";
import { useResource } from "../use-resource.js";

type StepState = "done" | "next" | "later" | "optional";

const STATE_LABELS: Readonly<Record<StepState, string>> = {
  done: "Done",
  next: "Next",
  later: "Later",
  optional: "Optional",
};

function Step(props: {
  readonly state: StepState;
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <li className={`start-step start-step-${props.state}`}>
      <span className="start-step-state">
        {props.state === "done" ? <Icon name="check" /> : null}
        {STATE_LABELS[props.state]}
      </span>
      <div>
        <p className="start-step-title">{props.title}</p>
        <div className="start-step-body">{props.children}</div>
      </div>
    </li>
  );
}

/**
 * The AI step. It exists only when the service lets an installation store a key, and it is done
 * when one of this person's installations has one. While that is not known, it is left out.
 */
function AiStep(): ReactNode {
  const { resource } = useResource((signal) => aiKeys.list(signal), "getting-started-keys");
  if (resource.status !== "ready") {
    return null;
  }
  const { installations } = resource.data;
  const hasKey = installations.some((installation) => installation.aiKey !== null);
  const canManage = installations.some((installation) => installation.canManage);
  return (
    <Step state={hasKey ? "done" : "optional"} title="Turn on AI suggestions">
      {hasKey ? (
        <p>
          An AI key is stored. A repository still has to opt in: add{" "}
          <code>
            &quot;ai&quot;: {"{"} &quot;enabled&quot;: true {"}"}
          </code>{" "}
          to its <code>.github/pr-buddy.json</code> on the default branch.
        </p>
      ) : (
        <p>
          {canManage
            ? "Store an AI key for your installation, then let a repository opt in. "
            : "An owner of the account can store an AI key for the installation. "}
          <Link to="/settings">Open the settings</Link>
        </p>
      )}
    </Step>
  );
}

/**
 * What to do until the first review exists. Every state is derived from what the service
 * already knows; nothing here is ticked by hand, and the list is not shown once a review exists.
 */
export function GettingStarted(props: {
  readonly installationCount: number;
  /** Where the operator's app is installed; absent when the service does not know its app. */
  readonly installUrl: string | undefined;
}): ReactNode {
  const isInstalled = props.installationCount > 0;
  return (
    <section aria-labelledby="getting-started-heading" className="getting-started">
      <h2 id="getting-started-heading">Getting started</h2>
      <ol className="start-steps">
        <Step state={isInstalled ? "done" : "next"} title="Install the app">
          {isInstalled ? (
            <p>The app is installed where you have access.</p>
          ) : (
            <>
              <p>
                Install PR Buddy on your account or organisation and choose its repositories. If
                someone else installed it, ask them to include a repository you can access. Then
                sign out and in again: access is read at sign-in.
              </p>
              {props.installUrl === undefined ? null : (
                <a className="button button-primary" href={props.installUrl}>
                  Install on GitHub
                </a>
              )}
            </>
          )}
        </Step>
        <Step state={isInstalled ? "next" : "later"} title="Get a first review">
          <p>
            Open or push to a pull request in a repository where the app is installed. PR Buddy
            comments on it, and the review appears here. Draft pull requests are reviewed once they
            are marked ready.
          </p>
        </Step>
        {isInstalled ? <AiStep /> : null}
      </ol>
    </section>
  );
}
