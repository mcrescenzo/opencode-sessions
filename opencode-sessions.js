import { tool } from "@opencode-ai/plugin";
import {
  DEFAULT_PART_CHARS,
  MAX_PART_CHARS,
  DEFAULT_TOTAL_CHARS,
  MAX_TOTAL_CHARS,
  MAX_REGEX_PATTERN_CHARS,
  clampInt,
  redactText,
  truncate,
  totalCap,
  errorText,
  formatTime,
  formatSummary,
  sortSessions,
  sessionRecordID,
  formatSessionLine,
  statusForSession,
  compactStatus,
  todoSummary,
  summarizeDiffs,
  messageID,
  messageRole,
  messageCreated,
  partText,
  formatMessage,
  searchableText,
  compileMatcher,
  snippet,
  sessionTitle,
} from "./opencode-sessions-core.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 500;
const DEFAULT_SEARCH_SESSIONS = 25;
const MAX_SEARCH_SESSIONS = 100;
const DEFAULT_SEARCH_MESSAGES = 100;
const MAX_SEARCH_MESSAGES = 300;
function dataOrThrow(result, label) {
  if (result?.error) throw new Error(`${label} failed: ${boundedError(result.error)}`);
  return result?.data ?? result;
}

function boundedError(error) {
  return truncate(errorText(error), 500).replace(/\s+/g, " ").trim() || "unknown error";
}

async function safeApiCall(promise) {
  try {
    return await promise;
  } catch (error) {
    throw new Error(boundedError(error));
  }
}

function abortError(signal) {
  const detail = signal?.reason === undefined ? "" : `: ${boundedError(signal.reason)}`;
  return new Error(`operation aborted${detail}`);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

async function withAbort(signal, operation) {
  throwIfAborted(signal);
  if (!signal || typeof signal.addEventListener !== "function") return operation();
  let onAbort;
  const abortPromise = new Promise((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), abortPromise]);
  } finally {
    if (onAbort && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
  }
}

function isTranscriptDecodeError(error) {
  const text = errorText(error).toLowerCase();
  return /\b(decode|decoder|deseriali[sz]e|msgpack|messagepack|corrupt|unexpected token|unexpected end of json|unterminated|invalid message|invalid json|malformed json|json parse(?: error)?|failed to (?:decode|parse|deseriali[sz]e) (?:json|message|transcript|session)|parse (?:json|message|transcript|session)|malformed (?:json|message|transcript|session))\b/.test(text);
}

function sessionIdFor(session, fallback) {
  return sessionRecordID(session, fallback);
}

function noteList(items, formatter, limit = 5) {
  const shown = items.slice(0, limit).map(formatter).join("; ");
  const more = items.length > limit ? `; ...${items.length - limit} more` : "";
  return shown + more;
}

function sessionLabel(sessionId) {
  return truncate(String(sessionId ?? "<missing-id>"), 200).replace(/\s+/g, " ").trim();
}

function scopedDirectory(context) {
  return context.directory;
}

function validateSessionInScope(session, directory) {
  if (directory === undefined || directory === null) return session;
  if (!session || typeof session !== "object" || session.directory !== directory) {
    throw new Error("session scope validation failed: session directory mismatch");
  }
  return session;
}

function withSignal(input, signal) {
  return signal ? { ...input, signal } : input;
}

function sessionShape(pluginContext) {
  return pluginContext.__sessionToolsShape ?? pluginContext.client?.__sessionToolsShape ?? "v1";
}

