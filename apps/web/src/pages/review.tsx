import { useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../api/client.js";
import type { AiReview, Finding, ReviewDetails, RuleExecution } from "../api/schemas.js";
import {
  ExternalLink,
  isKnownSeverity,
  Loaded,
  Notice,
  PageHeader,
  SEVERITIES,
  SeverityBadge,
  SourceLabel,
  StatusBadge,
  Timestamp,
} from "../components/common.js";
import { Icon } from "../components/icon.js";
import { formatDuration, formatPercent, plural, shortCommit } from "../format.js";
import { commitUrl, pullRequestUrl } from "../github-links.js";
import { useResource } from "../use-resource.js";

const SKIP_EXPLANATIONS: Readonly<Record<string, string>> = {
  draft: "The pull request was a draft. It is reviewed when it is marked ready for review.",
  closed: "The pull request was closed or merged before it could be reviewed.",
  stale:
    "A newer commit arrived while this review ran, so its result was not published. That commit has its own review.",
  runner:
    "This repository selects runner mode: a GitHub Action reviews its pull requests in its own CI, so the service did not. The result is on the pull request, not here.",
};

const COMMENT_ACTIONS: Readonly<Record<string, string>> = {
  created: "A summary comment was posted on the pull request.",
  updated: "The summary comment on the pull request was updated.",
  none: "There was nothing to report, so no comment was posted.",
};

/** What happened, in a sentence, with what to do about it where something can be done. */
function OutcomeNotice(props: { readonly review: ReviewDetails }): ReactNode {
  const { review } = props;
  if (review.status === "failed") {
    const status = review.errorStatus === null ? "" : `, HTTP ${review.errorStatus}`;
    return (
      <Notice tone="danger" title="This review did not finish">
        <p>
          Reason recorded: <code>{review.errorName ?? "unknown error"}</code>
          {status}.
        </p>
        <p>
          Running it again is safe: PR Buddy keeps one comment per pull request and updates it. A
          new push starts a review, and the failed webhook delivery can be redelivered from the
          app&apos;s settings on GitHub.
        </p>
      </Notice>
    );
  }
  if (review.status === "skipped") {
    return (
      <Notice tone="info" title="This review was skipped">
        <p>
          {SKIP_EXPLANATIONS[review.skipReason ?? ""] ??
            `Reason recorded: ${review.skipReason ?? "none"}.`}
        </p>
      </Notice>
    );
  }
  return null;
}

function countBySeverity(findings: readonly Finding[], severity: string): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

/** The review at a glance. Counts come from the stored findings; nothing here is estimated. */
function SummaryStrip(props: { readonly review: ReviewDetails }): ReactNode {
  const { review } = props;
  return (
    <section aria-label="Summary">
      <dl className="summary">
        <div>
          <dt>Outcome</dt>
          <dd>
            <StatusBadge status={review.status} />
          </dd>
        </div>
        {review.status === "completed"
          ? SEVERITIES.map((severity) => (
              <div key={severity}>
                <dt>
                  <SeverityBadge severity={severity} />
                </dt>
                <dd className="summary-count">{countBySeverity(review.findings, severity)}</dd>
              </div>
            ))
          : null}
        {review.aiReview === null ? null : (
          <div>
            <dt>AI suggestions</dt>
            <dd className="summary-count">{review.aiReview.findingCount}</dd>
          </div>
        )}
      </dl>
      {review.status === "completed" ? (
        <ul className="summary-notes">
          <li>{COMMENT_ACTIONS[review.commentAction ?? ""] ?? "The review completed."}</li>
          {review.suppressedFindingCount > 0 ? (
            <li>
              {plural(review.suppressedFindingCount, "finding")} below this repository&apos;s
              reporting thresholds {review.suppressedFindingCount === 1 ? "is" : "are"} not shown.
            </li>
          ) : null}
          {review.skippedFileCount > 0 ? (
            <li>
              {plural(review.skippedFileCount, "file")} could not be reviewed because of an unusual
              path or format.
            </li>
          ) : null}
          {review.omittedPatchCount > 0 ? (
            <li>
              {plural(review.omittedPatchCount, "diff")}{" "}
              {review.omittedPatchCount === 1 ? "was" : "were"} too large to load; those files were
              checked by name only.
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

function describeLocation(finding: Finding): string | undefined {
  if (finding.filePath === null) {
    return undefined;
  }
  return finding.line === null ? finding.filePath : `${finding.filePath}:${finding.line}`;
}

/** The findings, most severe first, as links that select one. The address keeps the selection. */
function FindingList(props: {
  readonly findings: readonly Finding[];
  readonly selected: number;
}): ReactNode {
  const groups = [...SEVERITIES, "other"] as const;
  return (
    <nav aria-label="Findings" className="finding-list">
      {groups.map((group) => {
        const entries = props.findings
          .map((finding, index) => ({ finding, index }))
          .filter(({ finding }) =>
            group === "other" ? !isKnownSeverity(finding.severity) : finding.severity === group,
          );
        if (entries.length === 0) {
          return null;
        }
        return (
          <div key={group}>
            <h3>
              {group === "other" ? "Other" : <SeverityBadge severity={group} />}
              <span className="count">{entries.length}</span>
            </h3>
            <ul>
              {entries.map(({ finding, index }) => (
                <li key={index}>
                  <Link
                    to={`?finding=${index + 1}`}
                    replace
                    preventScrollReset
                    aria-current={index === props.selected ? "true" : undefined}
                  >
                    <code>{finding.ruleId}</code>
                    <span className="finding-list-message">{finding.message}</span>
                    {finding.filePath === null ? null : (
                      <span className="finding-list-path">{describeLocation(finding)}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

type CopyState = "idle" | "copied" | "failed";

const COPY_LABELS: Readonly<Record<CopyState, string>> = {
  idle: "Copy path",
  copied: "Path copied",
  failed: "Could not copy",
};

function CopyPathButton(props: { readonly path: string }): ReactNode {
  const [state, setState] = useState<CopyState>("idle");
  const copy = (): void => {
    navigator.clipboard.writeText(props.path).then(
      () => {
        setState("copied");
      },
      () => {
        setState("failed");
      },
    );
  };
  return (
    <button type="button" className="button button-quiet" onClick={copy}>
      <Icon name="copy" />
      <span aria-live="polite">{COPY_LABELS[state]}</span>
    </button>
  );
}

function FindingDetail(props: { readonly finding: Finding }): ReactNode {
  const { finding } = props;
  return (
    <article className="finding-detail" aria-label="Selected finding">
      <p className="finding-meta">
        <SeverityBadge severity={finding.severity} />
        <code>{finding.ruleId}</code>
        <SourceLabel source="rule" />
      </p>
      <h3>{finding.message}</h3>

      <dl className="facts">
        <div>
          <dt>Location</dt>
          <dd>
            {finding.filePath === null ? (
              "The pull request as a whole"
            ) : (
              <>
                <span>
                  <code>{finding.filePath}</code>
                  {finding.line === null ? "" : `, line ${finding.line}`}
                </span>
                {/* A new key resets the button when another finding is selected. */}
                <CopyPathButton key={finding.filePath} path={finding.filePath} />
              </>
            )}
          </dd>
        </div>
        {finding.evidence.map((evidence, index) => (
          <div key={index}>
            <dt>{evidence.label}</dt>
            <dd>
              <code>{evidence.value}</code>
            </dd>
          </div>
        ))}
        {finding.suggestion === null ? null : (
          <div>
            <dt>Suggested action</dt>
            <dd>{finding.suggestion}</dd>
          </div>
        )}
        {finding.confidence < 1 ? (
          <div>
            <dt>Confidence</dt>
            <dd>{formatPercent(finding.confidence)}: a signal to check, not a certainty.</dd>
          </div>
        ) : null}
      </dl>
      <p className="hint">
        PR Buddy stores no source code, so the line itself is not shown here. Open the pull request
        on GitHub to see it.
      </p>
    </article>
  );
}

function Findings(props: { readonly review: ReviewDetails }): ReactNode {
  const { findings } = props.review;
  const [search] = useSearchParams();
  // The address counts from 1; anything that is not a finding of this review selects the first.
  const requested = Number(search.get("finding")) - 1;
  const selected = Number.isInteger(requested) && findings[requested] !== undefined ? requested : 0;
  const finding = findings[selected];

  return (
    <section aria-labelledby="findings-heading">
      <h2 id="findings-heading">
        Findings from deterministic rules <span className="count">{findings.length}</span>
      </h2>
      {finding === undefined ? (
        <p className="quiet-result">No findings from the enabled checks.</p>
      ) : (
        <div className="review-panels">
          <FindingList findings={findings} selected={selected} />
          <FindingDetail finding={finding} />
        </div>
      )}
    </section>
  );
}

function AiSection(props: { readonly aiReview: AiReview }): ReactNode {
  const { aiReview } = props;
  return (
    <section aria-labelledby="ai-heading" className="ai-section">
      <h2 id="ai-heading">
        AI suggestions <SourceLabel source="ai" />
      </h2>
      {aiReview.status === "failed" ? (
        <p>
          The AI review could not be completed ({aiReview.failureReason ?? "no reason recorded"}).
          The deterministic checks above were not affected.
        </p>
      ) : (
        <p>
          {plural(aiReview.findingCount, "suggestion")} from a language model{" "}
          {aiReview.findingCount === 1 ? "was" : "were"} published on the pull request. Their text
          is not stored here, because a model that has read the code may quote it. Read them in PR
          Buddy&apos;s comment on GitHub, and check each one before acting on it.
        </p>
      )}
      <dl className="facts">
        <div>
          <dt>Model</dt>
          <dd>
            <code>
              {aiReview.provider}/{aiReview.model}
            </code>
          </dd>
        </div>
        <div>
          <dt>Suggestions rejected</dt>
          <dd>{aiReview.rejectedFindingCount} (malformed, or pointing outside the diff)</dd>
        </div>
        <div>
          <dt>Files sent</dt>
          <dd>
            {aiReview.sentFileCount}, {aiReview.omittedFileCount} left out
          </dd>
        </div>
        {aiReview.inputTokens === null || aiReview.outputTokens === null ? null : (
          <div>
            <dt>Tokens</dt>
            <dd>
              {aiReview.inputTokens} in, {aiReview.outputTokens} out
            </dd>
          </div>
        )}
        <div>
          <dt>Time</dt>
          <dd>{formatDuration(aiReview.durationMs)}</dd>
        </div>
      </dl>
    </section>
  );
}

function RuleTable(props: { readonly rules: readonly RuleExecution[] }): ReactNode {
  return (
    <details className="disclosure">
      <summary>Rules that ran ({props.rules.length})</summary>
      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">Rules that ran in this review</caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Version</th>
              <th scope="col">Result</th>
              <th scope="col">Findings</th>
              <th scope="col">Time</th>
            </tr>
          </thead>
          <tbody>
            {props.rules.map((rule) => (
              <tr key={rule.ruleId}>
                <td>
                  <code>{rule.ruleId}</code>
                </td>
                <td>{rule.ruleVersion}</td>
                <td>{rule.status}</td>
                <td>{rule.findingCount}</td>
                <td>{formatDuration(rule.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ReviewContent(props: { readonly review: ReviewDetails }): ReactNode {
  const { review } = props;
  const { repository } = review;
  const pullRequest = pullRequestUrl(repository, review.pullRequestNumber);
  return (
    <div className="review">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/repositories">Repositories</Link>
        <span aria-hidden="true">/</span>
        <Link to={`/repositories/${repository.id}`}>
          {repository.owner}/{repository.name}
        </Link>
      </nav>
      <PageHeader
        title={`Pull request #${review.pullRequestNumber}`}
        description={
          <>
            Reviewed <Timestamp iso={review.startedAt} /> in {formatDuration(review.durationMs)}
            {review.headSha === null ? (
              ". The commit is not known: the review failed before the pull request was read."
            ) : (
              <>
                {" at commit "}
                <ExternalLink href={commitUrl(repository, review.headSha)}>
                  <code>{shortCommit(review.headSha)}</code>
                </ExternalLink>
                .
              </>
            )}
          </>
        }
        {...(pullRequest === undefined
          ? {}
          : {
              action: (
                <ExternalLink className="button button-primary" href={pullRequest}>
                  Open on GitHub <Icon name="external" />
                </ExternalLink>
              ),
            })}
      />

      {review.newerReviewId === null ? null : (
        <Notice tone="warning" title="This review is out of date">
          <p>
            A newer commit of this pull request has been reviewed since.{" "}
            <Link to={`/reviews/${review.newerReviewId}`}>View the latest review</Link>
          </p>
        </Notice>
      )}
      <OutcomeNotice review={review} />
      <SummaryStrip review={review} />

      {review.status === "completed" ? <Findings review={review} /> : null}
      {review.aiReview === null ? null : <AiSection aiReview={review.aiReview} />}
      {review.rules.length === 0 ? null : <RuleTable rules={review.rules} />}
    </div>
  );
}

export function ReviewPage(): ReactNode {
  const reviewId = useParams()["reviewId"] ?? "";
  const { resource, reload } = useResource(
    (signal) => api.review(reviewId, signal),
    `review:${reviewId}`,
  );
  return (
    <Loaded resource={resource} loadingLabel="Loading the review…" onRetry={reload}>
      {(review) => <ReviewContent review={review} />}
    </Loaded>
  );
}
