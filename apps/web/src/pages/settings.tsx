import { useState, type ReactNode } from "react";
import type { Me } from "../api/schemas.js";
import { PageHeader, Timestamp } from "../components/common.js";
import { DataHandling } from "../components/data-handling.js";
import { AiKeySettings } from "./ai-keys.js";
import { plural } from "../format.js";
import {
  readThemePreference,
  saveThemePreference,
  THEME_PREFERENCES,
  type ThemePreference,
} from "../theme.js";

const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function ThemeSetting(): ReactNode {
  const [preference, setPreference] = useState(readThemePreference);
  return (
    <fieldset className="choice">
      <legend>Theme</legend>
      <p className="hint">Applies at once and is remembered in this browser only.</p>
      <div className="choice-options">
        {THEME_PREFERENCES.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name="theme"
              value={option}
              checked={preference === option}
              onChange={() => {
                saveThemePreference(option);
                setPreference(option);
              }}
            />
            {THEME_LABELS[option]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Settings that exist: the theme and the session. How a repository is reviewed is not set here;
 * it lives in the repository itself.
 */
export function SettingsPage(props: {
  readonly me: Me;
  readonly onSignOut: () => void;
}): ReactNode {
  const { me } = props;
  return (
    <>
      <PageHeader title="Settings" description="Your appearance preference and your session." />

      <section aria-labelledby="appearance-heading" className="settings-section">
        <h2 id="appearance-heading">Appearance</h2>
        <ThemeSetting />
      </section>

      <section aria-labelledby="account-heading" className="settings-section">
        <h2 id="account-heading">GitHub account</h2>
        <dl className="facts">
          <div>
            <dt>Signed in as</dt>
            <dd>{me.login}</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>
              {plural(me.installationCount, "installation")} of the app, as GitHub listed them when
              you signed in
            </dd>
          </div>
          <div>
            <dt>Session ends</dt>
            <dd>
              <Timestamp iso={me.expiresAt} />
            </dd>
          </div>
        </dl>
        <p className="hint">
          Access is read from GitHub at sign-in. If your access changed, sign out and in again.
        </p>
        <button type="button" className="button button-secondary" onClick={props.onSignOut}>
          Sign out
        </button>
      </section>

      <AiKeySettings />

      <section aria-labelledby="configuration-heading" className="settings-section">
        <h2 id="configuration-heading">Review configuration</h2>
        <p>
          Rules, thresholds and whether a repository uses AI review are configured per repository in{" "}
          <code>.github/pr-buddy.json</code>, read from the pull request&apos;s base branch. This
          dashboard cannot change them.
        </p>
      </section>

      <section aria-labelledby="data-heading" className="settings-section">
        <h2 id="data-heading">Data handling</h2>
        <DataHandling />
      </section>
    </>
  );
}