function makeSessionApi(pluginContext) {
  const session = pluginContext.client?.session ?? {};
  const useV2 = sessionShape(pluginContext) === "v2";
  const requireMethod = (name) => {
    if (typeof session[name] !== "function") throw new Error(`OpenCode session API method is unavailable: ${name}`);
    return session[name].bind(session);
  };
  return {
    async list({ directory, signal }) {
      const fn = requireMethod("list");
      return dataOrThrow(await (useV2 ? fn(withSignal({ directory }, signal)) : fn(withSignal({ query: { directory } }, signal))), "session list");
    },
    async get({ sessionId, directory, signal }) {
      const fn = requireMethod("get");
      return dataOrThrow(await (useV2 ? fn(withSignal({ sessionID: sessionId, directory }, signal)) : fn(withSignal({ path: { id: sessionId }, query: { directory } }, signal))), "session get");
    },
    async status({ directory, signal }) {
      const fn = requireMethod("status");
      return dataOrThrow(await (useV2 ? fn(withSignal({ directory }, signal)) : fn(withSignal({ query: { directory } }, signal))), "session status");
    },
    async children({ sessionId, directory, signal }) {
      const fn = requireMethod("children");
      return dataOrThrow(await (useV2 ? fn(withSignal({ sessionID: sessionId, directory }, signal)) : fn(withSignal({ path: { id: sessionId }, query: { directory } }, signal))), "session children");
    },
    async todo({ sessionId, directory, signal }) {
      const fn = requireMethod("todo");
      return dataOrThrow(await (useV2 ? fn(withSignal({ sessionID: sessionId, directory }, signal)) : fn(withSignal({ path: { id: sessionId }, query: { directory } }, signal))), "session todo");
    },
    async diff({ sessionId, directory, messageID, signal }) {
      const fn = requireMethod("diff");
      return dataOrThrow(await (useV2
        ? fn(withSignal({ sessionID: sessionId, directory, messageID }, signal))
        : fn(withSignal({ path: { id: sessionId }, query: { directory, messageID } }, signal))), "session diff");
    },
    async messages({ sessionId, directory, limit, signal }) {
      const fn = requireMethod("messages");
      return dataOrThrow(await (useV2
        ? fn(withSignal({ sessionID: sessionId, directory, limit }, signal))
        : fn(withSignal({ path: { id: sessionId }, query: { directory, limit } }, signal))), "session messages");
    },
  };
}

