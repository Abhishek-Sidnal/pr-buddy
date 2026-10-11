import type { ReactNode } from "react";
import type { ServiceInfo } from "../api/schemas.js";
import { ExternalLink } from "../components/common.js";
import { DataHandling } from "../components/data-handling.js";
import { plural } from "../format.js";
import { contactHref, httpsUrl } from "../operator-links.js";
import type { Resource } from "../use-resource.js";

/** How long reviews are kept, in words. `null` means the service did not say. */
function describeRetention(retentionDays: number | null): string {
  if (retentionDays === null) {
    return "This service did not say how long it keeps reviews.";
  }
  return retentionDays === 0
    ? "Reviews and their findings are kept until the app is uninstalled or the repository is removed from it."
    : `Reviews and their findings are deleted ${plural(retentionDays, "day")} after they were made.`;
}

/** Who runs this deployment, from what its operator configured. Nothing here is invented. */
function Operator(props: { readonly operator: ServiceInfo["operator"] }): ReactNode {
  const { name, contact, privacyUrl, termsUrl } = props.operator;
  const contactLink = contactHref(contact);
  const privacyLink = httpsUrl(privacyUrl);
  const termsLink = httpsUrl(termsUrl);
  const isNamed = name !== null || contact !== null;

  return (
    <section aria-labelledby="operator-heading">
      <h2 id="operator-heading">Who runs this service</h2>
      {isNamed ? (
        <dl className="facts">
          {name === null ? null : (
            <div>
              <dt>Run by</dt>
              <dd>{name}</dd>
            </div>
          )}
          {contact === null ? null : (
            <div>
              <dt>Contact</dt>
              <dd>{contactLink === undefined ? contact : <a href={contactLink}>{contact}</a>}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p>The operator of this service has not published who they are or how to reach them.</p>
      )}
      {privacyLink === undefined && termsLink === undefined ? (
        <p className="hint">
          The operator has not published a privacy policy or terms of their own.
        </p>
      ) : (
        <ul className="bullets">
          {privacyLink === undefined ? null : (
            <li>
              <ExternalLink href={privacyLink}>The operator&apos;s privacy policy</ExternalLink>
            </li>
          )}
          {termsLink === undefined ? null : (
            <li>
              <ExternalLink href={termsLink}>The operator&apos;s terms</ExternalLink>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * What this service does with data. The statements about the software are the same on every
 * deployment and are kept with the code they describe; the statements about the operator come
 * only from what the operator configured (D-091).
 */
export function PrivacyContent(props: { readonly service: Resource<ServiceInfo> }): ReactNode {
  const { service } = props;
  return (
    <div className="prose">
      <p className="page-description">
        This page describes what the PR Buddy software does with data on this service. It is a
        description, not a contract. Where the operator has a privacy policy or terms of their own,
        those are linked below and they are what the operator has promised you.
      </p>

      {service.status !== "ready" ? (
        <section aria-labelledby="operator-heading">
          <h2 id="operator-heading">Who runs this service</h2>
          <p>
            {service.status === "loading"
              ? "Asking the service who runs it…"
              : "The service did not answer who runs it. Reload the page to ask again."}
          </p>
        </section>
      ) : (
        <Operator operator={service.data.operator} />
      )}

      <section aria-labelledby="stored-heading">
        <h2 id="stored-heading">What is stored</h2>
        <DataHandling />
      </section>

      <section aria-labelledby="kept-heading">
        <h2 id="kept-heading">How long it is kept</h2>
        <ul className="bullets">
          <li>
            {describeRetention(service.status === "ready" ? service.data.retentionDays : null)}
          </li>
          <li>
            Uninstalling the app from an account deletes that account&apos;s review history, its
            stored AI key and its members&apos; sessions.
          </li>
          <li>Removing a repository from the app deletes that repository&apos;s history.</li>
          <li>A session ends after eight hours, or when you sign out.</li>
        </ul>
      </section>

      <section aria-labelledby="code-heading">
        <h2 id="code-heading">Where your code goes</h2>
        <ul className="bullets">
          <li>
            To review a pull request the service reads its changed files from GitHub. It checks them
            with fixed rules inside the service and does not keep them.
          </li>
          <li>
            Code is sent to an AI provider only for a repository that opted in with a file of its
            own. Then the changed parts of its files are sent to the provider the installation
            chose, or to this service&apos;s own provider if the installation set none. Files that
            look like credentials or lock files are not sent.
          </li>
          <li>Nothing from a repository is run, installed or checked out.</li>
        </ul>
      </section>

      <section aria-labelledby="browser-heading">
        <h2 id="browser-heading">In your browser</h2>
        <ul className="bullets">
          <li>
            One cookie keeps you signed in, and a second one exists for a few minutes while you sign
            in. Scripts cannot read either.
          </li>
          <li>Your choice of light or dark theme is kept in this browser only.</li>
          <li>There is no analytics, no advertising and no script from another site.</li>
        </ul>
      </section>

      <section aria-labelledby="parties-heading">
        <h2 id="parties-heading">Who else is involved</h2>
        <ul className="bullets">
          <li>
            GitHub, where the pull requests are and where you sign in. PR Buddy keeps no GitHub
            token of yours: it is used once at sign-in and dropped.
          </li>
          <li>
            At sign-in PR Buddy asks GitHub for your own role in each organisation where the app is
            installed, to tell whether you are an owner. It does not read or keep a list of an
            organisation&apos;s members.
          </li>
          <li>An AI provider, only as described above.</li>
          <li>Whoever hosts this deployment for its operator.</li>
        </ul>
      </section>

      <section aria-labelledby="choices-heading">
        <h2 id="choices-heading">What you can do</h2>
        <ul className="bullets">
          <li>Uninstall the app on GitHub to delete what this service holds about your account.</li>
          <li>Remove a stored AI key in the settings at any time.</li>
          <li>Write to the operator, if they published a way to reach them.</li>
        </ul>
      </section>
    </div>
  );
}
