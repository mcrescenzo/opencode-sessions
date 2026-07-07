# Contributing

Thanks for improving `opencode-sessions`.

## Development Setup

```sh
bun install
node --test tests/*.test.mjs
```

`npm install` also works; `package-lock.json` is the tracked, canonical
lockfile for this package (see `README.md` for the full release gate,
including `npm run check` and `npm run pack:dry-run`).

## Pull Requests

- Avoid adding new runtime dependencies without maintainer review.
- Keep changes scoped and covered by tests in `tests/*.test.mjs`.
- Preserve the read-only guarantee: do not add wrappers around mutating
  opencode session APIs (see `AGENTS.md`).
- Preserve bounded, redacted output for transcript-reading tools; do not
  loosen defaults without updating the tests and `README.md` together.
- Update `CHANGELOG.md` for any user-visible change.
- Ensure `node --test tests/*.test.mjs`, `npm run check`, and
  `npm run pack:dry-run` all pass before opening a pull request.