async function listSessions(api, args, context) {
  const directory = scopedDirectory(context);
  const signal = context.abort;
  throwIfAborted(signal);
  const limit = clampInt(args.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const includeCurrent = args.includeCurrent !== false;
  const currentSessionId = context.sessionID ?? context.sessionId;
  const sessions = sortSessions(await safeApiCall(api.list({ directory, signal })), args.sort ?? "updated-desc")
    .filter((session) => includeCurrent || sessionRecordID(session) !== currentSessionId);
  const shown = sessions.slice(0, limit);
  const lines = [
    `Session list for ${directory ?? "<default>"}: showing ${shown.length}/${sessions.length} (sort=${args.sort ?? "updated-desc"})`,
    ...shown.map((session, index) => formatSessionLine(session, index, currentSessionId)),
  ];
  if (sessions.length > shown.length) lines.push(`…${sessions.length - shown.length} more sessions not shown; raise limit up to ${MAX_LIST_LIMIT}.`);
  return totalCap(lines.join("\n"), DEFAULT_TOTAL_CHARS);
}

async function sessionInfo(api, args, context) {
  const directory = scopedDirectory(context);
  const signal = context.abort;
  const sessionId = args.sessionId;
  const includeChildren = args.includeChildren !== false;
  const includeTodos = args.includeTodos !== false;
  const includeStatus = args.includeStatus !== false;
  const includeDiff = args.includeDiff === true;
  const session = validateSessionInScope(
    await withAbort(signal, () => safeApiCall(api.get({ sessionId, directory, signal }))),
    directory,
  );
  const [status, children, todos, diff] = await withAbort(signal, () => Promise.all([
    includeStatus ? api.status({ directory, signal }).catch((error) => ({ __error: boundedError(error) })) : undefined,
    includeChildren ? api.children({ sessionId, directory, signal }).catch((error) => ({ __error: boundedError(error) })) : undefined,
    includeTodos ? api.todo({ sessionId, directory, signal }).catch((error) => ({ __error: boundedError(error) })) : undefined,
    includeDiff ? api.diff({ sessionId, directory, signal }).catch((error) => ({ __error: boundedError(error) })) : undefined,
  ]));
  const lines = [
    `Session info: ${sessionTitle(session)}`,
    `id: ${session?.id ?? sessionId}`,
    `directory: ${session?.directory ?? directory ?? "unknown"}`,
    `parent: ${session?.parentID ?? "none"}`,
    `created: ${formatTime(session?.time?.created)}`,
    `updated: ${formatTime(session?.time?.updated)}`,
    `summary: ${formatSummary(session?.summary)}`,
  ];
  if (includeStatus) lines.push(`status: ${status?.__error ? `error: ${status.__error}` : compactStatus(statusForSession(status, sessionId))}`);
  if (includeChildren) lines.push(`children: ${children?.__error ? `error: ${children.__error}` : `${Array.isArray(children) ? children.length : 0}`}`);
  if (includeTodos) lines.push(`todos: ${todos?.__error ? `error: ${todos.__error}` : todoSummary(todos)}`);
  if (includeDiff) {
    const summary = summarizeDiffs(diff);
    lines.push(`diff: ${diff?.__error ? `error: ${diff.__error}` : `${summary.files} files, +${summary.additions}/-${summary.deletions}`}`);
  }
  return totalCap(lines.join("\n"), DEFAULT_TOTAL_CHARS);
}

async function readSession(api, args, context) {
  const directory = scopedDirectory(context);
  const signal = context.abort;
  throwIfAborted(signal);
  const sessionId = args.sessionId;
  const limit = clampInt(args.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT);
  const maxPartChars = clampInt(args.maxPartChars, DEFAULT_PART_CHARS, 500, MAX_PART_CHARS);
  const maxOutputChars = clampInt(args.maxOutputChars, DEFAULT_TOTAL_CHARS, 2_000, MAX_TOTAL_CHARS);
  const session = validateSessionInScope(
    await safeApiCall(api.get({ sessionId, directory, signal })),
    directory,
  );
  let messages = null;
  let messageReadError = null;
  try {
    messages = await api.messages({ sessionId, directory, limit, signal });
  } catch (e) {
    if (!isTranscriptDecodeError(e)) throw new Error(boundedError(e));
    messageReadError = boundedError(e);
  }
  if (messageReadError) {
    const header = "Transcript for " + sessionTitle(session) + " (" + sessionLabel(sessionId) + ") in " + (directory ?? "<default>") + ": --- DEGRADED READ: messages unavailable ---";
    return totalCap(header + "\n\nMessage decode/read-format error: " + messageReadError, maxOutputChars);
  }
  const entries = (Array.isArray(messages) ? messages : []).slice(0, limit);
  const chunks = [`Transcript for ${sessionTitle(session)} (${sessionLabel(sessionId)}) in ${directory ?? "<default>"}: ${entries.length} messages (limit=${limit})`];
  let usedChars = chunks[0].length;
  let stoppedEarly = false;
  for (const entry of entries) {
    const separatorChars = 2;
    if (usedChars + separatorChars >= maxOutputChars) {
      stoppedEarly = true;
      break;
    }
    const remaining = maxOutputChars - usedChars - separatorChars;
    const rendered = formatMessage(entry, {
      includeToolCalls: args.includeToolCalls === true,
      includeMetadata: args.includeMetadata === true,
      maxPartChars,
      maxMessageChars: remaining,
    });
    chunks.push(rendered);
    usedChars += separatorChars + rendered.length;
    if (usedChars >= maxOutputChars) {
      stoppedEarly = true;
      break;
    }
  }
  if (stoppedEarly) chunks.push("[session_read stopped before formatting remaining messages because maxOutputChars was reached]");
  return totalCap(chunks.join("\n\n"), maxOutputChars);
}

async function searchSessions(api, args, context) {
  const directory = scopedDirectory(context);
  const signal = context.abort;
  throwIfAborted(signal);
  const maxSessions = clampInt(args.maxSessions, DEFAULT_SEARCH_SESSIONS, 1, MAX_SEARCH_SESSIONS);
  const maxMessagesPerSession = clampInt(args.maxMessagesPerSession, DEFAULT_SEARCH_MESSAGES, 1, MAX_SEARCH_MESSAGES);
  const maxPartChars = clampInt(args.maxPartChars, DEFAULT_PART_CHARS, 500, MAX_PART_CHARS);
  const maxOutputChars = clampInt(args.maxOutputChars, DEFAULT_TOTAL_CHARS, 2_000, MAX_TOTAL_CHARS);
  let matcher;
  try {
    matcher = compileMatcher(args.query, { caseSensitive: args.caseSensitive === true, regex: args.regex === true });
  } catch (error) {
    return totalCap(`Session search error: ${boundedError(error)}`, maxOutputChars);
  }
  const sessions = args.sessionId
    ? [validateSessionInScope(await safeApiCall(api.get({ sessionId: args.sessionId, directory, signal })), directory)]
    : sortSessions(await safeApiCall(api.list({ directory, signal })), "updated-desc").slice(0, maxSessions);
  const matches = [];
  let searchedMessages = 0;
  let searchedSessions = 0;
  const decodeFailedSessions = [];
  const messageReadFailures = [];
  const malformedSessions = [];
  for (const session of sessions) {
    const sessionId = sessionIdFor(session, args.sessionId);
    if (signal?.aborted) break;
    if (!sessionId) {
      malformedSessions.push(boundedError(new Error("session record missing id")));
      continue;
    }
    let messages = [];
    try {
      messages = await api.messages({ sessionId, directory, limit: maxMessagesPerSession, signal });
      searchedSessions += 1;
    } catch (e) {
      if (isTranscriptDecodeError(e)) {
        decodeFailedSessions.push({ sessionId, error: boundedError(e) });
        continue;
      }
      if (args.sessionId) throw new Error(`session_search message read failed for ${sessionLabel(sessionId)}: ${boundedError(e)}`);
      messageReadFailures.push({ sessionId, error: boundedError(e) });
      continue;
    }
    for (const entry of (Array.isArray(messages) ? messages : []).slice(0, maxMessagesPerSession)) {
      searchedMessages += 1;
      const text = searchableText(entry, { includeToolCalls: args.includeToolCalls === true, maxPartChars });
      if (!matcher.test(text)) continue;
      matches.push({ session, sessionId, entry, snippet: snippet(text, matcher) });
      if (matches.length >= 100) break;
    }
    if (matches.length >= 100) break;
  }
  if (!args.sessionId && searchedSessions === 0 && messageReadFailures.length > 0) {
    throw new Error("session_search could not read any candidate sessions; non-decode message read failures: " + noteList(messageReadFailures, (failure) => `${sessionLabel(failure.sessionId)}: ${failure.error}`));
  }
  const renderedQuery = redactText(JSON.stringify(args.query));
  const lines = [
    `Session search for ${args.regex ? "regex" : "text"} ${renderedQuery} in ${directory ?? "<default>"}: ${matches.length} matches across ${searchedSessions} session(s) scanned${searchedSessions !== sessions.length ? ` (${sessions.length} candidate session(s))` : ""}, ${searchedMessages} message(s) scanned`,
    ...matches.map((match, index) => [
      `${index + 1}. ${sessionLabel(match.sessionId)} — ${sessionTitle(match.session)}`,
      `   message=${messageID(match.entry)} role=${messageRole(match.entry)} time=${formatTime(messageCreated(match.entry))}`,
      `   ${match.snippet}`,
    ].join("\n")),
  ];
  if (matches.length >= 100) lines.push("…match cap reached (100); narrow query or sessionId.");
  if (malformedSessions.length > 0) lines.push("Note: " + malformedSessions.length + " malformed session candidate(s) skipped: " + noteList(malformedSessions, (error) => error));
  if (decodeFailedSessions.length > 0) lines.push("Note: " + decodeFailedSessions.length + " session(s) skipped due to transcript decode/read-format errors: " + noteList(decodeFailedSessions, (failure) => `${sessionLabel(failure.sessionId)}: ${failure.error}`));
  if (messageReadFailures.length > 0) lines.push("Note: " + messageReadFailures.length + " session(s) had non-decode message read failures: " + noteList(messageReadFailures, (failure) => `${sessionLabel(failure.sessionId)}: ${failure.error}`));
  return totalCap(lines.join("\n"), maxOutputChars);
}

const s = tool.schema;

const SessionsPlugin = async (pluginContext) => {
  const api = makeSessionApi(pluginContext);
  return {
    config: async () => {},
    tool: {
      session_list: tool({
        description: "List local OpenCode sessions for the current project directory; caller-supplied directory is ignored. Read-only and output-bounded.",
        args: {
          directory: s.string().optional(),
          limit: s.number().int().positive().max(MAX_LIST_LIMIT).optional(),
          includeCurrent: s.boolean().optional(),
          sort: s.enum(["updated-desc", "created-desc"]).optional(),
        },
        async execute(args, context) { return listSessions(api, args, context); },
      }),
      session_info: tool({
        description: "Inspect one local OpenCode session in the current project directory. Read-only.",
        args: {
          sessionId: s.string().min(1),
          directory: s.string().optional(),
          includeChildren: s.boolean().optional(),
          includeTodos: s.boolean().optional(),
          includeStatus: s.boolean().optional(),
          includeDiff: s.boolean().optional(),
        },
        async execute(args, context) { return sessionInfo(api, args, context); },
      }),
      session_read: tool({
        description: "Read a bounded, redacted transcript for one local OpenCode session in the current project directory. Read-only.",
        args: {
          sessionId: s.string().min(1),
          directory: s.string().optional(),
          limit: s.number().int().positive().max(MAX_READ_LIMIT).optional(),
          includeToolCalls: s.boolean().optional(),
          includeMetadata: s.boolean().optional(),
          maxPartChars: s.number().int().positive().max(MAX_PART_CHARS).optional(),
          maxOutputChars: s.number().int().positive().max(MAX_TOTAL_CHARS).optional(),
        },
        async execute(args, context) { return readSession(api, args, context); },
      }),
      session_search: tool({
        description: "Search recent local OpenCode session transcripts in the current project directory with bounded, redacted snippets. Read-only.",
        args: {
          query: s.string().min(1),
          directory: s.string().optional(),
          sessionId: s.string().optional(),
          maxSessions: s.number().int().positive().max(MAX_SEARCH_SESSIONS).optional(),
          maxMessagesPerSession: s.number().int().positive().max(MAX_SEARCH_MESSAGES).optional(),
          caseSensitive: s.boolean().optional(),
          regex: s.boolean().optional(),
          includeToolCalls: s.boolean().optional(),
          maxPartChars: s.number().int().positive().max(MAX_PART_CHARS).optional(),
          maxOutputChars: s.number().int().positive().max(MAX_TOTAL_CHARS).optional(),
        },
        async execute(args, context) { return searchSessions(api, args, context); },
      }),
    },
  };
};

SessionsPlugin.__test = {
  clampInt,
  compileMatcher,
  formatMessage,
  formatSessionLine,
  makeSessionApi,
  MAX_REGEX_PATTERN_CHARS,
  partText,
  redactText,
  sessionInfo,
  listSessions,
  readSession,
  searchSessions,
  truncate,
};

export default SessionsPlugin;
