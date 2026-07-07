import assert from "node:assert/strict";
import test from "node:test";
import SessionsPlugin from "../opencode-sessions.js";
import {
  clampInt,
  compactStatus,
  compileMatcher,
  errorText,
  formatMessage,
  formatSessionLine,
  MAX_LITERAL_QUERY_CHARS,
  MAX_REGEX_PATTERN_CHARS,
  partText,
  redactText,
  redactValue,
  safeJson,
  snippet,
  totalCap,
} from "../opencode-sessions-core.js";

const sessions = [
  {
    id: "s-old",
    projectID: "p",
    directory: "/repo",
    title: "Older session",
    time: { created: 1_700_000_000_000, updated: 1_700_000_010_000 },
    summary: { files: 1, additions: 2, deletions: 1 },
    version: "1",
  },
  {
    id: "s-new",
    projectID: "p",
    directory: "/repo",
    parentID: "s-old",
    title: "Newer session",
    time: { created: 1_700_000_020_000, updated: 1_700_000_030_000 },
    summary: { files: 2, additions: 8, deletions: 3 },
    version: "1",
  },
];

const messages = {
  "s-new": [
    {
      info: {
        id: "m-user",
        sessionID: "s-new",
        role: "user",
        time: { created: 1_700_000_031_000 },
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        metadata: { api_key: "metadata-secret-12345", nested: { refreshToken: "refresh-secret-12345" } },
      },
      parts: [{ id: "p1", type: "text", text: "Please inspect the payment flow. API_KEY=supersecretvalue123" }],
    },
    {
      info: {
        id: "m-assistant",
        sessionID: "s-new",
        role: "assistant",
        time: { created: 1_700_000_032_000 },
        mode: "build",
        providerID: "openai",
        modelID: "gpt-5.5",
      },
      parts: [
        { id: "p2", type: "text", text: "The payment flow uses checkout sessions." },
        {
          id: "p3",
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "printenv", env: { password: "tool-password-12345", nested: [{ accessToken: "tool-token-12345" }] } },
            output: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz\ncheckout OK",
            title: "printenv",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      ],
    },
  ],
  "s-old": [
    {
      info: { id: "m-old", sessionID: "s-old", role: "assistant", time: { created: 1_700_000_011_000 }, mode: "build" },
      parts: [{ id: "p-old", type: "text", text: "Legacy auth investigation." }],
    },
  ],
};

function fakePluginContext(overrides = {}) {
  const calls = [];
  const mutatingCalls = [];
  const mutatingStub = (name) => async () => {
    mutatingCalls.push(name);
    throw new Error(`${name} should not be called`);
  };
  const defaultSession = {
    async list(input) {
      calls.push(["list", input]);
      return { data: sessions };
    },
    async get(input) {
      calls.push(["get", input]);
      const id = input.path?.id ?? input.sessionID;
      const found = sessions.find((session) => session.id === id);
      return found ? { data: found } : { error: { data: { message: "not found" } } };
    },
    async status(input) {
      calls.push(["status", input]);
      return { data: { "s-new": { type: "idle" } } };
    },
    async children(input) {
      calls.push(["children", input]);
      return { data: [] };
    },
    async todo(input) {
      calls.push(["todo", input]);
      return { data: [{ content: "check", status: "completed" }, { content: "ship", status: "pending" }] };
    },
    async diff(input) {
      calls.push(["diff", input]);
      return { data: [{ file: "a.js", before: "", after: "x", additions: 1, deletions: 0 }] };
    },
    async messages(input) {
      calls.push(["messages", input]);
      const id = input.path?.id ?? input.sessionID;
      return { data: messages[id] ?? [] };
    },
    delete: mutatingStub("delete"),
    update: mutatingStub("update"),
    prompt: mutatingStub("prompt"),
    promptAsync: mutatingStub("promptAsync"),
    command: mutatingStub("command"),
    shell: mutatingStub("shell"),
    fork: mutatingStub("fork"),
    share: mutatingStub("share"),
    abort: mutatingStub("abort"),
    summarize: mutatingStub("summarize"),
    revert: mutatingStub("revert"),
    unrevert: mutatingStub("unrevert"),
  };
  const client = {
    ...overrides.client,
    session: {
      ...defaultSession,
      ...overrides.client?.session,
    },
  };
  return { ...overrides, client, calls, mutatingCalls };
}

async function harness(overrides = {}) {
  const pluginContext = fakePluginContext(overrides);
  const hooks = await SessionsPlugin(pluginContext);
  const context = { directory: "/repo", sessionID: "s-new", agent: "build" };
  return { ...pluginContext, hooks, tools: hooks.tool, context };
}

test("plugin registers only read-only session tools", async () => {
  const { tools } = await harness();
  assert.deepEqual(Object.keys(tools).sort(), ["session_info", "session_list", "session_read", "session_search"]);
});

test("tool execution never calls mutating session APIs", async () => {
  const { tools, context, mutatingCalls } = await harness();
  await tools.session_list.execute({}, context);
  await tools.session_info.execute({ sessionId: "s-new", includeDiff: true }, context);
  await tools.session_read.execute({ sessionId: "s-new", includeToolCalls: true }, context);
  await tools.session_search.execute({ query: "payment", maxSessions: 2, includeToolCalls: true }, context);
  assert.deepEqual(mutatingCalls, []);
});

test("config hook does not auto-allow session tools", async () => {
  const { hooks } = await harness();
  const cfg = {
    permission: {},
    agent: {
      build: { permission: { read: "allow" } },
      locked: { permission: "deny" },
    },
  };
  await hooks.config(cfg);
  for (const name of ["session_info", "session_list", "session_read", "session_search"]) {
    assert.equal(cfg.permission[name], undefined);
    assert.equal(cfg.agent.build.permission[name], undefined);
  }
  assert.equal(cfg.agent.build.permission.read, "allow");
  assert.equal(cfg.agent.locked.permission, "deny");
});

