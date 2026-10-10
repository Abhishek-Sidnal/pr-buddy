import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api/client.js";
import type { AiReview, Finding, ReviewDetails, RuleExecution } from "../api/schemas.js";
import {
  ExternalLink,
  Loaded,
  SeverityBadge,
  StatusBadge,
  Timestamp,
} from "../components/common.js";
import { formatDuration, formatPercent, plural, shortCommit } from "../format.js";
import { commitUrl, pullRequestUrl } from "../github-links.js";
import { useResource } from "../use-resource.js";

function Field(props: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <div className="field">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

const COMMENT_ACTIONS: Readonly<Record<string, string>> = {
  created: "A summary comment was posted",
  updated: "The summary comment was updated",
  none: "No comment was needed",
};

function describeOutcome(review: ReviewDetails): string {
  if (review.status === "skipped") {
    return `Skipped: ${review.skipReason ?? "no reason recorded"}`;
  }
  if (review.status === "failed") {
    const status = review.errorStatus === null ? "" : `, HTTP ${review.errorStatus}`;
    return `Failed: ${review.errorName ?? "unknown error"}${status}`;
  }
  return COMMENT_ACTIONS[review.commentAction ?? ""] ?? "Completed";
}

function Summary(props: { readonly review: ReviewDetails }): ReactNode {
  const { review } = props;
  return (
    <dl className="fields">
      <Field label="Outcome">
        <StatusBadge status={review.status} /> {describeOutcome(review)}
      </Field>
      <Field label="Pull request">
        <ExternalLink href={pullRequestUrl(review.repository, review.pullRequestNumber)}>
          #{review.pullRequestNumber}
        </ExternalLink>
      </Field>
      <Field label="Commit">
        {review.headSha === null ? (
          "Not known: the review failed before the pull request was read"
        ) : (
          <ExternalLink href={commitUrl(review.repository, review.headSha)}>
            <code>{shortCommit(review.headSha)}</code>
          </ExternalLink>
        )}
      </Field>
      <Field label="Reviewed">
        <Timestamp iso={review.startedAt} />, took {formatDuration(review.durationMs)}
      </Field>
      {review.suppressedFindingCount > 0 ? (
        <Field label="Hidden by thresholds">
          {plural(review.suppressedFindingCount, "finding")}
        </Field>
      ) : null}
      {review.skippedFileCount > 0 ? (
        <Field label="Files not reviewed">{review.skippedFileCount}</Field>
      ) : null}
      {review.omittedPatchCount > 0 ? (
        <Field label="Diffs too large to load">{review.omittedPatchCount}</Field>
      ) : null}
    </dl>
  );
}

function FindingCard(props: { readonly finding: Finding }): ReactNode {
  const { finding } = props;
  return (
    <li className="finding">
      <p className="finding-heading">
        <SeverityBadge severity={finding.severity} /> <code>{finding.ruleId}</code>
      </p>
      <p>{finding.message}</p>
      <ul className="plain">
        {finding.filePath === null ? null : (
          <li>
            Location: <code>{finding.filePath}</code>
            {finding.line === null ? "" : `, line ${finding.line}`}
          </li>
        )}
        {finding.evidence.map((evidence, index) => (
          <li key={index}>
            {evidence.label}: <code>{evidence.value}</code>
          </li>
        ))}
      </ul>
      {finding.suggestion === null ? null : (
        <p>
          <strong>Suggested action:</strong> {finding.suggestion}
        </p>
      )}
      {finding.confidence < 1 ? (
        <p className="muted">
          Confidence {formatPercent(finding.confidence)}: a signal to check, not a certainty.
        </p>
      ) : null}
    </li>
  );
}

function RuleTable(props: { readonly rules: readonly RuleExecution[] }): ReactNode {
  return (
    <table>
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
  );
}

function AiSection(props: { readonly aiReview: AiReview }): ReactNode {
  const { aiReview } = props;
  return (
    <>
      <h2>AI review</h2>
      <dl className="fields">
        <Field label="Model">
          <code>
            {aiReview.provider}/{aiReview.model}
          </code>
        </Field>
        <Field label="Result">
          {aiReview.status}
          {aiReview.failureReason === null ? "" : ` (${aiReview.failureReason})`}
        </Field>
        <Field label="Suggestions published">{aiReview.findingCount}</Field>
        <Field label="Suggestions rejected">{aiReview.rejectedFindingCount}</Field>
        <Field label="Files sent">
          {aiReview.sentFileCount}, {aiReview.omittedFileCount} left out
        </Field>
        {aiReview.inputTokens === null || aiReview.outputTokens === null ? null : (
          <Field label="Tokens">
            {aiReview.inputTokens} in, {aiReview.outputTokens} out
          </Field>
        )}
        <Field label="Time">{formatDuration(aiReview.durationMs)}</Field>
      </dl>
      <p className="muted">
        The text of AI suggestions is not stored. Read them in the summary comment on the pull
        request.
      </p>
    </>
  );
}

export function ReviewPage(): ReactNode {
  const reviewId = useParams()["reviewId"] ?? "";
  const { resource } = useResource((signal) => api.review(reviewId, signal), `review:${reviewId}`);
  return (
    <Loaded resource={resource}>
      {(review) => (
        <>
          <p>
            <Link to={`/repositories/${review.repository.id}`}>
              {review.repository.owner}/{review.repository.name}
            </Link>
          </p>
          <h1>Review of pull request #{review.pullRequestNumber}</h1>
          <Summary review={review} />

          <h2>{plural(review.findings.length, "finding")}</h2>
          {review.findings.length === 0 ? (
            <p className="muted">Nothing was reported.</p>
          ) : (
            <ul className="findings">
              {review.findings.map((finding, index) => (
                <FindingCard key={index} finding={finding} />
              ))}
            </ul>
          )}

          {review.aiReview === null ? null : <AiSection aiReview={review.aiReview} />}

          {review.rules.length === 0 ? null : (
            <>
              <h2>Rules</h2>
              <RuleTable rules={review.rules} />
            </>
          )}
        </>
      )}
    </Loaded>
  );
}
