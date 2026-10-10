# ADR 0001 — Visual direction: Graphite / Signal Lime

- **Status:** Accepted, 2026-10-10
- **Decided by:** the maintainer
- **Source:** the UI/UX blueprint supplied by the maintainer, which offered four palettes

## Decision

The dashboard uses **Palette A, Graphite / Signal Lime**, in both a dark and a light theme, with
IBM Plex Sans for the interface and IBM Plex Mono for code.

## Why

PR Buddy should read as a precise, developer-first tool and be recognisable in a screenshot. Of
the four directions, this one is the most distinctive while staying high-contrast and quiet.

## Consequences

- Lime is reserved for primary actions, the active navigation item and selected states. It is not
  a decoration, and no other accent is mixed in.
- Colours are used through semantic tokens only ([DESIGN-SYSTEM.md](../DESIGN-SYSTEM.md)), so a
  later change of palette is a change to one file.
- The fonts are bundled with the application (SIL Open Font License 1.1) because the
  Content-Security-Policy allows fonts from the dashboard's own origin only.
