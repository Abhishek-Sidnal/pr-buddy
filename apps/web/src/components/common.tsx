import type { ReactNode } from "react";
import { SIGN_IN_PATH, type ApiError } from "../api/client.js";
import type { ReviewStatus } from "../api/schemas.js";
import { formatDateTime } from "../format.js";
import type { Resource } from "../use-resource.js";
import { Icon, type IconName } from "./icon.js";

/** The title of a page, one sentence about it, and at most one primary action. */
export function PageHeader(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <header className="page-header">
      <div>
        <h1>{props.title}</h1>
        {props.description === undefined ? null : (
          <p className="page-description">{props.description}</p>
        )}
      </div>
      {props.action === undefined ? null : <div className="page-action">{props.action}</div>}
    </header>
  );
}

/**
 * A link that leaves the dashboard. Without a URL it renders its text alone: a value that failed
 * its check is still shown, just not as something to click.
 */
export function ExternalLink(props: {
  readonly href: string | undefined;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactNode {
  if (props.href === undefined) {
    return <span>{props.children}</span>;
  }
  return (
    <a className={props.className} href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}

export function Timestamp(props: { readonly iso: string }): ReactNode {
  return <time dateTime={props.iso}>{formatDateTime(props.iso)}</time>;
}

const STATUSES: Readonly<Record<ReviewStatus, { label: string; icon: IconName }>> = {
  completed: { label: "Completed", icon: "check" },
  skipped: { label: "Skipped", icon: "skip" },
  failed: { label: "Failed", icon: "cross" },
};

/** A review's outcome, as an icon and a word: never as a colour alone. */
export function StatusBadge(props: { readonly status: ReviewStatus }): ReactNode {
  const { label, icon } = STATUSES[props.status];
  return (
    <span className={`status status-${props.status}`}>
      <Icon name={icon} />
      {label}
    </span>
  );
}

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type KnownSeverity = (typeof SEVERITIES)[number];

export function isKnownSeverity(severity: string): severity is KnownSeverity {
  return SEVERITIES.some((known) => known === severity);
}

const SEVERITY_LABELS: Readonly<Record<KnownSeverity, string>> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** A severity as stored. An unknown one is shown as written, with no colour or icon of its own. */
export function SeverityBadge(props: { readonly severity: string }): ReactNode {
  const { severity } = props;
  if (!isKnownSeverity(severity)) {
    return <span className="severity severity-unknown">{severity}</span>;
  }
  return (
    <span className={`severity severity-${severity}`}>
      <Icon name={severity} />
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

/** Says where a finding came from. A model's output is never presented as verified. */
export function SourceLabel(props: { readonly source: "rule" | "ai" }): ReactNode {
  return (
    <span className="source-label">
      {props.source === "rule" ? "Deterministic rule" : "AI suggestion, not verified"}
    </span>
  );
}

/** A banner for something the reader should know before reading on. */
export function Notice(props: {
  readonly tone: "info" | "warning" | "danger";
  readonly title: string;
  readonly isAlert?: boolean;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <div className={`notice notice-${props.tone}`} role={props.isAlert === true ? "alert" : "note"}>
      <p className="notice-title">{props.title}</p>
      {props.children === undefined ? null : <div className="notice-body">{props.children}</div>}
    </div>
  );
}

/** Says what is missing and what to do next. */
export function EmptyState(props: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="empty">
      <p className="empty-title">{props.title}</p>
      <div className="empty-body">{props.children}</div>
    </div>
  );
}

const ERROR_TITLES: Readonly<Record<ApiError["kind"], string>> = {
  unauthenticated: "Your session has ended.",
  "not-found": "This page does not exist, or you do not have access to it.",
  failed: "The data could not be loaded.",
};

export function ErrorState(props: {
  readonly error: ApiError;
  /** Present when asking again could help. */
  readonly onRetry?: () => void;
}): ReactNode {
  const { kind } = props.error;
  return (
    <Notice tone={kind === "not-found" ? "info" : "danger"} title={ERROR_TITLES[kind]} isAlert>
      {kind === "unauthenticated" ? (
        <a className="button button-secondary" href={SIGN_IN_PATH}>
          Sign in again
        </a>
      ) : null}
      {kind === "failed" ? (
        <>
          <p>The service may be busy or briefly unreachable. Nothing was lost.</p>
          {props.onRetry === undefined ? null : (
            <button type="button" className="button button-secondary" onClick={props.onRetry}>
              Try again
            </button>
          )}
        </>
      ) : null}
      {kind === "not-found" ? <p>Check the address, or pick a repository from the list.</p> : null}
    </Notice>
  );
}

const SKELETON_ROWS = 4;

/** Holds the place of content that is on its way, and says what is loading. */
export function LoadingState(props: { readonly label: string }): ReactNode {
  return (
    <div className="loading" role="status">
      <span className="loading-label">{props.label}</span>
      <div className="skeleton" aria-hidden="true">
        {Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
          <span key={index} className="skeleton-row" />
        ))}
      </div>
    </div>
  );
}

/** Shows a resource once it has loaded, and its loading or error state until then. */
export function Loaded<Data>(props: {
  readonly resource: Resource<Data>;
  readonly loadingLabel: string;
  readonly onRetry?: () => void;
  readonly children: (data: Data) => ReactNode;
}): ReactNode {
  const { resource } = props;
  if (resource.status === "loading") {
    return <LoadingState label={props.loadingLabel} />;
  }
  if (resource.status === "error") {
    return (
      <ErrorState
        error={resource.error}
        {...(props.onRetry === undefined ? {} : { onRetry: props.onRetry })}
      />
    );
  }
  return props.children(resource.data);
}
