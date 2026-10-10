import type { ReactNode } from "react";
import { SIGN_IN_PATH, type ApiError } from "../api/client.js";
import type { ReviewStatus } from "../api/schemas.js";
import { formatDateTime } from "../format.js";
import type { Resource } from "../use-resource.js";

/**
 * A link that leaves the dashboard. Without a URL it renders its text alone: a value that failed
 * its check is still shown, just not as something to click.
 */
export function ExternalLink(props: {
  readonly href: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  if (props.href === undefined) {
    return <span>{props.children}</span>;
  }
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}

export function Timestamp(props: { readonly iso: string }): ReactNode {
  return <time dateTime={props.iso}>{formatDateTime(props.iso)}</time>;
}

const STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = {
  completed: "Completed",
  skipped: "Skipped",
  failed: "Failed",
};

export function StatusBadge(props: { readonly status: ReviewStatus }): ReactNode {
  return <span className={`badge badge-${props.status}`}>{STATUS_LABELS[props.status]}</span>;
}

const KNOWN_SEVERITIES = new Set(["low", "medium", "high", "critical"]);

/** A severity as stored. An unknown one is shown as written, with no colour of its own. */
export function SeverityBadge(props: { readonly severity: string }): ReactNode {
  const tone = KNOWN_SEVERITIES.has(props.severity) ? props.severity : "unknown";
  return <span className={`badge severity-${tone}`}>{props.severity}</span>;
}

const ERROR_MESSAGES: Readonly<Record<ApiError["kind"], string>> = {
  unauthenticated: "Your session has ended.",
  "not-found": "This page does not exist, or you do not have access to it.",
  failed: "The data could not be loaded. Try again in a moment.",
};

export function ErrorMessage(props: { readonly error: ApiError }): ReactNode {
  return (
    <div className="notice" role="alert">
      <p>{ERROR_MESSAGES[props.error.kind]}</p>
      {props.error.kind === "unauthenticated" ? <a href={SIGN_IN_PATH}>Sign in again</a> : null}
    </div>
  );
}

/** Shows a resource once it has loaded, and its loading or error state until then. */
export function Loaded<Data>(props: {
  readonly resource: Resource<Data>;
  readonly children: (data: Data) => ReactNode;
}): ReactNode {
  const { resource } = props;
  if (resource.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  }
  if (resource.status === "error") {
    return <ErrorMessage error={resource.error} />;
  }
  return props.children(resource.data);
}
