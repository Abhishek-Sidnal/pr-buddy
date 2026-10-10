export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

const STORAGE_KEY = "prbuddy.theme";

function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value);
}

/** The saved choice, or "system" when there is none or storage is unavailable. */
export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * Applies a theme to the page. "system" removes the attribute, and the style sheet then follows
 * the operating system's setting.
 */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
}

/** Applies a theme and remembers it in this browser. It is never sent to the server. */
export function saveThemePreference(preference: ThemePreference): void {
  applyTheme(preference);
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Private browsing can refuse storage; the theme still applies for this visit.
  }
}
