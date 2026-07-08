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

## Verification

Before opening a pull request, run the full local release gate:

```sh
npm ci
npm test
npm run check
npm run pack:dry-run
```

`npm run pack:dry-run` must include only:

- `CHANGELOG.md`
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `README.md`
- `SECURITY.md`
- `opencode-sessions-core.js`
- `opencode-sessions.js`
- `package.json`

## Release Process

npm is the canonical package manager for this repository. `package-lock.json`
is authoritative; Bun lockfiles are not used.

Before publishing:

1. Update `CHANGELOG.md`.
2. Bump `package.json` using SemVer.
3. Run `npm ci`, `npm test`, `npm run check`, and `npm run pack:dry-run`.
4. Commit the release changes.
5. Tag as `vX.Y.Z`, for example `v0.1.0`.
6. Publish to npm with provenance enabled.

## Versioned Contract

The public versioned contract includes tool names, tool arguments, defaults,
caps, permission behavior, privacy/output modes, Node engine, package
entrypoint, and the guarantee that mutating opencode session APIs are not
exposed.

Breaking changes include removing or renaming a tool or argument, narrowing a
documented bound, changing a default, broadening default output exposure,
changing permission defaults, lowering privacy protections, raising the Node
engine floor, or changing the package entrypoint.
