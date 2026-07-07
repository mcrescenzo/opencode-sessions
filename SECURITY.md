# Security Policy

## Supported Versions

Security fixes target the latest published `0.x` release of
`@mcrescenzo/opencode-sessions` and the current `main` branch.

## Reporting a Vulnerability

Please report security vulnerabilities privately using [GitHub security
advisories](https://github.com/mcrescenzo/opencode-sessions/security/advisories/new)
on this repository. Do not open a public issue for a suspected vulnerability.

Include a minimal reproduction, the affected version or commit, and the
expected versus actual behavior. You will receive an acknowledgement and,
once the report is triaged, an estimated timeline for a fix.

## Scope Notes

This plugin reads local opencode session history, which can contain secrets,
proprietary code, prompts, tool output, file paths, and other local metadata.
Redaction in this plugin is best-effort and is not a security boundary. If
you find a way to bypass redaction, exceed documented output bounds, escape
the current project directory scope, or reach a mutating opencode session
API through this plugin's tools, please report it privately as above.

Do not include secrets, credentials, or private transcript content in a
vulnerability report; describe the issue and how to reproduce it instead.