test("session_list sorts, limits, marks current session, and uses v1 SDK query shape", async () => {
  const { tools, context, calls } = await harness();
  const output = await tools.session_list.execute({ limit: 1 }, context);
  assert.match(output, /showing 1\/2/);
  assert.match(output, /s-new \[current\]/);
  assert.doesNotMatch(output, /^2\. s-old/m);
  assert.deepEqual(calls[0], ["list", { query: { directory: "/repo" } }]);
});

test("session_list handles alternate SDK session id fields", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async list() {
          return {
            data: [
              { sessionID: "s-new", title: "Current alternate id", directory: "/repo", time: { updated: 3 } },
              { sessionId: "s-old", title: "Older alternate id", directory: "/repo", time: { updated: 2 } },
            ],
          };
        },
      },
    },
  });
  const output = await tools.session_list.execute({ includeCurrent: false }, context);
  assert.match(output, /showing 1\/1/);
  assert.match(output, /1\. s-old/);
  assert.doesNotMatch(output, /s-new/);
  assert.doesNotMatch(output, /<missing-id>/);
});

test("tools ignore caller-supplied directory and use context.directory", async () => {
  const { tools, context, calls } = await harness();
  await tools.session_list.execute({ directory: "/other", limit: 1 }, context);
  await tools.session_info.execute({ directory: "/other", sessionId: "s-new" }, context);
  await tools.session_read.execute({ directory: "/other", sessionId: "s-new", limit: 1 }, context);
  await tools.session_search.execute({ directory: "/other", sessionId: "s-new", query: "payment" }, context);

  const serializedCalls = JSON.stringify(calls);
  assert.doesNotMatch(serializedCalls, /\/other/);
  assert.match(serializedCalls, /\/repo/);
});

test("tools ignore caller-supplied directory when context.directory is absent", async () => {
  const { tools, context, calls } = await harness();
  const contextNoDir = { ...context, directory: undefined };
  const list = await tools.session_list.execute({ directory: "/other", limit: 1 }, contextNoDir);
  const read = await tools.session_read.execute({ directory: "/other", sessionId: "s-new", limit: 1 }, contextNoDir);
  await tools.session_search.execute({ directory: "/other", sessionId: "s-new", query: "payment" }, contextNoDir);

  assert.match(list, /Session list for <default>/);
  assert.match(read, / in <default>:/);
  assert.doesNotMatch(`${list}\n${read}`, /\/other/);
  for (const [, input] of calls) {
    assert.equal(input.query?.directory ?? input.directory, undefined);
  }
});

test("session_info includes status, child, todo, and optional diff summaries", async () => {
  const { tools, context } = await harness();
  const output = await tools.session_info.execute({ sessionId: "s-new", includeDiff: true }, context);
  assert.match(output, /Session info: Newer session/);
  assert.match(output, /status: idle/);
  assert.match(output, /children: 0/);
  assert.match(output, /todos: 2 \(completed:1, pending:1\)/);
  assert.match(output, /diff: 1 files, \+1\/-0/);
});

test("session_info redacts primary session fields", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          return {
            data: {
              id: "API_KEY=sessionsecret12345",
              title: "password=titlesecret12345",
              directory: "/repo/token=dirsecret12345",
              parentID: "secret=parentsecret12345",
              time: {},
            },
          };
        },
      },
    },
  });
  const output = await tools.session_info.execute(
    { sessionId: "API_KEY=sessionsecret12345", includeStatus: false, includeChildren: false, includeTodos: false },
    { ...context, directory: "/repo/token=dirsecret12345" },
  );
  assert.match(output, /API_KEY=<redacted>/);
  assert.match(output, /password=<redacted>/);
  assert.match(output, /token=<redacted>/);
  assert.match(output, /parent: secret=<redacted>/);
  assert.doesNotMatch(output, /sessionsecret12345|titlesecret12345|dirsecret12345|parentsecret12345/);
});

test("session_info redacts user-facing SDK error messages", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async status() {
          return { error: { data: { message: "status failed with password=supersecretvalue123" } } };
        },
      },
    },
  });
  const output = await tools.session_info.execute({ sessionId: "s-new", includeChildren: false, includeTodos: false }, context);
  assert.match(output, /status: error: session status failed: status failed with password=<redacted>/);
  assert.doesNotMatch(output, /supersecretvalue123/);
});

test("session_info surfaces and redacts primary get wrapper failures", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          return { error: { data: { message: "not found token=supersecretvalue123" } } };
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_info.execute({ sessionId: "s-new" }, context),
    (error) => {
      assert.match(error.message, /session get failed: not found token=<redacted>/);
      assert.doesNotMatch(error.message, /supersecretvalue123/);
      return true;
    },
  );
});

test("session_info bounds and redacts raw SDK get failures", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          throw new Error(`fetch failed password=supersecretvalue123 ${"x".repeat(2_000)}`);
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_info.execute({ sessionId: "s-new", includeChildren: false, includeTodos: false }, context),
    (error) => {
      assert.ok(error.message.length < 700, `error was ${error.message.length} chars`);
      assert.match(error.message, /password=<redacted>/);
      assert.match(error.message, /truncated/);
      assert.doesNotMatch(error.message, /supersecretvalue123/);
      return true;
    },
  );
});

test("session_info validates returned directory before per-session subcalls", async () => {
  let subcalls = 0;
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          return { data: { id: "s-new", title: "Other project", directory: "/other", time: {} } };
        },
        async status() {
          subcalls += 1;
          return { data: {} };
        },
        async children() {
          subcalls += 1;
          return { data: [] };
        },
        async todo() {
          subcalls += 1;
          return { data: [] };
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_info.execute({ sessionId: "s-new" }, context),
    /session scope validation failed: session directory mismatch/,
  );
  assert.equal(subcalls, 0);
});

test("session_info rejects promptly when aborted mid-flight", async () => {
  const controller = new AbortController();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          controller.abort(new Error("token=supersecretvalue123"));
          return pending;
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_info.execute({ sessionId: "s-new" }, { ...context, abort: controller.signal }),
    (error) => {
      assert.match(error.message, /operation aborted/);
      assert.match(error.message, /token=<redacted>/);
      assert.doesNotMatch(error.message, /supersecretvalue123/);
      release();
      return true;
    },
  );
});

