import type { ReactNode } from "react";
import { NavLink, Route, Routes, useSearchParams } from "react-router";
import { api, SIGN_IN_PATH } from "./api/client.js";
import type { Me } from "./api/schemas.js";
import { ErrorMessage } from "./components/common.js";
import { OverviewPage } from "./pages/overview.js";
import { RepositoriesPage } from "./pages/repositories.js";
import { RepositoryPage } from "./pages/repository.js";
import { ReviewPage } from "./pages/review.js";
import { useResource } from "./use-resource.js";

function SignInPage(): ReactNode {
  const [search] = useSearchParams();
  return (
    <main className="sign-in">
      <h1>PR Buddy</h1>
      <p>Sign in to see the review history of the repositories you can access on GitHub.</p>
      {search.get("sign-in") === "failed" ? (
        <p className="notice" role="alert">
          Sign-in did not complete. Please try again.
        </p>
      ) : null}
      <a className="button" href={SIGN_IN_PATH}>
        Sign in with GitHub
      </a>
      <p className="muted">
        PR Buddy reads your GitHub login and which installations of the app you can access. It keeps
        no GitHub token.
      </p>
    </main>
  );
}

function NotFoundPage(): ReactNode {
  return (
    <>
      <h1>Page not found</h1>
      <p className="muted">There is nothing at this address.</p>
    </>
  );
}

function Shell(props: { readonly me: Me; readonly onSignOut: () => void }): ReactNode {
  return (
    <>
      <header className="top">
        <strong>PR Buddy</strong>
        <nav aria-label="Main">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/repositories">Repositories</NavLink>
        </nav>
        <span className="who">
          {props.me.login}
          <button type="button" onClick={props.onSignOut}>
            Sign out
          </button>
        </span>
      </header>
      <main>
        {props.me.installationCount === 0 ? (
          <p className="notice">
            GitHub lists no installation of PR Buddy that you can access. Install the app on a
            repository, or ask an owner for access, then sign in again.
          </p>
        ) : null}
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/repositories" element={<RepositoriesPage />} />
          <Route path="/repositories/:repositoryId" element={<RepositoryPage />} />
          <Route path="/reviews/:reviewId" element={<ReviewPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </>
  );
}

/** Decides between the sign-in page and the dashboard by asking the API who is signed in. */
export function App(): ReactNode {
  const { resource, reload } = useResource((signal) => api.me(signal), "me");

  if (resource.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  }
  if (resource.status === "error") {
    return resource.error.kind === "unauthenticated" ? (
      <SignInPage />
    ) : (
      <main>
        <ErrorMessage error={resource.error} />
      </main>
    );
  }

  const signOut = (): void => {
    // Whatever the answer, ask again who is signed in: that decides what is shown next.
    void api.signOut().then(reload, reload);
  };
  return <Shell me={resource.data} onSignOut={signOut} />;
}
