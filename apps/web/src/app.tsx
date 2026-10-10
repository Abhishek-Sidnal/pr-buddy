import type { ReactNode } from "react";
import { NavLink, Route, Routes, useSearchParams } from "react-router";
import { api, SIGN_IN_PATH } from "./api/client.js";
import type { Me } from "./api/schemas.js";
import { EmptyState, ErrorState, LoadingState, Notice, PageHeader } from "./components/common.js";
import { Icon, type IconName } from "./components/icon.js";
import { plural } from "./format.js";
import { HistoryPage } from "./pages/history.js";
import { OverviewPage } from "./pages/overview.js";
import { RepositoriesPage } from "./pages/repositories.js";
import { RepositoryPage } from "./pages/repository.js";
import { ReviewPage } from "./pages/review.js";
import { SettingsPage } from "./pages/settings.js";
import { useResource } from "./use-resource.js";

function Brand(): ReactNode {
  return (
    <span className="brand">
      <Icon name="brand" />
      PR Buddy
    </span>
  );
}

function SignInPage(): ReactNode {
  const [search] = useSearchParams();
  return (
    <main className="sign-in">
      <Brand />
      <h1>Review history for your pull requests</h1>
      <p>
        PR Buddy checks pull requests with deterministic rules and keeps one comment on each up to
        date. Sign in to see what it found in the repositories you can access.
      </p>
      {search.get("sign-in") === "failed" ? (
        <Notice tone="danger" title="Sign-in did not complete" isAlert>
          <p>
            GitHub did not confirm the sign-in, or it took longer than ten minutes. Nothing was
            saved. Start again with the button below.
          </p>
        </Notice>
      ) : null}
      <a className="button button-primary" href={SIGN_IN_PATH}>
        Sign in with GitHub
      </a>
      <h2>What GitHub will share</h2>
      <ul className="bullets">
        <li>Your GitHub login and ID, to show who is signed in.</li>
        <li>
          Which installations of the PR Buddy app you can access, to decide which repositories you
          may see.
        </li>
      </ul>
      <p className="hint">
        PR Buddy keeps no GitHub token: it is used once during sign-in and dropped. Sessions end
        after eight hours.
      </p>
    </main>
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

function Shell(props: { readonly me: Me; readonly onSignOut: () => void }): ReactNode {
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
            {NAVIGATION.map((item) => (
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
          </p>
        </nav>
        <main id="content" className="content" tabIndex={-1}>
          {me.installationCount === 0 ? (
            <Notice tone="warning" title="GitHub lists no installation of PR Buddy for you">
              <p>
                Install the app on a repository, or ask an owner for access to one where it is
                installed. Then sign out and in again: access is read at sign-in.
              </p>
            </Notice>
          ) : null}
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/repositories" element={<RepositoriesPage />} />
            <Route path="/repositories/:repositoryId" element={<RepositoryPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/reviews/:reviewId" element={<ReviewPage />} />
            <Route
              path="/settings"
              element={<SettingsPage me={me} onSignOut={props.onSignOut} />}
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

  if (resource.status === "loading") {
    return (
      <main className="sign-in">
        <LoadingState label="Checking your session…" />
      </main>
    );
  }
  if (resource.status === "error") {
    return resource.error.kind === "unauthenticated" ? (
      <SignInPage />
    ) : (
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
  return <Shell me={resource.data} onSignOut={signOut} />;
}