test("session_read formats transcript, omits tool output by default, and redacts secrets", async () => {
  const { tools, context } = await harness();
  const output = await tools.session_read.execute({ sessionId: "s-new" }, context);
  assert.match(output, /Transcript for Newer session/);
  assert.match(output, /API_KEY=<redacted>/);
  assert.match(output, /output omitted/);
  assert.doesNotMatch(output, /\nmetadata:/);
  assert.doesNotMatch(output, /metadata-secret-12345|refresh-secret-12345/);
  assert.doesNotMatch(output, /abcdefghijklmnopqrstuvwxyz/);
});

test("session_read redacts successful transcript header fields", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          return { data: { id: "API_KEY=sessionsecret12345", title: "password=titlesecret12345", directory: "/repo", time: {} } };
        },
        async messages() {
          return { data: messages["s-new"] };
        },
      },
    },
  });
  const output = await tools.session_read.execute({ sessionId: "API_KEY=sessionsecret12345", limit: 1 }, context);
  assert.match(output, /Transcript for password=<redacted> \(API_KEY=<redacted>\) in \/repo/);
  assert.doesNotMatch(output, /sessionsecret12345|titlesecret12345/);
});

test("session_read can include bounded redacted tool calls", async () => {
  const { tools, context } = await harness();
  const output = await tools.session_read.execute({ sessionId: "s-new", includeToolCalls: true }, context);
  assert.match(output, /input:/);
  assert.match(output, /Authorization: Bearer <redacted>/);
  assert.match(output, /"password": "<redacted>"/);
  assert.match(output, /"accessToken": "<redacted>"/);
  assert.match(output, /checkout OK/);
  assert.doesNotMatch(output, /tool-password-12345/);
  assert.doesNotMatch(output, /tool-token-12345/);
});

test("session_read redacts metadata and does not expose raw mode", async () => {
  const { tools, context } = await harness();
  assert.equal(Object.hasOwn(tools.session_read.args, "raw"), false);

  const metadata = await tools.session_read.execute({ sessionId: "s-new", includeMetadata: true, limit: 1 }, context);
  assert.match(metadata, /"api_key": "<redacted>"/);
  assert.match(metadata, /"refreshToken": "<redacted>"/);
  assert.doesNotMatch(metadata, /metadata-secret-12345/);
  assert.doesNotMatch(metadata, /refresh-secret-12345/);
});

test("session_read and session_search include message error text by default", async () => {
  const failingMessages = [
    {
      info: {
        id: "m-error",
        sessionID: "s-new",
        role: "assistant",
        time: { created: 1_700_000_033_000 },
        error: {
          name: "MessageAbortedError",
          data: { message: "context_length_exceeded: reduce input size token=supersecretvalue123" },
        },
      },
      parts: [],
    },
  ];
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          return { data: failingMessages };
        },
      },
    },
  });

  const read = await tools.session_read.execute({ sessionId: "s-new" }, context);
  assert.match(read, /\[message error\] context_length_exceeded/);
  assert.doesNotMatch(read, /supersecretvalue123/);

  const search = await tools.session_search.execute({ sessionId: "s-new", query: "context_length_exceeded" }, context);
  assert.match(search, /1 matches/);
  assert.match(search, /\[message error\] context_length_exceeded/);
  assert.doesNotMatch(search, /supersecretvalue123/);
});

test("formatters redact secrets in compact labels and final output caps", () => {
  assert.match(totalCap("Session list for /repo/API_KEY=supersecretvalue123"), /API_KEY=<redacted>/);
  for (const [raw, expected] of [
    [`github_pat_${"A".repeat(30)}`, "github_pat_<redacted>"],
    [`ghp_${"A".repeat(30)}`, "ghp_<redacted>"],
    [`gho_${"A".repeat(30)}`, "gho_<redacted>"],
    [`sk-proj-${"A".repeat(30)}-${"B".repeat(20)}`, "sk-<redacted>"],
    [`xoxb-${"A".repeat(30)}`, "xoxb-<redacted>"],
    ["OPENAI_API_KEY=redactedstylevalue12345", "OPENAI_API_KEY=<redacted>"],
    ["accessToken=redactedstylevalue12345", "accessToken=<redacted>"],
    ['API_KEY="abc def secret value"', 'API_KEY="<redacted>"'],
    ["TOKEN='abc def secret value'", "TOKEN='<redacted>'"],
    ["https://user:passwordsecret12345@example.com/path", "https://user:<redacted>@example.com/path"],
    ["https://example.com/cb?access_token=querysecret12345&ok=1", "https://example.com/cb?access_token=<redacted>&ok=1"],
  ]) {
    assert.equal(redactText(raw), expected);
  }
  const pem = "-----BEGIN PRIVATE KEY-----\nabc123secret\n-----END PRIVATE KEY-----";
  assert.equal(redactText(pem), "-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----");
  assert.equal(totalCap("safe\u001b[31mred\u001b[0m text \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007"), "safered text link");

  const line = formatSessionLine(
    {
      id: "s-secret",
      parentID: "token=parentsecret12345",
      title: "API_KEY=titlesecret12345",
      directory: "/repo/password=directorysecret12345",
      time: {},
    },
    0,
    "",
  );
  assert.match(line, /API_KEY=<redacted>/);
  assert.match(line, /parent=token=<redacted>/);
  assert.match(line, /directory=\/repo\/password=<redacted>/);
  assert.doesNotMatch(line, /titlesecret12345|parentsecret12345|directorysecret12345/);

  assert.match(compactStatus("password=statussecret12345"), /password=<redacted>/);

  const file = partText({
    type: "file",
    filename: "API_KEY=filesecret12345",
    source: { type: "file", path: "/tmp/token=sourcesecret12345" },
  });
  assert.match(file, /API_KEY=<redacted>/);
  assert.match(file, /token=<redacted>/);
  assert.doesNotMatch(file, /filesecret12345|sourcesecret12345/);

  const patch = partText({ type: "patch", files: ["password=patchsecret12345"] });
  assert.match(patch, /password=<redacted>/);
  assert.doesNotMatch(patch, /patchsecret12345/);

  const tool = partText({
    type: "tool",
    tool: "bash",
    state: { status: "completed", title: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" },
  });
  assert.match(tool, /Bearer <redacted>/);
  assert.doesNotMatch(tool, /abcdefghijklmnopqrstuvwxyz/);

  const message = formatMessage({
    info: {
      id: "token=messagesecret12345",
      role: "assistant",
      agent: "password=agentsecret12345",
      providerID: "openai",
      modelID: "API_KEY=modelsecret12345",
    },
    parts: [{ type: "snapshot", snapshot: "secret=snapshotsecret12345" }],
  });
  assert.match(message, /token=<redacted>/);
  assert.match(message, /password=<redacted>/);
  assert.match(message, /API_KEY=<redacted>/);
  assert.match(message, /secret=<redacted>/);
  assert.doesNotMatch(message, /messagesecret12345|agentsecret12345|modelsecret12345|snapshotsecret12345/);
});

test("errorText falls back when error messages are empty", () => {
  assert.equal(errorText(new Error()), "unknown error");
  assert.equal(errorText({ message: "", data: { message: "fallback detail" } }), "fallback detail");
  assert.equal(partText({ type: "retry", attempt: 2, error: new Error() }), "[retry 2] unknown error");
});

test("session_read enforces the requested limit locally", async () => {
  const { tools, context } = await harness();
  const output = await tools.session_read.execute({ sessionId: "s-new", limit: 1 }, context);
  assert.match(output, /1 messages \(limit=1\)/);
  assert.match(output, /m-user/);
  assert.doesNotMatch(output, /m-assistant/);
});

test("session_read enforces maxPartChars and maxOutputChars caps", async () => {
  const longMessages = Array.from({ length: 8 }, (_, index) => ({
    info: { id: `long-${index}`, sessionID: "s-new", role: "assistant", time: { created: 1_700_000_050_000 + index } },
    parts: [{ type: "text", text: "x".repeat(900) }],
  }));
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() { return { data: longMessages }; },
      },
    },
  });
  const output = await tools.session_read.execute({ sessionId: "s-new", maxPartChars: 500, maxOutputChars: 2_000 }, context);
  assert.match(output, /truncated 400 chars/);
  assert.match(output, /output truncated/);
  assert.ok(output.length < 2_200);
});

