import type { ReactNode } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router";
import { api } from "./api/client.js";
import type { Me, ServiceInfo } from "./api/schemas.js";
import { EmptyState, ErrorState, LoadingState, Notice, PageHeader } from "./components/common.js";
import { Icon, type IconName } from "./components/icon.js";
import { plural } from "./format.js";
import { appInstallUrl } from "./github-links.js";
import { HistoryPage } from "./pages/history.js";
import { LandingPage } from "./pages/landing.js";
import { OperatorPage } from "./pages/operator.js";
import { OverviewPage } from "./pages/overview.js";
import { PrivacyContent } from "./pages/privacy.js";
import { RepositoriesPage } from "./pages/repositories.js";
import { RepositoryPage } from "./pages/repository.js";
import { ReviewPage } from "./pages/review.js";
import { SettingsPage } from "./pages/settings.js";
import { useResource, type Resource } from "./use-resource.js";

const PRIVACY_PATH = "/privacy";
const PRIVACY_TITLE = "Privacy and data";

function Brand(): ReactNode {
  return (
    <span className="brand">
      <Icon name="brand" />
      PR Buddy
    </span>
  );
}

function NotFoundPage(): ReactNode {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState title="There is nothing at this address">
        <p>
          <NavLink to="/">Go to the overview</NavLink>
        </p>
      </EmptyState>
    </>
  );
}

/** Only routes the service can back are listed: there is no menu item that leads nowhere. */
const NAVIGATION: readonly { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "Overview", icon: "overview", end: true },
  { to: "/repositories", label: "Repositories", icon: "repository" },
  { to: "/history", label: "Review history", icon: "history" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

/**
 * Shown only to the people who run the deployment. Showing it grants nothing: the API decides
 * who may read what is behind it, and answers everyone else as for a page that does not exist.
 */
const OPERATOR_NAVIGATION: (typeof NAVIGATION)[number] = {
  to: "/operator",
  label: "Service",
  icon: "service",
};

function Shell(props: {
  readonly me: Me;
  readonly installUrl: string | undefined;
  readonly service: Resource<ServiceInfo>;
  readonly onSignOut: () => void;
}): ReactNode {
  const { me } = props;
  return (
    <div className="app">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="topbar">
        <Brand />
        <div className="account">
          <span className="account-login">{me.login}</span>
          <button type="button" className="button button-quiet" onClick={props.onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <div className="app-body">
        <nav aria-label="Main" className="sidebar">
          <ul>
            {[...NAVIGATION, ...(me.isOperator ? [OPERATOR_NAVIGATION] : [])].map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end === true}>
                  <Icon name={item.icon} />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <p className="sidebar-status">
            GitHub: {plural(me.installationCount, "installation")} visible
            <br />
            <NavLink to="/privacy">Privacy and data</NavLink>
          </p>
        </nav>
        <main id="content" className="content" tabIndex={-1}>
          {me.installationCount === 0 ? (
            <Notice tone="warning" title="GitHub lists no installation of PR Buddy for you">
              <p>
                Install the app on a repository, or ask an owner for access to one where it is
                installed. Then sign out and in again: access is read at sign-in.
              </p>
              {props.installUrl === undefined ? null : (
                <a className="button button-secondary" href={props.installUrl}>
                  Install on GitHub
                </a>
              )}
            </Notice>
          ) : null}
          <Routes>
            <Route
              path="/"
              element={
                <OverviewPage
                  installationCount={me.installationCount}
                  installUrl={props.installUrl}
                />
              }
            />
            <Route path="/repositories" element={<RepositoriesPage />} />
            <Route path="/repositories/:repositoryId" element={<RepositoryPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/reviews/:reviewId" element={<ReviewPage />} />
            <Route
              path="/settings"
              element={<SettingsPage me={me} onSignOut={props.onSignOut} />}
            />
            {me.isOperator ? (
              <Route path={OPERATOR_NAVIGATION.to} element={<OperatorPage />} />
            ) : null}
            <Route
              path={PRIVACY_PATH}
              element={
                <>
                  <PageHeader title={PRIVACY_TITLE} />
                  <PrivacyContent service={props.service} />
                </>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/** Decides between the sign-in page and the dashboard by asking the API who is signed in. */
export function App(): ReactNode {
  const { resource, reload } = useResource((signal) => api.me(signal), "me");
  // Asked once, without a session. If the answer is missing or unusable there is simply no
  // Install button: nothing else waits for it.
  const service = useResource((signal) => api.service(signal), "service").resource;
  const { pathname } = useLocation();
  const installUrl = service.status === "ready" ? appInstallUrl(service.data.appSlug) : undefined;

  if (resource.status === "loading") {
    return (
      <main className="sign-in">
        <LoadingState label="Checking your session…" />
      </main>
    );
  }
  if (resource.status === "error" && resource.error.kind === "unauthenticated") {
    // The one page besides the first that a visitor may read without signing in.
    return pathname === PRIVACY_PATH ? (
      <main className="landing">
        <Brand />
        <h1>{PRIVACY_TITLE}</h1>
        <PrivacyContent service={service} />
        <p>
          <Link to="/">Back to the first page</Link>
        </p>
      </main>
    ) : (
      <LandingPage installUrl={installUrl} />
    );
  }
  if (resource.status === "error") {
    return (
      <main className="sign-in">
        <Brand />
        <ErrorState error={resource.error} onRetry={reload} />
      </main>
    );
  }

  const signOut = (): void => {
    // Whatever the answer, ask again who is signed in: that decides what is shown next.
    void api.signOut().then(reload, reload);
  };
  return <Shell me={resource.data} installUrl={installUrl} service={service} onSignOut={signOut} />;
}
