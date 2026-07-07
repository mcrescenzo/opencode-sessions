// Pure helpers for the opencode-sessions plugin.
//
// This module imports no opencode plugin runtime (the entry file owns that
// dependency). It holds only side-effect-free logic — formatting, redaction,
// clamping, and matching — so it can be unit-tested without the opencode
// runtime. The entry file (opencode-sessions.js) imports from here and wires
// these helpers into the plugin's tools.

export const DEFAULT_PART_CHARS = 4_000;
export const MAX_PART_CHARS = 12_000;
export const DEFAULT_TOTAL_CHARS = 30_000;
export const MAX_TOTAL_CHARS = 80_000;
export const MAX_LITERAL_QUERY_CHARS = 1_000;
export const MAX_REGEX_PATTERN_CHARS = 300;

const REDACTED = "<redacted>";
const SENSITIVE_KEY_PATTERN = String.raw`(?:[A-Za-z_][A-Za-z0-9_-]*)?(?:api[_-]?key|token|secret|password|passwd|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token)[A-Za-z0-9_-]*`;

const SENSITIVE_KEY_FRAGMENTS = [
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "authtoken",
  "accesstoken",
  "refreshtoken",
];

export const SECRET_PATTERNS = [
  {
    re: new RegExp(`\\b(${SENSITIVE_KEY_PATTERN})\\b\\s*[:=]\\s*(["'])(?:\\\\.|(?!\\2).){8,}\\2`, "gi"),
    replace: (_match, key, quote) => `${key}=${quote}${REDACTED}${quote}`,
  },
  {
    re: new RegExp(`([?&#;])(${SENSITIVE_KEY_PATTERN})=([^&#\\s"',;]{8,})`, "gi"),
    replace: (_match, prefix, key) => `${prefix}${key}=${REDACTED}`,
  },
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^@\s/?#]+):([^@\s/?#]{8,})@/gi,
    replace: (_match, scheme, user) => `${scheme}${user}:${REDACTED}@`,
  },
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: "-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----",
  },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: "Bearer <redacted>" },
  { re: /\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, replace: "Basic <redacted>" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, replace: "github_pat_<redacted>" },
  {
    re: /\b(sk|pk|gh[pousr]|xox[baprs])([_-])[-_A-Za-z0-9]{12,}\b/g,
    replace: (_match, prefix, separator) => `${prefix}${separator}<redacted>`,
  },
  {
    re: new RegExp(`\\b(${SENSITIVE_KEY_PATTERN})\\b\\s*[:=]\\s*[^\\s"'\\),;&?#<>]{8,}`, "gi"),
    replace: (_match, key) => `${key}=<redacted>`,
  },
  {
    re: /(["'])(api[_-]?key|token|secret|password|passwd|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token)\1(\s*:\s*)(["'])(?:\\.|(?!\4).){8,}\4/gi,
    replace: (_match, keyQuote, key, separator, valueQuote) => `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`,
  },
];

function normalizedKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key) {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function redactText(value) {
  if (value === undefined || value === null) return "";
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern.re, pattern.replace);
  return text;
}

export function sanitizeOutput(value) {
  return redactText(value)
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
}

export function redactValue(value, seen = new WeakSet(), key = "") {
  if (key && isSensitiveKey(key)) return REDACTED;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return redactText(String(value));
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Date) {
    seen.delete(value);
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return items;
  }
  const output = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = redactValue(entryValue, seen, entryKey);
  }
  seen.delete(value);
  return output;
}

export function truncate(text, maxChars = DEFAULT_PART_CHARS) {
  const clean = sanitizeOutput(text);
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars))}\n…[truncated ${clean.length - maxChars} chars]`;
}

function inlineText(value, fallback = "unknown", maxChars = DEFAULT_PART_CHARS) {
  const text = value === undefined || value === null || value === "" ? fallback : value;
  return truncate(String(text), maxChars).replace(/\s+/g, " ").trim();
}

export function safeJson(value, maxChars = DEFAULT_PART_CHARS) {
  try {
    return truncate(JSON.stringify(redactValue(value), null, 2), maxChars);
  } catch {
    return truncate(String(value), maxChars);
  }
}

export function totalCap(text, maxChars = DEFAULT_TOTAL_CHARS) {
  const clean = sanitizeOutput(text);
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}\n…[output truncated ${clean.length - maxChars} chars]`;
}