test("session_read stops formatting once the output budget is exhausted", async () => {
  const unreadPart = {};
  Object.defineProperty(unreadPart, "type", {
    get() {
      throw new Error("later part should not be formatted");
    },
  });
  const unreadMessage = {
    info: { id: "unread-message", sessionID: "s-new", role: "assistant", time: { created: 1_700_000_060_000 } },
  };
  Object.defineProperty(unreadMessage, "parts", {
    get() {
      throw new Error("later message should not be formatted");
    },
  });
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          return {
            data: [
              {
                info: { id: "huge-message", sessionID: "s-new", role: "assistant", time: { created: 1_700_000_050_000 } },
                parts: [{ type: "text", text: "x".repeat(5_000) }, unreadPart],
              },
              unreadMessage,
            ],
          };
        },
      },
    },
  });
  const output = await tools.session_read.execute({ sessionId: "s-new", maxOutputChars: 2_000 }, context);
  assert.match(output, /output truncated|stopped before formatting remaining messages|message output truncated/);
  assert.doesNotMatch(output, /unread-message/);
});

test("session_read degrades only transcript decode failures", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          throw new Error("failed to decode transcript: malformed JSON");
        },
      },
    },
  });
  const output = await tools.session_read.execute({ sessionId: "s-new" }, context);
  assert.match(output, /DEGRADED READ/);
  assert.match(output, /decode\/read-format error/);
  assert.match(output, /failed to decode transcript: malformed JSON/);
});

test("session_read degraded transcript output is redacted and bounded", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          return { data: { id: "s-new", title: "secret=titlesecret12345", directory: "/repo", time: {} } };
        },
        async messages() {
          throw new Error(`failed to decode transcript token=supersecretvalue123 ${"x".repeat(2_000)}`);
        },
      },
    },
  });
  const output = await tools.session_read.execute({ sessionId: "API_KEY=sessionsecret12345", maxOutputChars: 2_000 }, context);
  assert.match(output, /DEGRADED READ/);
  assert.match(output, /secret=<redacted>/);
  assert.match(output, /API_KEY=<redacted>/);
  assert.match(output, /token=<redacted>/);
  assert.match(output, /truncated|output truncated/);
  assert.doesNotMatch(output, /titlesecret12345|sessionsecret12345|supersecretvalue123/);
});

test("session_read surfaces non-decode message failures", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          return { error: { data: { message: "permission denied" } } };
        },
      },
    },
  });
  await assert.rejects(() => tools.session_read.execute({ sessionId: "s-new" }, context), /session messages failed: permission denied/);
});

test("transcript mentions in operational errors remain non-decode failures", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          throw new Error("permission denied reading transcript file");
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_read.execute({ sessionId: "s-new" }, context),
    /permission denied reading transcript file/,
  );
  await assert.rejects(
    () => tools.session_search.execute({ query: "payment", maxSessions: 2 }, context),
    /non-decode message read failures/,
  );
});

test("session_read surfaces and redacts primary get failures", async () => {
  let messageCalls = 0;
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          return { error: { data: { message: "not found token=supersecretvalue123" } } };
        },
        async messages() {
          messageCalls += 1;
          return { data: [] };
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_read.execute({ sessionId: "s-new" }, context),
    (error) => {
      assert.match(error.message, /session get failed: not found token=<redacted>/);
      assert.doesNotMatch(error.message, /supersecretvalue123/);
      return true;
    },
  );
  assert.equal(messageCalls, 0);
});

