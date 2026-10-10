import type { ReactNode } from "react";

/** Every icon is drawn on a 16-unit grid with one stroke width, so the set looks like one family. */
const PATHS = {
  brand: "M5 2.5H2.5v11H5 M11 2.5h2.5v11H11 M5.5 8.25l1.75 1.75L10.5 6.5",
  overview: "M2.5 2.5H7V7H2.5z M9 2.5h4.5V7H9z M2.5 9H7v4.5H2.5z M9 9h4.5v4.5H9z",
  repository: "M4 2.5h8.5v11H4a1.5 1.5 0 0 1 0-3h8.5 M4 2.5A1.5 1.5 0 0 0 2.5 4v8",
  history: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11z M8 5v3l2 1.5",
  settings: "M2.5 5h7 M12 5h1.5 M2.5 11H4 M6.5 11h7 M10.75 3.5v3 M5.25 9.5v3",
  critical: "M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5z M8 5v3.5 M8 10.75v.01",
  high: "M8 2.5l6 10.5H2z M8 6.5v3 M8 11.25v.01",
  medium: "M8 2l6 6l-6 6l-6-6z",
  low: "M8 3a5 5 0 1 0 0 10a5 5 0 0 0 0-10z",
  check: "M3 8.5l3.25 3.25L13 5",
  cross: "M4 4l8 8 M12 4l-8 8",
  skip: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11z M5.5 8h5",
  external: "M9.5 2.5h4v4 M13.5 2.5l-6 6 M11.5 9.5v4h-9v-9h4",
  copy: "M5.5 5.5h8v8h-8z M10.5 5.5v-3h-8v8h3",
} as const;

export type IconName = keyof typeof PATHS;

/**
 * A decorative icon. It is hidden from assistive technology: every icon in the dashboard sits
 * beside a text label that says the same thing.
 */
export function Icon(props: { readonly name: IconName }): ReactNode {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