export function errorText(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") {
    const text = redactText(error);
    return text.trim() ? text : "unknown error";
  }
  if (typeof error.message === "string") {
    const text = redactText(error.message);
    if (text.trim()) return text;
  }
  if (typeof error.data?.message === "string") {
    const text = redactText(error.data.message);
    if (text.trim()) return text;
  }
  const text = safeJson(error, 2_000);
  return text.trim() && text !== "{}" ? text : "unknown error";
}

export function timeMs(value) {
  if (!Number.isFinite(value)) return undefined;
  return value < 100_000_000_000 ? value * 1000 : value;
}

export function formatTime(value) {
  const ms = timeMs(value);
  if (ms === undefined) return "unknown";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

export function sessionUpdated(session) {
  return timeMs(session?.time?.updated) ?? 0;
}

export function sessionCreated(session) {
  return timeMs(session?.time?.created) ?? 0;
}

export function summarizeDiffs(diffs) {
  const list = Array.isArray(diffs) ? diffs : [];
  const additions = list.reduce((sum, diff) => sum + (Number(diff?.additions) || 0), 0);
  const deletions = list.reduce((sum, diff) => sum + (Number(diff?.deletions) || 0), 0);
  return { files: list.length, additions, deletions };
}

export function formatSummary(summary) {
  if (!summary) return "none";
  const files = Number(summary.files ?? summary.diffs?.length ?? 0) || 0;
  const additions = Number(summary.additions ?? 0) || 0;
  const deletions = Number(summary.deletions ?? 0) || 0;
  return `${files} files, +${additions}/-${deletions}`;
}

export function sortSessions(sessions, sort) {
  const copy = [...(Array.isArray(sessions) ? sessions : [])];
  if (sort === "created-desc") return copy.sort((a, b) => sessionCreated(b) - sessionCreated(a));
  return copy.sort((a, b) => sessionUpdated(b) - sessionUpdated(a));
}

export function sessionRecordID(session, fallback) {
  for (const value of [session?.id, session?.sessionID, session?.sessionId, fallback]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function formatSessionLine(session, index, currentSessionID) {
  const rawId = sessionRecordID(session);
  const id = inlineText(rawId, "<missing-id>", 200);
  const marker = rawId === currentSessionID ? " [current]" : "";
  const parent = session?.parentID ? ` parent=${inlineText(session.parentID, "unknown", 200)}` : "";
  return [
    `${index + 1}. ${id}${marker} — ${truncate(session?.title || "Untitled", 160)}`,
    `   updated=${formatTime(session?.time?.updated)} created=${formatTime(session?.time?.created)}${parent}`,
    `   directory=${inlineText(session?.directory, "unknown", 500)}; summary=${formatSummary(session?.summary)}`,
  ].join("\n");
}

export function statusForSession(statusData, sessionId) {
  if (!statusData || typeof statusData !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(statusData, sessionId)) return statusData[sessionId];
  return Object.values(statusData).find((value) => value?.sessionID === sessionId || value?.sessionId === sessionId || value?.id === sessionId || value?.session?.id === sessionId);
}

export function compactStatus(status) {
  if (!status) return "unknown";
  if (typeof status === "string") return inlineText(status, "unknown", 500);
  if (typeof status.type === "string") return inlineText(status.type, "unknown", 500);
  if (typeof status.status === "string") return inlineText(status.status, "unknown", 500);
  if (typeof status.status?.type === "string") return inlineText(status.status.type, "unknown", 500);
  return safeJson(status, 1_000).replace(/\n/g, " ");
}

export function todoSummary(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const counts = new Map();
  for (const todo of list) {
    const status = inlineText(todo?.status, "unknown", 120);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const suffix = [...counts.entries()].map(([status, count]) => `${status}:${count}`).join(", ");
  return `${list.length}${suffix ? ` (${suffix})` : ""}`;
}

export function messageID(entry) {
  return inlineText(entry?.info?.id ?? entry?.id ?? entry?.parts?.[0]?.messageID, "<unknown-message>", 200);
}

export function messageRole(entry) {
  return inlineText(entry?.info?.role ?? entry?.role, "unknown", 80);
}

export function messageCreated(entry) {
  return entry?.info?.time?.created ?? entry?.time?.created;
}

export function messageAgent(entry) {
  const agent = entry?.info?.agent ?? entry?.info?.mode ?? entry?.agent ?? entry?.mode;
  return agent === undefined || agent === null || agent === "" ? undefined : inlineText(agent, "unknown", 120);
}

export function messageModel(entry) {
  const info = entry?.info ?? entry;
  if (info?.model?.providerID && info?.model?.modelID) return `${inlineText(info.model.providerID, "unknown", 120)}/${inlineText(info.model.modelID, "unknown", 120)}`;
  if (info?.providerID && info?.modelID) return `${inlineText(info.providerID, "unknown", 120)}/${inlineText(info.modelID, "unknown", 120)}`;
  return undefined;
}

export function toolStateSummary(state) {
  if (!state) return "unknown";
  const status = inlineText(state.status, "unknown", 120);
  const title = state.title ? ` ${inlineText(state.title, "unknown", 500)}` : "";
  return `${status}${title}`;
}

function sourceLabel(source, maxPartChars) {
  if (!source || typeof source !== "object") return "";
  const value = source.path ?? source.uri ?? source.clientName;
  return value ? ` source=${inlineText(value, "unknown", Math.min(maxPartChars, 1_000))}` : "";
}

export function partText(part, options = {}) {
  const includeToolCalls = Boolean(options.includeToolCalls);
  const includeMetadata = Boolean(options.includeMetadata);
  const maxPartChars = options.maxPartChars ?? DEFAULT_PART_CHARS;
  if (!part || typeof part !== "object") return "[unknown part]";
  if (part.type === "text") return truncate(part.text ?? "", maxPartChars);
  if (part.type === "tool") {
    const header = `[tool ${inlineText(part.tool, "unknown", 120)} ${toolStateSummary(part.state)}]`;
    if (!includeToolCalls) return `${header} output omitted; pass includeToolCalls:true to include bounded tool I/O.`;
    const state = part.state ?? {};
    const chunks = [header];
    if (state.input !== undefined) chunks.push(`input: ${safeJson(state.input, Math.min(maxPartChars, 2_000))}`);
    if (state.output !== undefined) chunks.push(`output: ${truncate(state.output, maxPartChars)}`);
    if (state.error !== undefined) chunks.push(`error: ${truncate(state.error, maxPartChars)}`);
    return chunks.join("\n");
  }
  if (part.type === "reasoning") return "[reasoning omitted]";
  if (part.type === "file") return `[file ${inlineText(part.filename ?? part.url, "unknown", Math.min(maxPartChars, 1_000))}${sourceLabel(part.source, maxPartChars)}]`;
  if (part.type === "patch") return `[patch ${Array.isArray(part.files) ? part.files.map((file) => inlineText(file, "unknown", Math.min(maxPartChars, 1_000))).join(", ") : "unknown files"}]`;
  if (part.type === "agent") return `[agent ${inlineText(part.name, "unknown", 120)}]`;
  if (part.type === "subtask") return `[subtask ${inlineText(part.agent, "agent", 120)}] ${truncate(part.description ?? part.prompt ?? "", maxPartChars)}`;
  if (part.type === "step-start") return "[step-start]";
  if (part.type === "step-finish") return `[step-finish ${inlineText(part.reason, "unknown", 120)}]`;
  if (part.type === "snapshot") return `[snapshot ${inlineText(part.snapshot, "", Math.min(maxPartChars, 1_000))}]`;
  if (part.type === "retry") return `[retry ${part.attempt ?? "?"}] ${truncate(errorText(part.error), maxPartChars)}`;
  if (part.type === "compaction") return `[compaction auto=${part.auto === true}]`;
  if (includeMetadata) return `[${inlineText(part.type, "unknown", 120)}] ${safeJson(part, maxPartChars)}`;
  return `[${inlineText(part.type, "unknown", 120)}]`;
}

export function formatMessage(entry, options = {}) {
  const header = [
    `--- ${messageRole(entry)} ${messageID(entry)} @ ${formatTime(messageCreated(entry))}`,
    messageAgent(entry) ? `agent=${messageAgent(entry)}` : undefined,
    messageModel(entry) ? `model=${messageModel(entry)}` : undefined,
  ].filter(Boolean).join(" ");
  const parts = Array.isArray(entry?.parts) ? entry.parts : [];
  const maxPartChars = options.maxPartChars ?? DEFAULT_PART_CHARS;
  const meta = options.includeMetadata ? `\nmetadata: ${safeJson(entry?.info ?? {}, 2_000)}` : "";
  const maxMessageChars = Number.isFinite(options.maxMessageChars) ? Math.max(0, options.maxMessageChars) : Infinity;
  const bodyChunks = [];
  let usedChars = header.length + meta.length + 1;
  let stoppedEarly = false;
  const addChunk = (getText) => {
    if (usedChars >= maxMessageChars) return false;
    const text = getText();
    if (!text) return true;
    const separatorChars = bodyChunks.length > 0 ? 2 : 0;
    if (usedChars + separatorChars >= maxMessageChars) return false;
    bodyChunks.push(text);
    usedChars += separatorChars + text.length;
    return usedChars < maxMessageChars;
  };

  if (!addChunk(() => messageErrorText(entry, maxPartChars))) stoppedEarly = true;
  if (!stoppedEarly) {
    for (const part of parts) {
      if (!addChunk(() => partText(part, options))) {
        stoppedEarly = true;
        break;
      }
    }
  }
  if (stoppedEarly && bodyChunks.length > 0) bodyChunks.push("[message output truncated before remaining parts]");
  const body = bodyChunks.filter(Boolean).join("\n\n") || "[no parts]";
  return `${header}${meta}\n${body}`;
}

export function searchableText(entry, options = {}) {
  const parts = Array.isArray(entry?.parts) ? entry.parts : [];
  const maxPartChars = options.maxPartChars ?? MAX_PART_CHARS;
  return [
    messageErrorText(entry, maxPartChars),
    ...parts.map((part) => partText(part, { ...options, maxPartChars })),
  ].filter(Boolean).join("\n");
}

function messageErrorText(entry, maxPartChars = DEFAULT_PART_CHARS) {
  return entry?.info?.error ? `[message error] ${truncate(errorText(entry.info.error), maxPartChars)}` : "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileMatcher(query, { caseSensitive = false, regex = false } = {}) {
  if (!query) throw new Error("session_search requires a non-empty query");
  if (regex) {
    if (query.length > MAX_REGEX_PATTERN_CHARS) throw new Error(`session_search regex is too long (${query.length}/${MAX_REGEX_PATTERN_CHARS} chars)`);
    if (hasUnsafeRegexShape(query)) throw new Error("Unsafe session_search regex rejected: nested quantified groups can cause excessive backtracking");
    const flags = caseSensitive ? "" : "i";
    let re;
    try {
      re = new RegExp(query, flags);
    } catch (error) {
      throw new Error(`Invalid session_search regex: ${errorText(error)}`);
    }
    return {
      test: (text) => re.test(text),
      index: (text) => { const m = re.exec(text); return m ? m.index : -1; },
      matchEnd: (text) => { const m = re.exec(text); return m ? m.index + m[0].length : -1; },
    };
  }
  if (query.length > MAX_LITERAL_QUERY_CHARS) throw new Error(`session_search literal query is too long (${query.length}/${MAX_LITERAL_QUERY_CHARS} chars)`);
  const re = new RegExp(escapeRegExp(query), caseSensitive ? "" : "i");
  return {
    test: (text) => re.test(text),
    index: (text) => { const m = re.exec(text); return m ? m.index : -1; },
    matchEnd: (text) => { const m = re.exec(text); return m ? m.index + m[0].length : -1; },
  };
}

function hasUnsafeRegexShape(query) {
  const source = String(query);
  return hasOptionalAtomChain(source) || quantifiedGroups(source).some((body) => hasNestedQuantifier(body) || hasAmbiguousAlternation(body));
}

function hasOptionalAtomChain(source) {
  let escaped = false;
  let inClass = false;
  let optionalAtoms = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      optionalAtoms = 0;
      continue;
    }
    if (char === "?" && i > 0 && source[i - 1] !== "(") {
      optionalAtoms += 1;
      if (optionalAtoms >= 8) return true;
      continue;
    }
    if (!/^[A-Za-z0-9_.-]$/.test(char)) optionalAtoms = 0;
  }
  return false;
}

function quantifiedGroups(source) {
  const groups = [];
  const stack = [];
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "(") {
      stack.push(i);
      continue;
    }
    if (char !== ")" || stack.length === 0) continue;
    const start = stack.pop();
    if (hasFollowingQuantifier(source, i + 1)) groups.push(source.slice(start + 1, i));
  }
  return groups;
}