test("session_read redacts non-decode message failure text", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          return { error: { data: { message: "permission denied API_KEY=supersecretvalue123" } } };
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_read.execute({ sessionId: "s-new" }, context),
    (error) => {
      assert.match(error.message, /API_KEY=<redacted>/);
      assert.doesNotMatch(error.message, /supersecretvalue123/);
      return true;
    },
  );
});

test("session_read bounds non-decode SDK error text", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          return { error: { data: { message: `permission denied API_KEY=supersecretvalue123 ${"x".repeat(2_000)}` } } };
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_read.execute({ sessionId: "s-new" }, context),
    (error) => {
      assert.ok(error.message.length < 700, `error was ${error.message.length} chars`);
      assert.match(error.message, /API_KEY=<redacted>/);
      assert.match(error.message, /truncated/);
      assert.doesNotMatch(error.message, /supersecretvalue123/);
      return true;
    },
  );
});

test("session_read bounds and redacts raw non-decode SDK errors", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          throw new Error(`fetch failed: connect ECONNREFUSED password=supersecretvalue123 ${"x".repeat(2_000)}`);
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_read.execute({ sessionId: "s-new" }, context),
    (error) => {
      assert.ok(error.message.length < 700, `error was ${error.message.length} chars`);
      assert.match(error.message, /password=<redacted>/);
      assert.match(error.message, /truncated/);
      assert.doesNotMatch(error.message, /supersecretvalue123/);
      return true;
    },
  );
});

test("session_read surfaces missing message APIs", async () => {
  const { tools, context } = await harness({ client: { session: { messages: undefined } } });
  await assert.rejects(() => tools.session_read.execute({ sessionId: "s-new" }, context), /session API method is unavailable: messages/);
});

test("session_search scans recent sessions and returns snippets", async () => {
  const { tools, context } = await harness();
  const output = await tools.session_search.execute({ query: "payment", maxSessions: 2 }, context);
  assert.match(output, /2 matches across 2 session/);
  assert.match(output, /s-new/);
  assert.match(output, /payment flow/);
});

test("session_search redacts the echoed query", async () => {
  const { tools, context } = await harness();
  const output = await tools.session_search.execute({ query: "API_KEY=supersecretvalue123", maxSessions: 1 }, context);
  assert.match(output, /Session search for text "API_KEY=<redacted>"/);
  assert.doesNotMatch(output, /supersecretvalue123/);
});

test("session_search returns bounded friendly regex errors", async () => {
  const { tools, context } = await harness();
  const invalid = await tools.session_search.execute({ query: "(", regex: true }, context);
  assert.match(invalid, /Session search error: Invalid session_search regex/);

  const tooLong = await tools.session_search.execute({ query: "a".repeat(MAX_REGEX_PATTERN_CHARS + 1), regex: true }, context);
  assert.match(tooLong, /Session search error: session_search regex is too long/);

  const literalTooLong = await tools.session_search.execute({ query: "a".repeat(MAX_LITERAL_QUERY_CHARS + 1) }, context);
  assert.match(literalTooLong, /Session search error: session_search literal query is too long/);

  const unsafe = await tools.session_search.execute({ query: "(a+)+$", regex: true }, context);
  assert.match(unsafe, /Session search error: Unsafe session_search regex rejected/);

  for (const query of ["((a+))+$", "(a{1,3})+$", "(a|aa)+$", "(a|a?)+$", "a?a?a?a?a?a?a?a?aaaaaaaa"]) {
    const output = await tools.session_search.execute({ query, regex: true }, context);
    assert.match(output, /Session search error: Unsafe session_search regex rejected/, query);
  }

  for (const query of ["(?:payment|checkout)+", "(?:a|b){2,5}", "(?<name>foo)+"]) {
    const output = await tools.session_search.execute({ query, regex: true }, context);
    assert.doesNotMatch(output, /Unsafe session_search regex rejected/, query);
  }
});

test("session_search honors caseSensitive true", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          return {
            data: [{
              info: { id: "m-case", sessionID: "s-new", role: "assistant", time: { created: 1_700_000_033_000 } },
              parts: [{ type: "text", text: "Payment only appears capitalized." }],
            }],
          };
        },
      },
    },
  });
  const caseSensitive = await tools.session_search.execute({ sessionId: "s-new", query: "payment", caseSensitive: true }, context);
  assert.match(caseSensitive, /0 matches/);
  const caseInsensitive = await tools.session_search.execute({ sessionId: "s-new", query: "payment" }, context);
  assert.match(caseInsensitive, /1 matches/);
});

test("session_search does not search tool output unless requested", async () => {
  const { tools, context } = await harness();
  const withoutTools = await tools.session_search.execute({ query: "checkout OK", maxSessions: 1 }, context);
  assert.match(withoutTools, /0 matches/);
  const withTools = await tools.session_search.execute({ query: "checkout OK", maxSessions: 1, includeToolCalls: true }, context);
  assert.match(withTools, /1 matches/);
});

test("session_search preserves the explicit session id when get returns an alternate id key", async () => {
  const { tools, context, calls } = await harness({
    client: {
      session: {
        async get() {
          return { data: { sessionID: "s-new", title: "Alternate id session", directory: "/repo" } };
        },
      },
    },
  });
  const output = await tools.session_search.execute({ sessionId: "s-new", query: "payment" }, context);
  assert.match(output, /s-new — Alternate id session/);
  const messageCall = calls.find(([name]) => name === "messages");
  assert.deepEqual(messageCall, ["messages", { path: { id: "s-new" }, query: { directory: "/repo", limit: 100 } }]);
});

test("session_search skips malformed listed sessions without undefined message reads", async () => {
  const { tools, context, calls } = await harness({
    client: {
      session: {
        async list() {
          return { data: [null, { title: "missing id" }, sessions[1]] };
        },
      },
    },
  });
  const output = await tools.session_search.execute({ query: "payment", maxSessions: 3 }, context);
  assert.match(output, /2 malformed session candidate\(s\) skipped/);
  assert.match(output, /2 matches/);
  const messageCalls = calls.filter(([name]) => name === "messages");
  assert.equal(messageCalls.length, 1);
  assert.deepEqual(messageCalls[0], ["messages", { path: { id: "s-new" }, query: { directory: "/repo", limit: 100 } }]);
});

