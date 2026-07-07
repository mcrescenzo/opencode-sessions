import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package is not marked private (npm publish would refuse)", () => {
  assert.notEqual(pkg.private, true);
});

test("entry + core + community docs are in the files allowlist", () => {
  // README.md and LICENSE are deliberately absent: npm auto-includes both in
  // every tarball regardless of files[] (see docs/publishing.md's template note).
  assert.deepEqual([...pkg.files].sort(), [
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "opencode-sessions-core.js",
    "opencode-sessions.js",
  ]);
});

test("files allowlist excludes tests and dev-only paths", () => {
  for (const entry of pkg.files) {
    assert.doesNotMatch(entry, /^tests\//, `${entry} must not ship the test suite`);
    assert.doesNotMatch(entry, /^docs\//, `${entry} must not ship internal docs`);
    assert.doesNotMatch(entry, /^scripts\//, `${entry} must not ship dev-only scripts`);
  }
});

test("scoped package is configured for public publish", () => {
  assert.equal(pkg.publishConfig?.access, "public");
  assert.ok(pkg.engines?.node, "must declare an engines.node floor");
});

test("npm is the canonical package manager and release gate", () => {
  assert.equal(existsSync(new URL("../package-lock.json", import.meta.url)), true);
  // Per-plugin `bun install` is the documented repo-wide dev workflow (see AGENTS.md)
  // and may produce an untracked bun.lock as a side effect even though npm remains
  // this package's canonical package manager and release gate. bun.lock is
  // gitignored; its presence or absence on disk is not asserted here.
  assert.match(pkg.scripts?.test ?? "", /^node --test /);
  assert.match(pkg.scripts?.check ?? "", /node --check opencode-sessions\.js/);
  assert.match(pkg.scripts?.["pack:dry-run"] ?? "", /^npm pack --dry-run --json$/);
  assert.match(pkg.scripts?.prepublishOnly ?? "", /npm test/);
  assert.match(pkg.scripts?.prepublishOnly ?? "", /npm run check/);
  assert.match(pkg.scripts?.prepublishOnly ?? "", /npm run pack:dry-run/);
});