function hasFollowingQuantifier(source, index) {
  const char = source[index];
  if (char === "+" || char === "*" || char === "?") return true;
  return /^\{\d+(?:,\d*)?\}/.test(source.slice(index));
}

function hasNestedQuantifier(body) {
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "+" || char === "*") return true;
    if (char === "?" && i > 0 && body[i - 1] !== "(") return true;
    if (char === "{" && /^\{\d+(?:,\d*)?\}/.test(body.slice(i))) return true;
  }
  return false;
}

function hasAmbiguousAlternation(body) {
  const alternatives = splitAlternatives(stripGroupPrefix(body));
  if (alternatives.length < 2) return false;
  const prefixes = alternatives.map((alternative) => literalPrefix(alternative)).filter(Boolean);
  for (let i = 0; i < prefixes.length; i += 1) {
    for (let j = i + 1; j < prefixes.length; j += 1) {
      if (prefixes[i].startsWith(prefixes[j]) || prefixes[j].startsWith(prefixes[i])) return true;
    }
  }
  return alternatives.some((alternative) => alternative === "");
}

function stripGroupPrefix(body) {
  if (body.startsWith("?:")) return body.slice(2);
  if (/^\?[imsuv-]+:/.test(body)) return body.slice(body.indexOf(":") + 1);
  return body;
}

