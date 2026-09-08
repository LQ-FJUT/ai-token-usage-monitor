import type { TokenUsage } from "../types.js";
import { normalizeProjectPath, rolloutKeyFromPath } from "./paths.js";
import { readCompleteFileLines, readCompleteLines } from "./stream.js";
import type {
  ParseRolloutOptions,
  ParsedRollout,
  RolloutAttribution,
  RolloutRateLimitCredits,
  RolloutRateLimitEvent,
  RolloutRateLimits,
  RolloutRateLimitWindow,
  RolloutSessionSummary,
  RolloutUsageEvent,
  RolloutWarning,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

interface ParserState {
  rolloutKey: string;
  session: RolloutSessionSummary;
  firstRecordSeen: boolean;
  historyOrdinal: number;
  owned: boolean;
  legacyCandidateContext: RolloutAttribution | null;
  context: RolloutAttribution;
  previousTotal: TokenUsage | null;
  lastFallbackPendingBaseline: boolean;
  usageEvents: RolloutUsageEvent[];
  rateLimitEvents: RolloutRateLimitEvent[];
  skippedEvents: number;
  parentHistoryEvents: number;
  warnings: RolloutWarning[];
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

const UNKNOWN_ATTRIBUTION: RolloutAttribution = {
  modelKey: "__unknown_model__",
  modelLabel: "Unknown model",
  projectKey: "__unknown_project__",
  projectLabel: "Unknown project",
  turnId: null,
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? Math.trunc(number) : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function pick(record: JsonRecord, snakeCase: string, camelCase: string): unknown {
  return record[snakeCase] ?? record[camelCase];
}

function readUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = nonNegativeInteger(pick(value, "input_tokens", "inputTokens"));
  const cachedInputTokens = nonNegativeInteger(
    pick(value, "cached_input_tokens", "cachedInputTokens"),
  );
  const outputTokens = nonNegativeInteger(pick(value, "output_tokens", "outputTokens"));
  const reasoningOutputTokens = nonNegativeInteger(
    pick(value, "reasoning_output_tokens", "reasoningOutputTokens"),
  );
  const suppliedTotal = nonNegativeInteger(pick(value, "total_tokens", "totalTokens"));

  if (
    inputTokens === null &&
    cachedInputTokens === null &&
    outputTokens === null &&
    reasoningOutputTokens === null &&
    suppliedTotal === null
  ) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    reasoningOutputTokens: reasoningOutputTokens ?? 0,
    totalTokens: suppliedTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function usageHasNegativeDelta(current: TokenUsage, previous: TokenUsage): boolean {
  return (
    current.inputTokens < previous.inputTokens ||
    current.cachedInputTokens < previous.cachedInputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningOutputTokens < previous.reasoningOutputTokens ||
    current.totalTokens < previous.totalTokens
  );
}

function subtractUsage(current: TokenUsage, previous: TokenUsage): TokenUsage {
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
    totalTokens: current.totalTokens - previous.totalTokens,
  };
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value}Z`
    : value;
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function sanitizeWindow(value: unknown): RolloutRateLimitWindow | null {
  if (!isRecord(value)) return null;
  return {
    usedPercent: finiteNumber(pick(value, "used_percent", "usedPercent")),
    windowDurationMins: finiteNumber(
      pick(value, "window_minutes", "windowDurationMins") ?? value.window_duration_mins,
    ),
    resetsAt: finiteNumber(pick(value, "resets_at", "resetsAt")),
  };
}

function sanitizeCredits(value: unknown): RolloutRateLimitCredits | null {
  if (!isRecord(value)) return null;
  const balance = value.balance;
  return {
    hasCredits: booleanValue(pick(value, "has_credits", "hasCredits")),
    unlimited: booleanValue(value.unlimited),
    balance:
      typeof balance === "string" || typeof balance === "number" ? String(balance) : null,
  };
}

function sanitizeRateLimits(value: unknown): RolloutRateLimits | null {
  if (!isRecord(value)) return null;
  return {
    primary: sanitizeWindow(value.primary),
    secondary: sanitizeWindow(value.secondary),
    credits: sanitizeCredits(value.credits),
    planType: stringValue(pick(value, "plan_type", "planType")),
    rateLimitReachedType: stringValue(
      pick(value, "rate_limit_reached_type", "rateLimitReachedType"),
    ),
  };
}

function isSubagentMeta(payload: JsonRecord): boolean {
  const source = payload.source;
  return (
    stringValue(payload.parent_thread_id) !== null ||
    stringValue(payload.forked_from_id) !== null ||
    (isRecord(source) && source.subagent !== undefined)
  );
}

function parseAttribution(payload: JsonRecord, fallback: RolloutAttribution): RolloutAttribution {
  const modelLabel = stringValue(payload.model) ?? fallback.modelLabel;
  const modelKey = modelLabel === "Unknown model" ? fallback.modelKey : modelLabel.toLowerCase();
  const project = normalizeProjectPath(payload.cwd);
  return {
    modelKey,
    modelLabel,
    projectKey: project.path === null ? fallback.projectKey : project.key,
    projectLabel: project.path === null ? fallback.projectLabel : project.label,
    turnId: stringValue(payload.turn_id) ?? fallback.turnId,
  };
}

function pushWarning(state: ParserState, code: RolloutWarning["code"], line: number | null): void {
  state.warnings.push({ code, line });
}

function eventId(state: ParserState, line: number, ordinal: number | null): string {
  return `${state.rolloutKey}:${ordinal === null ? `l${line}` : `o${ordinal}`}`;
}

function isOwnedRecord(state: ParserState, ordinal: number | null): boolean {
  if (state.session.ownershipMode === "all") return true;
  if (state.session.ownershipMode === "ordinal") {
    return ordinal !== null && ordinal > (state.session.subagentHistoryStartOrdinal ?? Infinity);
  }
  return state.owned;
}

function handleSessionMeta(state: ParserState, payload: JsonRecord, line: number): void {
  if (state.firstRecordSeen) return;
  const isSubagent = isSubagentMeta(payload);
  const boundary = nonNegativeInteger(payload.subagent_history_start_ordinal);

  state.session = {
    isSubagent,
    ownershipMode: !isSubagent ? "all" : boundary !== null ? "ordinal" : "unresolved",
    subagentHistoryStartOrdinal: boundary,
  };
  state.owned = !isSubagent;

  const project = normalizeProjectPath(payload.cwd);
  if (project.path !== null) {
    state.context = {
      ...state.context,
      projectKey: project.key,
      projectLabel: project.label,
    };
  }

  if (!isSubagent && boundary !== null) pushWarning(state, "invalid-session-meta", line);
}

function processTokenEvent(
  state: ParserState,
  payload: JsonRecord,
  timestamp: string | null,
  line: number,
  ordinal: number | null,
): void {
  const info = isRecord(payload.info) ? payload.info : null;
  const total = readUsage(info?.total_token_usage ?? info?.totalTokenUsage);
  const last = readUsage(info?.last_token_usage ?? info?.lastTokenUsage);
  const rateLimits = sanitizeRateLimits(payload.rate_limits ?? payload.rateLimits);

  if (!isOwnedRecord(state, ordinal)) {
    // Copied parent history is not billed to this rollout, but its latest
    // cumulative snapshot is the baseline for the first child-owned snapshot.
    if (total) {
      state.previousTotal = total;
      state.lastFallbackPendingBaseline = false;
    }
    state.parentHistoryEvents += 1;
    return;
  }

  if (rateLimits) {
    state.rateLimitEvents.push({
      id: `${eventId(state, line, ordinal)}:rate`,
      line,
      ordinal,
      timestamp,
      rateLimits,
    });
  }

  let usage: TokenUsage | null = null;
  let source: RolloutUsageEvent["source"] = "total-delta";

  if (total) {
    if (state.previousTotal) {
      if (usageHasNegativeDelta(total, state.previousTotal)) {
        usage = total;
        source = "total-segment-start";
        pushWarning(state, "cumulative-counter-reset", line);
      } else {
        usage = subtractUsage(total, state.previousTotal);
      }
    } else if (state.lastFallbackPendingBaseline) {
      // The earlier last_token_usage already represented this unknown prefix.
      // Establish the cumulative baseline without counting the same work twice.
      usage = { ...ZERO_USAGE };
    } else {
      usage = total;
      source = "total-segment-start";
    }
    state.previousTotal = total;
    state.lastFallbackPendingBaseline = false;
  } else if (last && state.previousTotal === null && !state.lastFallbackPendingBaseline) {
    usage = last;
    source = "last-fallback";
    state.lastFallbackPendingBaseline = true;
    pushWarning(state, "last-usage-fallback", line);
  } else if (last) {
    state.skippedEvents += 1;
    pushWarning(state, "last-usage-skipped", line);
    return;
  }

  if (!usage) {
    state.skippedEvents += 1;
    pushWarning(state, "invalid-token-count", line);
    return;
  }

  state.usageEvents.push({
    id: eventId(state, line, ordinal),
    line,
    ordinal,
    timestamp,
    usage,
    source,
    attribution: { ...state.context },
    rateLimits,
  });
}

function processLine(state: ParserState, text: string, line: number): void {
  const isFirstRecord = !state.firstRecordSeen;
  const ordinal = isFirstRecord ? null : state.historyOrdinal;

  try {
    if (text.trim() === "") {
      state.skippedEvents += 1;
      pushWarning(state, "invalid-json", line);
      if (isFirstRecord) {
        state.session = {
          isSubagent: true,
          ownershipMode: "unresolved",
          subagentHistoryStartOrdinal: null,
        };
        state.owned = false;
        pushWarning(state, "invalid-session-meta", line);
      }
      return;
    }

    let record: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new TypeError("not an object");
      record = parsed;
    } catch {
      state.skippedEvents += 1;
      pushWarning(state, "invalid-json", line);
      if (isFirstRecord) {
        state.session = {
          isSubagent: true,
          ownershipMode: "unresolved",
          subagentHistoryStartOrdinal: null,
        };
        state.owned = false;
        pushWarning(state, "invalid-session-meta", line);
      }
      return;
    }

    const type = stringValue(record.type);
    const payload = isRecord(record.payload) ? record.payload : null;
    const timestamp = canonicalTimestamp(record.timestamp);

    if (isFirstRecord && (type !== "session_meta" || !payload)) {
      state.session = {
        isSubagent: true,
        ownershipMode: "unresolved",
        subagentHistoryStartOrdinal: null,
      };
      state.owned = false;
      pushWarning(state, "invalid-session-meta", line);
    }

    if (type === "session_meta" && payload) {
      handleSessionMeta(state, payload, line);
    } else if (type === "turn_context" && payload) {
      const context = parseAttribution(payload, state.context);
      if (isOwnedRecord(state, ordinal)) state.context = context;
      else state.legacyCandidateContext = context;
    } else if (type === "inter_agent_communication_metadata" && payload) {
      if (
        state.session.isSubagent &&
        state.session.ownershipMode === "unresolved" &&
        payload.trigger_turn === true
      ) {
        state.session.ownershipMode = "legacy-marker";
        state.owned = true;
        if (state.legacyCandidateContext) state.context = state.legacyCandidateContext;
        state.lastFallbackPendingBaseline = false;
      }
    } else if (type === "event_msg" && payload && payload.type === "token_count") {
      processTokenEvent(state, payload, timestamp, line, ordinal);
    }
  } finally {
    // The persisted ordinal is positional. Even a corrupt complete record must
    // consume its slot or a later subagent_history_start_ordinal will shift.
    if (isFirstRecord) state.firstRecordSeen = true;
    else state.historyOrdinal += 1;
  }
}

function processOversizedLine(state: ParserState, line: number): void {
  const isFirstRecord = !state.firstRecordSeen;
  state.skippedEvents += 1;
  pushWarning(state, "invalid-json", line);
  if (isFirstRecord) {
    state.session = {
      isSubagent: true,
      ownershipMode: "unresolved",
      subagentHistoryStartOrdinal: null,
    };
    state.owned = false;
    pushWarning(state, "invalid-session-meta", line);
    state.firstRecordSeen = true;
  } else {
    state.historyOrdinal += 1;
  }
}

function makeState(rolloutKey: string): ParserState {
  return {
    rolloutKey,
    session: {
      isSubagent: false,
      ownershipMode: "all",
      subagentHistoryStartOrdinal: null,
    },
    firstRecordSeen: false,
    historyOrdinal: 0,
    owned: true,
    legacyCandidateContext: null,
    context: { ...UNKNOWN_ATTRIBUTION },
    previousTotal: null,
    lastFallbackPendingBaseline: false,
    usageEvents: [],
    rateLimitEvents: [],
    skippedEvents: 0,
    parentHistoryEvents: 0,
    warnings: [],
  };
}

function finalize(
  state: ParserState,
  completeLines: number,
  ignoredIncompleteTail: boolean,
): ParsedRollout {
  if (ignoredIncompleteTail) {
    state.skippedEvents += 1;
    pushWarning(state, "incomplete-tail", null);
  }
  if (state.parentHistoryEvents > 0) {
    pushWarning(state, "parent-history-filtered", null);
  }
  if (state.session.isSubagent && state.session.ownershipMode === "unresolved") {
    pushWarning(state, "legacy-subagent-boundary-missing", null);
  }

  return {
    rolloutKey: state.rolloutKey,
    session: state.session,
    usageEvents: state.usageEvents,
    rateLimitEvents: state.rateLimitEvents,
    completeLines,
    indexedEvents: state.usageEvents.length,
    skippedEvents: state.skippedEvents,
    filteredParentEvents: state.parentHistoryEvents,
    ignoredIncompleteTail,
    warnings: state.warnings,
  };
}

export async function parseRolloutChunks(
  chunks: AsyncIterable<Uint8Array | string>,
  options: ParseRolloutOptions & { rolloutKey: string },
): Promise<ParsedRollout> {
  const state = makeState(options.rolloutKey);
  const read = await readCompleteLines(
    chunks,
    ({ text, line, oversized }) =>
      oversized ? processOversizedLine(state, line) : processLine(state, text, line),
    options.maxLineCharacters,
  );
  return finalize(
    state,
    read.completeLines,
    read.ignoredIncompleteTail,
  );
}

export async function parseRolloutFile(
  filePath: string,
  options: ParseRolloutOptions = {},
): Promise<ParsedRollout> {
  const state = makeState(options.rolloutKey ?? rolloutKeyFromPath(filePath));
  const read = await readCompleteFileLines(
    filePath,
    ({ text, line, oversized }) =>
      oversized ? processOversizedLine(state, line) : processLine(state, text, line),
    options.maxLineCharacters,
  );
  return finalize(
    state,
    read.completeLines,
    read.ignoredIncompleteTail,
  );
}
