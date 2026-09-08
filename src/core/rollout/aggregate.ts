import type { LocalUsageSummary, TokenUsage, UsageDimension } from "../types.js";
import { discoverCodexHome, listRolloutFiles } from "./paths.js";
import { parseRolloutFile } from "./parser.js";
import type {
  AggregateRolloutOptions,
  ParsedRollout,
  RolloutRateLimitEvent,
  RolloutScanResult,
  RolloutWarningCode,
  SanitizedScanOutput,
} from "./types.js";

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

function addUsage(target: TokenUsage, addition: TokenUsage): void {
  target.inputTokens += addition.inputTokens;
  target.cachedInputTokens += addition.cachedInputTokens;
  target.outputTokens += addition.outputTokens;
  target.reasoningOutputTokens += addition.reasoningOutputTokens;
  target.totalTokens += addition.totalTokens;
}

function timeZoneDateKey(timestamp: string | Date, timeZone: string): string | null {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function validateTimeZone(timeZone: string): string {
  // Constructing the formatter is the portable way to validate an IANA zone.
  new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  return timeZone;
}

function sortedDimensions(
  dimensions: Map<string, { label: string; usage: TokenUsage }>,
): UsageDimension[] {
  return [...dimensions.entries()]
    .map(([key, value]) => ({ key, label: value.label, usage: value.usage }))
    .sort(
      (left, right) =>
        right.usage.totalTokens - left.usage.totalTokens || left.label.localeCompare(right.label),
    );
}

function warningMessages(counts: Map<RolloutWarningCode, number>): string[] {
  const describe: Record<RolloutWarningCode, (count: number) => string> = {
    "incomplete-tail": (count) =>
      `有 ${count} 个活动日志末行尚未写完，已延后到下次扫描。`,
    "invalid-json": (count) => `有 ${count} 条完整日志记录无法解析，已安全跳过。`,
    "invalid-session-meta": (count) =>
      `有 ${count} 个日志缺少有效的会话元数据，相关用量已保守处理。`,
    "invalid-turn-context": (count) =>
      `有 ${count} 条任务上下文无法归属，相关用量已归入未知项。`,
    "invalid-token-count": (count) => `有 ${count} 条 Token 记录不完整，已安全跳过。`,
    "legacy-subagent-boundary-missing": (count) =>
      `有 ${count} 个旧版子代理日志缺少可靠边界，不确定用量未计入总量。`,
    "parent-history-filtered": (count) =>
      `已在 ${count} 个子代理日志中识别并排除复制的父历史。`,
    "last-usage-fallback": (count) =>
      `有 ${count} 个日志段仅能使用单次 Token 快照，结果按保守方式估算。`,
    "last-usage-skipped": (count) =>
      `有 ${count} 条重复的单次 Token 快照未计入总量。`,
    "cumulative-counter-reset": (count) =>
      `检测到 ${count} 次累计计数器重置，已从新分段继续统计。`,
    "file-read-error": (count) => `有 ${count} 个日志文件暂时无法读取。`,
  };
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => describe[code](count));
}

