# OpenCode Sessions Plugin Notes

**Contract version:** `@opencode-ai/plugin@1.17.7` (declared range: `^1.17.7`)
**Verified against runtime:** opencode 1.17.7 (contract-level verification; see tests)

- This repository contains the standalone `@mcrescenzo/opencode-sessions` OpenCode plugin.
- Plugin entrypoint is `opencode-sessions.js` and registers read-only local session history tools: `session_list`, `session_info`, `session_read`, and `session_search`.
- Do not add mutating wrappers around OpenCode session APIs such as delete, update, prompt, promptAsync, command, shell, fork, share, abort, summarize, revert, or unrevert.
- Session transcripts can contain secrets. Keep outputs bounded and redacted by default; preserve tests for redaction/truncation before changing formatting.
- Run tests with `npm test` (`node --test tests/*.test.mjs`). A focused syntax check is `npm run check`.
- After changing this plugin or its registration in OpenCode config, restart OpenCode; running sessions keep already-loaded plugin code.
