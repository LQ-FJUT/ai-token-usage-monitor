const compactNumber = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const exactNumber = new Intl.NumberFormat("zh-CN");

const shortDate = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
});

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export type QuotaAvailabilityTone = "normal" | "warning" | "critical";

export interface QuotaPresentation {
  usedPercent: number;
  remainingPercent: number;
  tone: QuotaAvailabilityTone;
}

/**
 * Converts a server quota into the availability-first view used by the UI.
 * Warnings are based on what remains, not on the historical amount consumed.
 */
export function getQuotaPresentation(quota: {
  usedPercent: number;
  remainingPercent: number;
}): QuotaPresentation {
  const usedPercent = clampPercent(quota.usedPercent);
  const remainingPercent = Number.isFinite(quota.remainingPercent)
    ? clampPercent(quota.remainingPercent)
    : 100 - usedPercent;
  const tone = remainingPercent <= 10
    ? "critical"
    : remainingPercent <= 25
      ? "warning"
      : "normal";

  return { usedPercent, remainingPercent, tone };
}

export function formatPercent(value: number): string {
  const safeValue = clampPercent(value);
  return `${safeValue.toFixed(safeValue % 1 === 0 ? 0 : 1)}%`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 10_000) return exactNumber.format(value);
  return compactNumber.format(value);
}

export function formatExactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "未提供";
  return `${exactNumber.format(value)} Token`;
}

/** Uses only 万/亿 for compact chart tooltips, with exact small values. */
export function formatChineseCompactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "未提供";
  const absolute = Math.abs(value);
  if (absolute < 10_000) return String(Math.round(value));
  if (absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  const tenThousands = Number((value / 10_000).toFixed(2));
  if (Math.abs(tenThousands) >= 10_000) {
    return `${(value / 100_000_000).toFixed(2)}亿`;
  }
  return `${tenThousands.toFixed(2)}万`;
}

export function formatRefreshCountdown(
  nextRefreshAtMs: number | null | undefined,
  isRefreshing: boolean,
  nowMs: number,
): string {
  if (isRefreshing) return "正在更新";
  if (nextRefreshAtMs === null || nextRefreshAtMs === undefined || !Number.isFinite(nextRefreshAtMs)) {
    return "等待首次更新";
  }
  const remainingSeconds = Math.ceil((nextRefreshAtMs - nowMs) / 1_000);
  return remainingSeconds <= 0 ? "即将更新" : `约 ${remainingSeconds} 秒后自动更新`;
}

export function formatWindowDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "未知周期";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${Math.round(minutes)} 分钟`;
}

export function toEpochMilliseconds(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

export function formatCountdown(target: number, now: number): string {
  const targetMilliseconds = toEpochMilliseconds(target);
  if (targetMilliseconds === null) return "等待服务端提供";

  const difference = targetMilliseconds - now;
  if (difference <= 0) return "即将更新";

  const totalMinutes = Math.ceil(difference / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days} 天 ${hours} 小时后`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分后`;
  return `${minutes} 分后`;
}

export function formatRelativeTime(value: string | null, now: number): string {
  if (!value) return "尚未更新";
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return "更新时间未知";

  const elapsed = Math.max(0, now - parsed);
  if (elapsed < 15_000) return "刚刚更新";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)} 秒前更新`;
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前更新`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前更新`;
  return `${dateTime.format(new Date(parsed))} 更新`;
}

export function isSnapshotStale(value: string | null, now: number): boolean {
  if (!value) return false;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) && now - parsed > 5 * 60_000;
}

export function formatBucketDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : shortDate.format(parsed);
}

export function formatDateTime(value: string | number | null): string {
  if (value === null) return "未提供";
  const parsed = typeof value === "number" ? toEpochMilliseconds(value) : new Date(value).getTime();
  if (parsed === null || !Number.isFinite(parsed)) return "未提供";
  return dateTime.format(new Date(parsed));
}

export function formatDurationSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 60) return `${Math.round(value)} 秒`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}