test("session_search surfaces explicit non-decode message failures", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          return { error: { data: { message: "permission denied" } } };
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_search.execute({ sessionId: "s-new", query: "payment" }, context),
    /session_search message read failed for s-new: session messages failed: permission denied/,
  );
});

test("session_search redacts session ids in thrown message failure summaries", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          return { data: { id: "API_KEY=sessionsecret12345", title: "Secret id session", directory: "/repo" } };
        },
        async messages() {
          return { error: { data: { message: "permission denied" } } };
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_search.execute({ sessionId: "API_KEY=sessionsecret12345", query: "payment" }, context),
    (error) => {
      assert.match(error.message, /API_KEY=<redacted>/);
      assert.doesNotMatch(error.message, /sessionsecret12345/);
      return true;
    },
  );
});

test("session_search bounds long session labels in failure summaries", async () => {
  const longId = `session-${"x".repeat(1_000)}-API_KEY=sessionsecret12345`;
  const { tools, context } = await harness({
    client: {
      session: {
        async list() {
          return { data: [{ id: longId, title: "Long id", directory: "/repo", time: { updated: 2 } }] };
        },
        async messages() {
          return { error: { data: { message: "permission denied" } } };
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_search.execute({ query: "payment", maxSessions: 1 }, context),
    (error) => {
      assert.ok(error.message.length < 900, `error was ${error.message.length} chars`);
      assert.match(error.message, /truncated/);
      assert.doesNotMatch(error.message, /sessionsecret12345/);
      return true;
    },
  );
});

test("session_search fails broad search when all candidates have non-decode message failures", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          return { error: { data: { message: "permission denied" } } };
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_search.execute({ query: "payment", maxSessions: 2 }, context),
    /could not read any candidate sessions; non-decode message read failures: s-new: session messages failed: permission denied; s-old: session messages failed: permission denied/,
  );
});

test("session_search rejects explicit sessions outside the context directory before reading messages", async () => {
  let messageCalls = 0;
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          return { data: { id: "s-new", title: "Other project", directory: "/other", time: {} } };
        },
        async messages() {
          messageCalls += 1;
          return { data: [] };
        },
      },
    },
  });
  await assert.rejects(
    () => tools.session_search.execute({ sessionId: "s-new", query: "payment" }, context),
    /session scope validation failed: session directory mismatch/,
  );
  assert.equal(messageCalls, 0);
});

test("session_search treats bare json and parse messages as non-decode failures", async () => {
  for (const message of [
    "upstream rejected the request: Content-Type must be application/json",
    "failed to parse query parameter",
  ]) {
    const { tools, context } = await harness({
      client: {
        session: {
          async messages() {
            throw new Error(message);
          },
        },
      },
    });
    await assert.rejects(
      () => tools.session_search.execute({ query: "payment", maxSessions: 2 }, context),
      /could not read any candidate sessions; non-decode message read failures/,
    );
  }
});

test("session_search reports broad non-decode failures when some sessions are readable", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages(input) {
          const id = input.path?.id ?? input.sessionID;
          if (id === "s-old") return { error: { data: { message: "permission denied" } } };
          return { data: messages[id] ?? [] };
        },
      },
    },
  });
  const output = await tools.session_search.execute({ query: "payment", maxSessions: 2 }, context);
  assert.match(output, /2 matches/);
  assert.match(output, /1 session\(s\) had non-decode message read failures: s-old: session messages failed: permission denied/);
});

test("session_search partial non-decode failure notes are redacted", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async list() {
          return {
            data: [
              { id: "s-new", title: "Readable", directory: "/repo", time: { updated: 2 } },
              { id: "API_KEY=sessionsecret12345", title: "secret id", directory: "/repo", time: { updated: 1 } },
            ],
          };
        },
        async messages(input) {
          const id = input.path?.id ?? input.sessionID;
          if (id === "API_KEY=sessionsecret12345") return { error: { data: { message: "permission denied password=errsecret12345" } } };
          return { data: messages[id] ?? [] };
        },
      },
    },
  });
  const output = await tools.session_search.execute({ query: "payment", maxSessions: 2 }, context);
  assert.match(output, /had non-decode message read failures/);
  assert.match(output, /API_KEY=<redacted>/);
  assert.match(output, /password=<redacted>/);
  assert.doesNotMatch(output, /sessionsecret12345|errsecret12345/);
});

test("session_search skips transcript decode failures with bounded causes", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages(input) {
          const id = input.path?.id ?? input.sessionID;
          if (id === "s-old") throw new Error("failed to decode transcript: malformed JSON");
          return { data: messages[id] ?? [] };
        },
      },
    },
  });
  const output = await tools.session_search.execute({ query: "payment", maxSessions: 2 }, context);
  assert.match(output, /2 matches/);
  assert.match(output, /1 session\(s\) skipped due to transcript decode\/read-format errors: s-old: failed to decode transcript: malformed JSON/);
});

test("session_search decode-failure notes are redacted and bounded", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async messages(input) {
          const id = input.path?.id ?? input.sessionID;
          if (id === "s-old") throw new Error(`failed to decode transcript token=supersecretvalue123 ${"x".repeat(2_000)}`);
          return { data: messages[id] ?? [] };
        },
      },
    },
  });
  const output = await tools.session_search.execute({ query: "payment", maxSessions: 2 }, context);
  assert.match(output, /skipped due to transcript decode\/read-format errors/);
  assert.match(output, /token=<redacted>/);
  assert.match(output, /truncated/);
  assert.doesNotMatch(output, /supersecretvalue123/);
});

test("session_search result rows redact session id and title", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async get() {
          return { data: { id: "API_KEY=sessionsecret12345", title: "password=titlesecret12345", directory: "/repo", time: {} } };
        },
        async messages() {
          return { data: messages["s-new"] };
        },
      },
    },
  });
  const output = await tools.session_search.execute({ sessionId: "API_KEY=sessionsecret12345", query: "payment" }, context);
  assert.match(output, /API_KEY=<redacted> — password=<redacted>/);
  assert.doesNotMatch(output, /sessionsecret12345|titlesecret12345/);
});

