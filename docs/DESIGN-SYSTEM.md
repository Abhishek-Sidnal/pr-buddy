# PR Buddy — Design system

The rules every screen of the dashboard follows. The visual direction was chosen in
[ADR 0001](ADR/0001-visual-direction.md). How the dashboard works is in
[DESIGN-DASHBOARD.md](DESIGN-DASHBOARD.md).

## 1. Principles

1. Findings are the product. No decorative charts, no marketing cards.
2. Hierarchy comes from type, spacing and alignment before colour.
3. Show evidence: rule, severity, file, line, explanation, suggested action.
4. Keep the overview calm; detail appears when a review or finding is opened.
5. Honest AI: suggestions from a model are labelled, kept apart, and never called verified.
6. Every empty state says what is missing and what to do next.
7. Nothing on screen is fake: no sample data, no control that does nothing.

## 2. Tokens

All colours, sizes and radii are CSS custom properties in `apps/web/src/styles/tokens.css`.
Components use the semantic names below and never a raw hex value.

| Token                    | Role                                   | Dark                            | Light     |
| ------------------------ | -------------------------------------- | ------------------------------- | --------- |
| `--color-bg`             | Application background                 | `#101318`                       | `#F5F7F4` |
| `--color-surface`        | Main surface: panels, tables           | `#171C23`                       | `#FFFFFF` |
| `--color-surface-raised` | Hover, selected and inset surfaces     | `#1D242D`                       | `#EDF1EB` |
| `--color-text`           | Primary text                           | `#F2F5F7`                       | `#172019` |
| `--color-text-secondary` | Supporting text and labels             | `#A5AFB8`                       | `#5C675F` |
| `--color-border`         | Borders and dividers                   | `#303944`                       | `#D9E1D8` |
| `--color-accent`         | Primary action, active item, selection | `#B8F36B`                       | `#477B1B` |
| `--color-on-accent`      | Text on the accent                     | `#18210F`                       | `#FFFFFF` |
| `--color-focus`          | Focus ring                             | `#D4FF9A`                       | `#477B1B` |
| `--color-success`        | Completed, passed                      | `#68D6A0`                       | `#16784B` |
| `--color-warning`        | Medium severity, skipped, caution      | `#F2C66D`                       | `#956000` |
| `--color-danger`         | Critical severity, failed              | `#FF827C`                       | `#BD3535` |
| `--color-info`           | Low severity, links, information       | `#83B8FF`                       | `#245FC4` |
| `--color-severity-high`  | High severity                          | derived from danger and warning |

Spacing uses a 4 px base: `--space-1` (4 px) to `--space-16` (64 px). Radii: 6 px small, 8 px
standard, 12 px for large panels. Borders and surface contrast separate areas; there are no
shadows, glows or gradients.

### Themes

Light, dark and system. The choice is kept in the browser's local storage and applied as
`data-theme` on the root element; "system" follows `prefers-color-scheme`. Switching needs no
reload.

## 3. Typography

| Use              | Font          | Size  | Weight | Line height |
| ---------------- | ------------- | ----- | ------ | ----------- |
| Page title       | IBM Plex Sans | 28 px | 600    | 1.2         |
| Section heading  | IBM Plex Sans | 18 px | 600    | 1.35        |
| List title       | IBM Plex Sans | 15 px | 600    | 1.4         |
| Body             | IBM Plex Sans | 14 px | 400    | 1.55        |
| Supporting text  | IBM Plex Sans | 13 px | 400    | 1.45        |
| Code, IDs, paths | IBM Plex Mono | 13 px | 400    | 1.55        |

Nothing meaningful is smaller than 12 px. Both fonts are bundled (latin subset) and fall back to
the system's fonts.

## 4. Layout

- Sidebar 240 px with the navigation; a top bar with the product name and the account.
- Below 800 px the sidebar becomes a row of links under the top bar.
- Content is at most 1280 px wide, 1440 px on the review screen; 32 px side padding on desktop,
  16 px on small screens.