function splitAlternatives(body) {
  const alternatives = [];
  let current = "";
  let depth = 0;
  let escaped = false;
  let inClass = false;
  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (inClass) {
      current += char;
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      current += char;
      inClass = true;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")" && depth > 0) depth -= 1;
    if (char === "|" && depth === 0) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  alternatives.push(current);
  return alternatives;
}

function literalPrefix(alternative) {
  let prefix = "";
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < alternative.length; i += 1) {
    const char = alternative[i];
    if (escaped) {
      if (/^[A-Za-z0-9_-]$/.test(char)) prefix += `\\${char}`;
      break;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      if (prefix) break;
      inClass = true;
      continue;
    }
    if (/^[A-Za-z0-9_-]$/.test(char)) {
      prefix += char;
      continue;
    }
    break;
  }
  return prefix;
}

export function snippet(text, matcher, radius = 160) {
  const index = matcher.index(text);
  if (index < 0) return truncate(text, radius * 2);
  const start = Math.max(0, index - radius);
  const matchEnd = typeof matcher.matchEnd === "function" ? matcher.matchEnd(text) : index;
  const end = Math.min(text.length, Math.max(index, matchEnd) + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${truncate(text.slice(start, end), Math.max(radius * 2, end - start))}${suffix}`.replace(/\s+/g, " ").trim();
}

export function sessionTitle(session) {
  return truncate(session?.title || "Untitled", 120);
}