test("session_search stops issuing message reads after abort", async () => {
  const controller = new AbortController();
  let messageCalls = 0;
  const { tools, context } = await harness({
    client: {
      session: {
        async messages() {
          messageCalls += 1;
          controller.abort();
          return { data: [] };
        },
      },
    },
  });
  const output = await tools.session_search.execute({ query: "payment", maxSessions: 2 }, { ...context, abort: controller.signal });
  assert.equal(messageCalls, 1);
  assert.match(output, /0 matches across 1 session\(s\) scanned \(2 candidate session\(s\)/);
});

test("literal matcher indices and snippets use original text coordinates", () => {
  const text = "\u0130abcde needle FGHIJKLMNOP";
  const matcher = compileMatcher("needle", { caseSensitive: false });
  assert.equal(matcher.index(text), text.indexOf("needle"));
  assert.match(snippet(text, matcher, 6), /abcde needle/);
});

test("snippets include the full matched span before trailing context", () => {
  const matcher = compileMatcher("needle.{0,300}tail", { regex: true });
  const text = `prefix needle${"X".repeat(280)}tail suffix`;
  const output = snippet(text, matcher, 160);
  assert.match(output, /tail suffix/);
});

test("session_search enforces maxMessagesPerSession locally", async () => {
  const { tools, context } = await harness();
  const output = await tools.session_search.execute({ query: "payment", maxSessions: 1, maxMessagesPerSession: 1 }, context);
  assert.match(output, /1 matches/);
  assert.match(output, /1 message\(s\) scanned/);
  assert.doesNotMatch(output, /m-assistant/);
});

test("session_search reports only scanned sessions when the match cap stops early", async () => {
  const capMessages = Array.from({ length: 100 }, (_, index) => ({
    info: { id: `m-${index}`, sessionID: "s-new", role: "assistant", time: { created: 1_700_000_040_000 + index } },
    parts: [{ type: "text", text: `needle ${index}` }],
  }));
  const { tools, context } = await harness({
    client: {
      session: {
        async messages(input) {
          const id = input.path?.id ?? input.sessionID;
          return { data: id === "s-new" ? capMessages : [{ info: { id: "later", role: "assistant" }, parts: [{ type: "text", text: "needle later" }] }] };
        },
      },
    },
  });
  const output = await tools.session_search.execute({ query: "needle", maxSessions: 2, maxMessagesPerSession: 150 }, context);
  assert.match(output, /100 matches across 1 session\(s\) scanned \(2 candidate session\(s\)\), 100 message\(s\) scanned/);
  assert.match(output, /match cap reached/);
  assert.doesNotMatch(output, /later/);
});

test("v2 shape is supported for future SDK clients", async () => {
  const { tools, context, calls } = await harness({ __sessionToolsShape: "v2" });
  await tools.session_read.execute({ sessionId: "s-new", limit: 5 }, context);
  assert.deepEqual(calls[0], ["get", { sessionID: "s-new", directory: "/repo" }]);
  assert.deepEqual(calls[1], ["messages", { sessionID: "s-new", directory: "/repo", limit: 5 }]);
});

test("session API wrapper uses expected v1 and v2 shapes for every read method", async () => {
  const cases = [
    ["list", { directory: "/repo" }, { query: { directory: "/repo" } }, { directory: "/repo" }],
    ["get", { sessionId: "s-new", directory: "/repo" }, { path: { id: "s-new" }, query: { directory: "/repo" } }, { sessionID: "s-new", directory: "/repo" }],
    ["status", { directory: "/repo" }, { query: { directory: "/repo" } }, { directory: "/repo" }],
    ["children", { sessionId: "s-new", directory: "/repo" }, { path: { id: "s-new" }, query: { directory: "/repo" } }, { sessionID: "s-new", directory: "/repo" }],
    ["todo", { sessionId: "s-new", directory: "/repo" }, { path: { id: "s-new" }, query: { directory: "/repo" } }, { sessionID: "s-new", directory: "/repo" }],
    ["diff", { sessionId: "s-new", directory: "/repo", messageID: "m-user" }, { path: { id: "s-new" }, query: { directory: "/repo", messageID: "m-user" } }, { sessionID: "s-new", directory: "/repo", messageID: "m-user" }],
    ["messages", { sessionId: "s-new", directory: "/repo", limit: 7 }, { path: { id: "s-new" }, query: { directory: "/repo", limit: 7 } }, { sessionID: "s-new", directory: "/repo", limit: 7 }],
  ];

  for (const shape of ["v1", "v2"]) {
    for (const [method, args, v1Input, v2Input] of cases) {
      const pluginContext = fakePluginContext({ __sessionToolsShape: shape });
      const api = SessionsPlugin.__test.makeSessionApi(pluginContext);
      await api[method](args);
      assert.deepEqual(pluginContext.calls[0], [method, shape === "v2" ? v2Input : v1Input], `${shape} ${method}`);
    }
  }
});

test("session API wrapper forwards abort signals for every read method", async () => {
  const signal = new AbortController().signal;
  const cases = [
    ["list", { directory: "/repo" }, { query: { directory: "/repo" } }, { directory: "/repo" }],
    ["get", { sessionId: "s-new", directory: "/repo" }, { path: { id: "s-new" }, query: { directory: "/repo" } }, { sessionID: "s-new", directory: "/repo" }],
    ["status", { directory: "/repo" }, { query: { directory: "/repo" } }, { directory: "/repo" }],
    ["children", { sessionId: "s-new", directory: "/repo" }, { path: { id: "s-new" }, query: { directory: "/repo" } }, { sessionID: "s-new", directory: "/repo" }],
    ["todo", { sessionId: "s-new", directory: "/repo" }, { path: { id: "s-new" }, query: { directory: "/repo" } }, { sessionID: "s-new", directory: "/repo" }],
    ["diff", { sessionId: "s-new", directory: "/repo", messageID: "m-user" }, { path: { id: "s-new" }, query: { directory: "/repo", messageID: "m-user" } }, { sessionID: "s-new", directory: "/repo", messageID: "m-user" }],
    ["messages", { sessionId: "s-new", directory: "/repo", limit: 7 }, { path: { id: "s-new" }, query: { directory: "/repo", limit: 7 } }, { sessionID: "s-new", directory: "/repo", limit: 7 }],
  ];

  for (const shape of ["v1", "v2"]) {
    for (const [method, args, v1Input, v2Input] of cases) {
      const pluginContext = fakePluginContext({ __sessionToolsShape: shape });
      const api = SessionsPlugin.__test.makeSessionApi(pluginContext);
      await api[method]({ ...args, signal });
      assert.deepEqual(pluginContext.calls[0], [method, { ...(shape === "v2" ? v2Input : v1Input), signal }], `${shape} ${method}`);
    }
  }
});

test("tools forward ToolContext abort signals to session reads", async () => {
  const signal = new AbortController().signal;
  const { tools, context, calls } = await harness();
  await tools.session_read.execute({ sessionId: "s-new", limit: 2 }, { ...context, abort: signal });
  assert.equal(calls[0][1].signal, signal);
  assert.equal(calls[1][1].signal, signal);
});

test("malformed SDK responses remain bounded and do not crash tools", async () => {
  const { tools, context } = await harness({
    client: {
      session: {
        async list() { return { data: null }; },
        async status() { return { data: null }; },
        async children() { return { data: { unexpected: true } }; },
        async todo() { return { data: null }; },
        async diff() { return { data: { unexpected: true } }; },
      },
    },
  });
  assert.match(await tools.session_list.execute({}, context), /showing 0\/0/);
  const info = await tools.session_info.execute({ sessionId: "s-new", includeDiff: true }, context);
  assert.match(info, /status: unknown/);
  assert.match(info, /children: 0/);
  assert.match(info, /todos: 0/);
  assert.match(info, /diff: 0 files, \+0\/-0/);
});

test("unknown part types do not crash formatting", () => {
  const text = formatMessage({
    info: { id: "m", role: "assistant", time: { created: 1 }, mode: "build" },
    parts: [{ type: "mystery", value: "x" }],
  });
  assert.match(text, /\[mystery\]/);

  const metadata = formatMessage({
    info: { id: "m", role: "assistant", time: { created: 1 }, mode: "build" },
    parts: [{ type: "mystery", value: "password=partsecret12345" }],
  }, { includeMetadata: true });
  assert.match(metadata, /"value": "password=<redacted>"/);
  assert.doesNotMatch(metadata, /partsecret12345/);
});

test("pure helpers are importable directly from the core module (no opencode runtime)", () => {
  // clampInt bounds values and falls back on non-finite input.
  assert.equal(clampInt(5, 1, 0, 10), 5);
  assert.equal(clampInt(99, 1, 0, 10), 10);
  assert.equal(clampInt(undefined, 7, 0, 10), 7);
  assert.equal(clampInt("not-a-number", 7, 0, 10), 7);

  // redactText scrubs secrets.
  assert.match(redactText("API_KEY=supersecretvalue123"), /API_KEY=<redacted>/);
  assert.match(redactText('{"password":"supersecretvalue123"}'), /"password":"<redacted>"/);
  assert.equal(redactText(undefined), "");
  assert.deepEqual(redactValue({ nested: { password: "tiny" }, tokens: [{ accessToken: "secret" }] }), {
    nested: { password: "<redacted>" },
    tokens: "<redacted>",
  });
  assert.doesNotMatch(safeJson({ nested: { api_key: "json-secret-12345" } }), /json-secret-12345/);

  // compileMatcher builds case-insensitive and regex matchers, and rejects empty queries.
  const ci = compileMatcher("Payment", { caseSensitive: false });
  assert.equal(ci.test("the payment flow"), true);
  const re = compileMatcher("pay\\w+", { regex: true });
  assert.equal(re.test("PAYMENT"), true);
  assert.throws(() => compileMatcher("", {}), /non-empty query/);
  assert.throws(() => compileMatcher("(", { regex: true }), /Invalid session_search regex/);
  assert.throws(() => compileMatcher("(a+)+$", { regex: true }), /Unsafe session_search regex/);
  assert.throws(() => compileMatcher("((a+))+$", { regex: true }), /Unsafe session_search regex/);
  assert.throws(() => compileMatcher("(a|aa)+$", { regex: true }), /Unsafe session_search regex/);
  assert.throws(() => compileMatcher("a?a?a?a?a?a?a?a?aaaaaaaa", { regex: true }), /Unsafe session_search regex/);
  assert.throws(() => compileMatcher("a".repeat(MAX_LITERAL_QUERY_CHARS + 1)), /literal query is too long/);
  assert.equal(compileMatcher("(payment|checkout)+", { regex: true }).test("paymentcheckout"), true);
  assert.equal(compileMatcher("(?:payment|checkout)+", { regex: true }).test("paymentcheckout"), true);
  assert.equal(compileMatcher("(?:a|b){2,5}", { regex: true }).test("abba"), true);
  assert.equal(compileMatcher("(?<name>foo)+", { regex: true }).test("foofoo"), true);

  // formatSessionLine marks the current session and redacts/truncates the title.
  const line = formatSessionLine(
    { id: "s-new", title: "Newer session", directory: "/repo", time: { created: 1_700_000_020_000, updated: 1_700_000_030_000 } },
    0,
    "s-new",
  );
  assert.match(line, /1\. s-new \[current\]/);
  assert.match(line, /directory=\/repo/);

  // partText omits tool output unless explicitly requested.
  assert.match(partText({ type: "tool", tool: "bash", state: { status: "completed" } }), /output omitted/);
  assert.match(partText({ type: "text", text: "hello" }), /hello/);
});

test("missing SDK methods fail clearly", async () => {
  const { tools, context } = await harness({ client: { session: { list: undefined } } });
  await assert.rejects(() => tools.session_list.execute({}, context), /session API method is unavailable: list/);
});