export function aggregateParsedRollouts(
  parsedRollouts: ParsedRollout[],
  options: AggregateRolloutOptions = {},
): LocalUsageSummary {
  const now = options.now ?? new Date();
  const timeZone = validateTimeZone(
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const todayKey = timeZoneDateKey(now, timeZone);
  const total = { ...ZERO_USAGE };
  const today = { ...ZERO_USAGE };
  const byModel = new Map<string, { label: string; usage: TokenUsage }>();
  const byProject = new Map<string, { label: string; usage: TokenUsage }>();
  const warningCounts = new Map<RolloutWarningCode, number>();
  const seenEventIds = new Set<string>();
  let skippedEvents = 0;
  let filteredParentEvents = 0;

  for (const parsed of parsedRollouts) {
    skippedEvents += parsed.skippedEvents;
    filteredParentEvents += parsed.filteredParentEvents;
    for (const warning of parsed.warnings) {
      warningCounts.set(warning.code, (warningCounts.get(warning.code) ?? 0) + 1);
    }

    for (const event of parsed.usageEvents) {
      if (seenEventIds.has(event.id)) {
        skippedEvents += 1;
        continue;
      }
      seenEventIds.add(event.id);
      addUsage(total, event.usage);
      if (event.timestamp && timeZoneDateKey(event.timestamp, timeZone) === todayKey) {
        addUsage(today, event.usage);
      }

      const model = byModel.get(event.attribution.modelKey) ?? {
        label: event.attribution.modelLabel,
        usage: { ...ZERO_USAGE },
      };
      addUsage(model.usage, event.usage);
      byModel.set(event.attribution.modelKey, model);

      const project = byProject.get(event.attribution.projectKey) ?? {
        label: event.attribution.projectLabel,
        usage: { ...ZERO_USAGE },
      };
      addUsage(project.usage, event.usage);
      byProject.set(event.attribution.projectKey, project);
    }
  }

  return {
    generatedAt: now.toISOString(),
    sourceFiles: parsedRollouts.length,
    indexedEvents: seenEventIds.size,
    skippedEvents,
    filteredParentEvents,
    total,
    today,
    byModel: sortedDimensions(byModel),
    byProject: sortedDimensions(byProject),
    warnings: warningMessages(warningCounts),
  };
}

function laterRateLimits(
  current: RolloutRateLimitEvent | null,
  candidate: RolloutRateLimitEvent,
): RolloutRateLimitEvent {
  if (!current) return candidate;
  const currentTime = current.timestamp ? Date.parse(current.timestamp) : -Infinity;
  const candidateTime = candidate.timestamp ? Date.parse(candidate.timestamp) : -Infinity;
  return candidateTime >= currentTime ? candidate : current;
}

export async function scanCodexRollouts(
  options: AggregateRolloutOptions & { codexHome?: string; maxFiles?: number } = {},
): Promise<RolloutScanResult> {
  const codexHome = options.codexHome ?? discoverCodexHome();
  const timeZone = validateTimeZone(
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const discoveredFiles = await listRolloutFiles(codexHome);
  const maxFiles =
    options.maxFiles === undefined
      ? discoveredFiles.length
      : Math.max(0, Math.trunc(options.maxFiles));
  const files =
    maxFiles === 0
      ? []
      : discoveredFiles.slice(Math.max(0, discoveredFiles.length - maxFiles));
  const parsedRollouts: ParsedRollout[] = [];
  let filesWithIncompleteTail = 0;
  let latestRateLimits: RolloutRateLimitEvent | null = null;
  let readErrors = 0;

  for (const file of files) {
    try {
      const parsed = await parseRolloutFile(file);
      parsedRollouts.push(parsed);
      if (parsed.ignoredIncompleteTail) filesWithIncompleteTail += 1;
      for (const rateLimitEvent of parsed.rateLimitEvents) {
        latestRateLimits = laterRateLimits(latestRateLimits, rateLimitEvent);
      }
    } catch {
      readErrors += 1;
    }
  }

  const summary = aggregateParsedRollouts(parsedRollouts, {
    timeZone,
    now: options.now,
  });
  if (readErrors > 0) {
    summary.skippedEvents += readErrors;
    summary.warnings.push(`有 ${readErrors} 个日志文件暂时无法读取。`);
  }

  return {
    codexHome,
    timeZone,
    summary,
    filesWithIncompleteTail,
    latestRateLimits,
  };
}

function mergeLeafDimensions(dimensions: UsageDimension[]): Array<{ label: string; usage: TokenUsage }> {
  const merged = new Map<string, { label: string; usage: TokenUsage }>();
  for (const dimension of dimensions) {
    const key = dimension.label.toLocaleLowerCase("en-US");
    const entry = merged.get(key) ?? { label: dimension.label, usage: { ...ZERO_USAGE } };
    addUsage(entry.usage, dimension.usage);
    merged.set(key, entry);
  }
  return [...merged.values()].sort(
    (left, right) =>
      right.usage.totalTokens - left.usage.totalTokens || left.label.localeCompare(right.label),
  );
}

/** Creates the only shape the CLI is allowed to print. */
export function toSanitizedScanOutput(
  result: RolloutScanResult,
  options: { includeModels?: boolean; includeProjects?: boolean } = {},
): SanitizedScanOutput {
  const output: SanitizedScanOutput = {
    generatedAt: result.summary.generatedAt,
    timeZone: result.timeZone,
    sourceFiles: result.summary.sourceFiles,
    indexedEvents: result.summary.indexedEvents,
    skippedEvents: result.summary.skippedEvents,
    filteredParentEvents: result.summary.filteredParentEvents,
    filesWithIncompleteTail: result.filesWithIncompleteTail,
    total: result.summary.total,
    today: result.summary.today,
    warningCount: result.summary.warnings.length,
  };

  if (options.includeModels) {
    output.byModel = result.summary.byModel.map(({ label, usage }) => ({ label, usage }));
  }
  if (options.includeProjects) {
    output.byProject = mergeLeafDimensions(result.summary.byProject);
  }
  return output;
}
