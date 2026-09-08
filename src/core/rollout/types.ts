import type { LocalUsageSummary, TokenUsage } from "../types.js";

export type RolloutWarningCode =
  | "incomplete-tail"
  | "invalid-json"
  | "invalid-session-meta"
  | "invalid-turn-context"
  | "invalid-token-count"
  | "legacy-subagent-boundary-missing"
  | "parent-history-filtered"
  | "last-usage-fallback"
  | "last-usage-skipped"
  | "cumulative-counter-reset"
  | "file-read-error";

export interface RolloutWarning {
  code: RolloutWarningCode;
  line: number | null;
}

export interface RolloutAttribution {
  modelKey: string;
  modelLabel: string;
  projectKey: string;
  projectLabel: string;
  turnId: string | null;
}

export interface RolloutRateLimitWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RolloutRateLimitCredits {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: string | null;
}

/**
 * A deliberately small allow-list. Raw rate-limit payloads are never returned,
 * so future server fields (including identifiers) cannot leak by accident.
 */
export interface RolloutRateLimits {
  primary: RolloutRateLimitWindow | null;
  secondary: RolloutRateLimitWindow | null;
  credits: RolloutRateLimitCredits | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface RolloutUsageEvent {
  /** Stable within a rollout: `<rollout-key>:o<ordinal>` or a line fallback. */
  id: string;
  line: number;
  ordinal: number | null;
  timestamp: string | null;
  usage: TokenUsage;
  source: "total-delta" | "total-segment-start" | "last-fallback";
  attribution: RolloutAttribution;
  rateLimits: RolloutRateLimits | null;
}

export interface RolloutRateLimitEvent {
  id: string;
  line: number;
  ordinal: number | null;
  timestamp: string | null;
  rateLimits: RolloutRateLimits;
}

export interface RolloutSessionSummary {
  isSubagent: boolean;
  ownershipMode: "all" | "ordinal" | "legacy-marker" | "unresolved";
  subagentHistoryStartOrdinal: number | null;
}

export interface ParsedRollout {
  rolloutKey: string;
  session: RolloutSessionSummary;
  usageEvents: RolloutUsageEvent[];
  rateLimitEvents: RolloutRateLimitEvent[];
  completeLines: number;
  indexedEvents: number;
  skippedEvents: number;
  filteredParentEvents: number;
  ignoredIncompleteTail: boolean;
  warnings: RolloutWarning[];
}

export interface ParseRolloutOptions {
  rolloutKey?: string;
  maxLineCharacters?: number;
}

export interface AggregateRolloutOptions {
  timeZone?: string;
  now?: Date;
}

export interface RolloutScanResult {
  codexHome: string;
  timeZone: string;
  summary: LocalUsageSummary;
  filesWithIncompleteTail: number;
  latestRateLimits: RolloutRateLimitEvent | null;
}

export interface SanitizedScanOutput {
  generatedAt: string;
  timeZone: string;
  sourceFiles: number;
  indexedEvents: number;
  skippedEvents: number;
  filteredParentEvents: number;
  filesWithIncompleteTail: number;
  total: TokenUsage;
  today: TokenUsage;
  warningCount: number;
  byModel?: Array<{ label: string; usage: TokenUsage }>;
  byProject?: Array<{ label: string; usage: TokenUsage }>;
}