- Table rows are 48 px; controls are at least 40 px tall.

## 5. Components

All in `apps/web/src/components/`. Reuse them; do not restyle one-off copies.

| Component       | Use                                                                  |
| --------------- | -------------------------------------------------------------------- |
| `PageHeader`    | Title, one-sentence description, at most one primary action          |
| `Button`        | `primary` (one per page at most), `secondary`, `quiet`               |
| `StatusBadge`   | Review outcome: icon and text, never colour alone                    |
| `SeverityBadge` | Finding severity: icon and text, never colour alone                  |
| `SourceLabel`   | "Deterministic rule" or "AI suggestion, not verified"                |
| `ReviewTable`   | Every list of reviews                                                |
| `ReviewList`    | A `ReviewTable` with "Show older reviews" paging                     |
| `EmptyState`    | What is missing and the next useful action                           |
| `ErrorState`    | Failure, sign-in ended, not found; with a retry where retrying helps |
| `LoadingState`  | Skeleton rows with a specific label; keeps the layout from jumping   |
| `Notice`        | A banner for something that needs attention, such as a stale review  |
| `ExternalLink`  | A link to GitHub; plain text when the stored value fails its check   |
| `Icon`          | One stroke style, 16 px, always decorative beside a text label       |

### Status and severity

| Meaning   | Colour token             | Icon     |
| --------- | ------------------------ | -------- |
| Critical  | `--color-danger`         | Octagon  |
| High      | `--color-severity-high`  | Triangle |
| Medium    | `--color-warning`        | Diamond  |
| Low       | `--color-info`           | Circle   |
| Completed | `--color-success`        | Check    |
| Skipped   | `--color-text-secondary` | Skip     |
| Failed    | `--color-danger`         | Cross    |

### Onboarding

| Element        | Rule                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------- |
| Visitor's page | One column, 44rem wide. One main action. Install is the main action only when it exists       |
| Step list      | A card per step: its state in words (Done, Next, Later, Optional), a title, what to do        |
| The next step  | The only card with an accent border, and the only one that may carry a main action            |
| A step's state | Always text, with a check icon beside "Done"; never colour alone                              |
| Data handling  | The shared `DataHandling` list; the visitor's page and the settings never have their own copy |

### Interaction

- Hover: a surface or border change over 140 ms.
- Focus: a 2 px ring in `--color-focus`, offset 2 px, on every interactive element.
- `prefers-reduced-motion` turns transitions and the skeleton animation off.
- Buttons name what they do: "Open on GitHub", "Show older reviews", "Sign out".

## 6. What the dashboard does not have, and why

The blueprint describes more than the service can back today. These are left out rather than
shown as controls that do nothing.

| Blueprint item                                | Why it is absent                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Pull request queue                            | PR Buddy stores reviews, not GitHub's list of open pull requests           |
| Pull request title, author, branches          | Never stored (D-031)                                                       |
| Diff or code snippet beside a finding         | No source code is stored (D-031, D-035)                                    |
| Text of AI suggestions                        | Not stored (D-046); the record and a pointer to the pull request are shown |
| "Re-run review"                               | The dashboard is read-only (D-056); a push or a webhook redelivery re-runs |
| Rules page with switches, repository settings | Configuration lives in `.github/pr-buddy.json` (D-056)                     |
| Onboarding with repository selection          | Installing the app and choosing repositories happens on GitHub             |
| Search and filters by author or title         | Not stored; history filters by outcome only                                |
| Component showcase route                      | Would ship sample data in the production bundle                            |

## 7. Definition of done for a screen

- Uses tokens and shared components; no raw colours.
- Works in the dark and the light theme.
- Has loading, empty, error and not-found states where they apply.
- Has no dead control and no sample data.
- Works with the keyboard, with a visible focus ring and accessible names.
- Respects reduced motion; holds up at 375 px and with long paths.
- Tests, lint, type-check and build pass.
- Was looked at in a browser, or the report says that it was not.
