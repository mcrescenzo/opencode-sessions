# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and uses semantic versioning for published package releases. Git tags use `vX.Y.Z`.

## [0.1.0] - 2026-07-07

### Added

- Initial public release candidate for `@mcrescenzo/opencode-sessions`.
- Read-only `session_list`, `session_info`, `session_read`, and `session_search`
  opencode session-history tools.
- Explicit permission opt-in; installing the plugin does not auto-allow session tools.
- Bounded output, best-effort redaction, regex safety checks, CI, npm package gates,
  and expanded regression coverage.

### Removed

- Raw transcript output from the public API.

### Security

- Scopes tools to the invoking opencode session's current project directory.
