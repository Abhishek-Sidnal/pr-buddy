import type { ReactNode } from "react";
import { api } from "../api/client.js";
import type { OperatorOverview, OutcomeCounts } from "../api/schemas.js";
import { EmptyState, Loaded, PageHeader, Timestamp } from "../components/common.js";
import { useResource } from "../use-resource.js";

function Figure(props: { readonly label: string; readonly value: number }): ReactNode {
  return (
    <div className="metric">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

const totalOf = (counts: OutcomeCounts): number =>
  counts.completed + counts.skipped + counts.failed;

function OutcomeRow(props: { readonly period: string; readonly counts: OutcomeCounts }): ReactNode {
  const { counts } = props;
  return (
    <tr>
      <th scope="row">{props.period}</th>
      <td>{totalOf(counts)}</td>
      <td>{counts.completed}</td>
      <td>{counts.skipped}</td>
      <td>{counts.failed}</td>
    </tr>
  );
}

function Outcomes(props: { readonly overview: OperatorOverview }): ReactNode {
  const { reviews, aiReviews } = props.overview;
  return (
    <div className="table-wrap">
      <table>
        <caption className="visually-hidden">Reviews by outcome</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">All</th>
            <th scope="col">Completed</th>
            <th scope="col">Skipped</th>
            <th scope="col">Failed</th>
          </tr>
        </thead>
        <tbody>
          <OutcomeRow period="Reviews, last 24 hours" counts={reviews.day} />
          <OutcomeRow period="Reviews, last 7 days" counts={reviews.week} />
          <OutcomeRow period="Reviews, last 30 days" counts={reviews.month} />
          <OutcomeRow period="AI reviews, last 30 days" counts={aiReviews} />
        </tbody>
      </table>
    </div>
  );
}

function Installations(props: {
  readonly installations: OperatorOverview["installations"];
}): ReactNode {
  if (props.installations.length === 0) {
    return (
      <EmptyState title="No installation has been reviewed yet">
        <p>An installation appears here after the first review of one of its repositories.</p>
      </EmptyState>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <caption className="visually-hidden">Installations, most recently active first</caption>
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Repositories</th>
            <th scope="col">Reviews, 30 days</th>
            <th scope="col">Failed, 30 days</th>
            <th scope="col">Last review</th>
            <th scope="col">Own AI key</th>
          </tr>
        </thead>
        <tbody>
          {props.installations.map((installation) => (
            <tr key={installation.installationId}>
              <th scope="row">
                {installation.account} <span className="count">{installation.installationId}</span>
              </th>
              <td>{installation.repositoryCount}</td>
              <td>{installation.reviewCount}</td>
              <td>{installation.failedCount}</td>
              <td>
                {installation.lastReviewAt === null ? (
                  "Never"
                ) : (
                  <Timestamp iso={installation.lastReviewAt} />
                )}
              </td>
              <td>{installation.aiProvider ?? "None"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * How much the service is used and how often it fails, for the people who run it. The API
 * sends account names and counts only; nothing a customer would call their work is here.
 */
export function OperatorPage(): ReactNode {
  const { resource, reload } = useResource((signal) => api.operatorOverview(signal), "operator");
  return (
    <>
      <PageHeader
        title="Service"
        description="Use and failures across every installation. Only people this deployment lists as its operators can open this page."
        action={
          <button type="button" className="button button-secondary" onClick={reload}>
            Refresh
          </button>
        }
      />
      <Loaded resource={resource} loadingLabel="Loading the service's figures…" onRetry={reload}>
        {(overview) => (
          <>
            <section aria-labelledby="service-totals-heading">
              <h2 id="service-totals-heading">Totals</h2>
              <dl className="metrics">
                <Figure label="Installations reviewed" value={overview.totals.installations} />
                <Figure label="Repositories reviewed" value={overview.totals.repositories} />
                <Figure label="People signed in" value={overview.totals.people} />
                <Figure
                  label="Stored AI keys"
                  value={overview.keysByProvider.reduce((sum, entry) => sum + entry.count, 0)}
                />
              </dl>
              {overview.keysByProvider.length === 0 ? null : (
                <p className="hint">
                  Keys by provider:{" "}
                  {overview.keysByProvider
                    .map((entry) => `${entry.provider} ${entry.count}`)
                    .join(", ")}
                  .
                </p>
              )}
            </section>

            <section aria-labelledby="service-now-heading">
              <h2 id="service-now-heading">Right now</h2>
              <dl className="metrics">
                <Figure label="Reviews running" value={overview.queue.running} />
                <Figure label="Reviews waiting" value={overview.queue.waiting} />
                <Figure label="Requested, not finished" value={overview.pending.count} />
              </dl>
              <p className="hint">
                {overview.pending.oldestRequestedAt === null ? (
                  "No review is waiting to be finished."
                ) : (
                  <>
                    The oldest unfinished request is from{" "}
                    <Timestamp iso={overview.pending.oldestRequestedAt} />. One that stays for long
                    is failing again and again.
                  </>
                )}{" "}
                Figures as of <Timestamp iso={overview.generatedAt} />.
              </p>
            </section>

            <section aria-labelledby="service-outcomes-heading">
              <h2 id="service-outcomes-heading">Outcomes</h2>
              <Outcomes overview={overview} />
            </section>

            <section aria-labelledby="service-installations-heading">
              <h2 id="service-installations-heading">Installations</h2>
              <Installations installations={overview.installations} />
              <p className="hint">
                The hundred most recently active. Repository names, pull requests and findings are
                not shown here, by design.
              </p>
            </section>
          </>
        )}
      </Loaded>
    </>
  );
}
