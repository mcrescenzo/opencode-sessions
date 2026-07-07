# opencode-sessions

Read-only opencode plugin tools for listing, inspecting, reading, and searching local session history through opencode's SDK session API.

## Installation

Requirements:

- Node.js `>=20.11.0`
- opencode with plugin support

Install the package:

```sh
bun add @mcrescenzo/opencode-sessions
```

```sh
npm install @mcrescenzo/opencode-sessions
```

Register it in `opencode.json`:

```json
{
  "plugin": ["@mcrescenzo/opencode-sessions"]
}
```

For local development from a source checkout, register the checkout entrypoint path instead of the package name:

```json
{
  "plugin": ["./opencode-sessions.js"]
}
```

This plugin does not auto-allow its tools. Grant only the tools you want agents to use:

```json
{
  "permission": {
    "session_list": "allow",
    "session_info": "allow",
    "session_read": "allow",
    "session_search": "allow"
  }
}
```

After installing, registering, or changing this plugin, restart opencode. Running sessions keep already-loaded plugin code.

## Hooks

This plugin registers exactly two hooks:

| Hook | Behavior |
| --- | --- |
| `config` | No-op. Present so the plugin factory conforms to the plugin `Hooks` contract; makes no config changes. |
| `tool` | Registers the four read-only session tools listed below (`session_list`, `session_info`, `session_read`, `session_search`). |

## Tools

All tools are read-only, output-bounded, and scoped to the invoking opencode session's current project directory. Caller-supplied `directory` values are accepted for compatibility but ignored.

### `session_list`

Lists local sessions for the current project directory.

| Argument | Type | Default | Bounds | Notes |
| --- | --- | --- | --- | --- |
| `directory` | string | current project | ignored | Compatibility-only; `context.directory` is always used. |
| `limit` | integer | `50` | `1..200` | Maximum sessions shown. |
| `includeCurrent` | boolean | `true` | - | Include the current opencode session. |
| `sort` | enum | `updated-desc` | `updated-desc`, `created-desc` | Session ordering. |

### `session_info`

Shows one session's metadata, status, children, todos, and optional diff summary.

| Argument | Type | Default | Bounds | Notes |
| --- | --- | --- | --- | --- |
| `sessionId` | string | required | non-empty | Session to inspect. |
| `directory` | string | current project | ignored | Compatibility-only; `context.directory` is always used. |
| `includeChildren` | boolean | `true` | - | Include child-session count. |
| `includeTodos` | boolean | `true` | - | Include todo summary. |
| `includeStatus` | boolean | `true` | - | Include current status. |
| `includeDiff` | boolean | `false` | - | Include diff summary. |

### `session_read`

Reads a bounded, redacted formatted transcript for one session.

| Argument | Type | Default | Bounds | Notes |
| --- | --- | --- | --- | --- |
| `sessionId` | string | required | non-empty | Session to read. |
| `directory` | string | current project | ignored | Compatibility-only; `context.directory` is always used. |
| `limit` | integer | `100` | `1..500` | Maximum messages read. |
| `includeToolCalls` | boolean | `false` | - | Include bounded tool input/output details. |
| `includeMetadata` | boolean | `false` | - | Include bounded message metadata. |
| `maxPartChars` | integer | `4000` | `500..12000` | Per-part cap before formatting. |
| `maxOutputChars` | integer | `30000` | `2000..80000` | Total output cap. |

There is no raw transcript mode in the public API. Use `includeToolCalls` and `includeMetadata` explicitly when you need more detail.

### `session_search`

Searches recent local session transcripts and returns bounded, redacted snippets.

| Argument | Type | Default | Bounds | Notes |
| --- | --- | --- | --- | --- |
| `query` | string | required | text: `1..1000`, regex: `1..300` | Text or regex pattern. |
| `directory` | string | current project | ignored | Compatibility-only; `context.directory` is always used. |
| `sessionId` | string | none | - | Search a single session instead of recent sessions. |
| `maxSessions` | integer | `25` | `1..100` | Recent sessions considered when `sessionId` is absent. |
| `maxMessagesPerSession` | integer | `100` | `1..300` | Messages scanned per session. |
| `caseSensitive` | boolean | `false` | - | Case-sensitive matching. |
| `regex` | boolean | `false` | - | Treat `query` as a regular expression. |
| `includeToolCalls` | boolean | `false` | - | Include tool input/output text in searchable content. |
| `maxPartChars` | integer | `4000` | `500..12000` | Per-part cap before searching. |
| `maxOutputChars` | integer | `30000` | `2000..80000` | Total output cap. |

Literal queries are capped at 1000 characters. Regex patterns are capped at 300 characters. Invalid regex syntax returns a bounded error, and known unsafe nested-quantifier or optional-atom-chain shapes are rejected to reduce catastrophic-backtracking risk. Regex matching still uses the JavaScript regular-expression engine, so prefer literal search for untrusted patterns.

## Privacy Model

Session transcripts can contain secrets, proprietary code, prompts, tool output, file paths, and local metadata. This plugin applies best-effort redaction for common secret shapes, URL credentials, sensitive query parameters, and sensitive object keys, strips terminal control sequences, then caps output sizes. Redaction is not a security boundary and cannot guarantee removal of every sensitive value.

Defaults avoid tool I/O and metadata in transcript output. Users must opt into `includeToolCalls` or `includeMetadata` per call.

User-facing SDK error messages and echoed search queries are redacted before display. Returned sessions are locally directory-validated when opencode provides a project directory. Degraded transcript output is reserved for decode/read-format failures; SDK/API failures surface distinctly.

## Read-Only Guarantee

The plugin intentionally exposes only:

- `session_list`
- `session_info`
- `session_read`
- `session_search`

It does not expose mutating opencode session APIs such as `delete`, `update`, `prompt`, `promptAsync`, `command`, `shell`, `fork`, `share`, `abort`, `summarize`, `revert`, or `unrevert`. Tests include tripwires to ensure tool execution does not call those APIs.

## Verification

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

npm is the canonical package manager for this repository. `package-lock.json` is authoritative; Bun lockfiles are not used.

Before publishing:

1. Update `CHANGELOG.md`.
2. Bump `package.json` using SemVer.
3. Run `npm ci`, `npm test`, `npm run check`, and `npm run pack:dry-run`.
4. Commit the release changes.
5. Tag as `vX.Y.Z`, for example `v0.1.0`.
6. Publish to npm with provenance enabled.

The public versioned contract includes tool names, tool arguments, defaults, caps, permission behavior, privacy/output modes, Node engine, package entrypoint, and the guarantee that mutating opencode session APIs are not exposed.

Breaking changes include removing or renaming a tool or argument, narrowing a documented bound, changing a default, broadening default output exposure, changing permission defaults, lowering privacy protections, raising the Node engine floor, or changing the package entrypoint.

## Support And Security

Use GitHub issues for bugs and documentation requests. Do not include secrets or private transcript content in public issues. Report suspected vulnerabilities privately using GitHub security advisories on this repository; see `SECURITY.md`.

See `CONTRIBUTING.md` for the development workflow and pull request expectations, and `CODE_OF_CONDUCT.md` for community standards.
