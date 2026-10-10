# PR Buddy

Read [docs/CONTEXT.md](docs/CONTEXT.md) before making changes: it has the layout, the commands
and the rules that must not be broken. Coding rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

- Node.js is not installed on the host. Run npm through Docker:
  `docker compose run --rm dev npm run check`.
- A change is done when `npm run check` passes and the affected documents are updated:
  [docs/TRACKER.md](docs/TRACKER.md) for status, [docs/BRAIN.md](docs/BRAIN.md) for decisions.
- Do not build ahead of the current milestone.
