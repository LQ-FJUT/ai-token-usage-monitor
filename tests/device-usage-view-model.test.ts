import { describe, expect, it } from "vitest";

import { createMockDashboardSnapshot } from "../src/ui/mock-data.js";
import {
  aggregateCostRows,
  aggregateSelectedSources,
  attachCustomRanges,
  buildDailySourceTrend,
  buildFifteenDaySourceTrend,
  buildProjectCatalog,
  buildProjectDimensionRows,
  buildRollingHourlyBuckets,
  buildRollingHourlySourceTrend,
  buildSourceDimensionRows,
  buildUsageInsights,
  costDetailRows,
  toggleSourceSelection,
} from "../src/ui/device-usage-view-model.js";

describe("device usage view model", () => {
  it("toggles multiple AI sources independently and returns to all when cleared", () => {
    expect(toggleSourceSelection([], "codex")).toEqual(["codex"]);
    expect(toggleSourceSelection(["codex"], "claude-code")).toEqual(["codex", "claude-code"]);
    expect(toggleSourceSelection(["codex"], "codex")).toEqual([]);
  });

  it("uses one source at a time in single mode", () => {
    expect(toggleSourceSelection([], "codex", "single")).toEqual(["codex"]);
    expect(toggleSourceSelection(["codex"], "claude-code", "single")).toEqual(["claude-code"]);
    expect(toggleSourceSelection(["codex"], "codex", "single")).toEqual([]);
  });

  it("uses today-specific model details for the selected source", () => {
    const usage = createMockDashboardSnapshot("ready").deviceUsage!;
    const source = usage.sources.find((item) => item.id === "codex")!;
    expect(source.todayByModel).toHaveLength(1);
    expect(source.todayByModel[0].usage.totalTokens).toBe(source.today.totalTokens);
    expect(usage.todayByModel).not.toEqual(usage.byModel);
  });

  it("builds an honest custom range from date-scoped task details", () => {
    const snapshot = createMockDashboardSnapshot("ready");
    const sources = snapshot.deviceUsage!.sources;
    const usage = sources[0].today;
    const custom = attachCustomRanges(sources, [
      {
        date: "2026-08-30",
        lowCacheTasks: 0,
        tasks: [{ occurredAtMs: 1, source: "Codex", modelLabel: "gpt-custom", projectLabel: "项目 A", taskLabel: "任务", usage, cacheMetricsAvailable: true, cacheHitRate: 0.9, lowCacheHit: false, cost: { usd: 1.25, cny: 0, unpricedTokens: 0 } }],
      },
      {
        date: "2026-08-31",
        lowCacheTasks: 0,
        tasks: [{ occurredAtMs: 2, source: "Codex", modelLabel: "gpt-custom", projectLabel: "项目 B", taskLabel: "任务", usage, cacheMetricsAvailable: true, cacheHitRate: 0.9, lowCacheHit: false, cost: { usd: 1.25, cny: 0, unpricedTokens: 0 } }],
      },
    ]);
    const summary = aggregateSelectedSources(custom, ["codex"], "custom");

    expect(summary.usage.totalTokens).toBe(usage.totalTokens * 2);
    expect(summary.cost.usd).toBe(2.5);
    expect(summary.dailyUsage.map((item) => item.date)).toEqual(["2026-08-30", "2026-08-31"]);
    expect(summary.byModel[0].label).toBe("gpt-custom");
    expect(summary.byProject.map((item) => item.label)).toEqual(["项目 A", "项目 B"]);
  });

  it("builds fifteen continuous local dates with stable per-source colors and zero gaps", () => {
    const sources = structuredClone(createMockDashboardSnapshot("ready").deviceUsage!.sources);
    const now = new Date(2026, 7, 31, 23, 30).getTime();
    const codex = sources.find((source) => source.id === "codex")!;
    const claude = sources.find((source) => source.id === "claude-code")!;
    const template = codex.ranges!.last30Days.dailyUsage[0];
    codex.ranges!.last30Days.dailyUsage = [{ ...template, date: "2026-08-31", usage: { ...template.usage, totalTokens: 300 } }];
    claude.ranges!.last30Days.dailyUsage = [{ ...template, date: "2026-08-31", usage: { ...template.usage, totalTokens: 100 } }];
    for (const source of sources.filter((source) => source !== codex && source !== claude)) {
      source.ranges!.last30Days.dailyUsage = [];
    }
    const trend = buildFifteenDaySourceTrend(sources, now);
    expect(trend.buckets).toHaveLength(15);
    expect(trend.buckets[0].date).toBe("2026-08-17");
    expect(trend.buckets.at(-1)?.date).toBe("2026-08-31");
    expect(trend.buckets[0].tokens).toBe(0);
    expect(trend.legend.map((item) => item.sourceId)).toEqual(["codex", "claude-code"]);
    const latest = trend.buckets.at(-1)!;
    expect(latest.segments.filter((segment) => segment.tokens > 0).map((segment) => [segment.sourceId, segment.color])).toEqual([
      ["codex", "#7c6cff"],
      ["claude-code", "#3abfe9"],
    ]);
    expect(latest.segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(100);
  });

  it("keeps exactly 24 rolling hourly slots across midnight", () => {
    const usage = createMockDashboardSnapshot("ready").deviceUsage!;
    const now = new Date(2026, 8, 1, 0, 30).getTime();
    const current = new Date(now);
    current.setMinutes(0, 0, 0);
    const currentHour = current.getTime();
    const summary = aggregateSelectedSources(usage.sources, [], "last24Hours");
    summary.hourlyUsage = [{ ...summary.hourlyUsage![0], hourStartMs: currentHour - 23 * 3_600_000, usage: { ...summary.hourlyUsage![0].usage, totalTokens: 42 } }];
    const buckets = buildRollingHourlyBuckets(summary, now);
    expect(buckets).toHaveLength(24);
    expect(buckets[0]).toEqual({ hourStartMs: currentHour - 23 * 3_600_000, tokens: 42 });
    expect(new Date(buckets[0].hourStartMs).getDate()).not.toBe(new Date(now).getDate());
    expect(buckets.at(-1)?.hourStartMs).toBe(currentHour);
  });

  it("keeps per-source colors when hourly usage is merged", () => {
    const usage = structuredClone(createMockDashboardSnapshot("ready").deviceUsage!);
    const now = new Date(2026, 8, 1, 0, 30).getTime();
    const current = new Date(now);
    current.setMinutes(0, 0, 0);
    const hourStartMs = current.getTime();
    const codex = usage.sources.find((source) => source.id === "codex")!;
    const claude = usage.sources.find((source) => source.id === "claude-code")!;
    const codexRange = codex.ranges!.last24Hours!;
    const claudeRange = claude.ranges!.last24Hours!;
    const codexTemplate = codexRange.hourlyUsage![0]!;
    const claudeTemplate = claudeRange.hourlyUsage![0]!;
    codexRange.hourlyUsage = [{ ...codexTemplate, hourStartMs, usage: { ...codexTemplate.usage, totalTokens: 300 } }];
    claudeRange.hourlyUsage = [{ ...claudeTemplate, hourStartMs, usage: { ...claudeTemplate.usage, totalTokens: 100 } }];
    const latest = buildRollingHourlySourceTrend(usage.sources, ["codex", "claude-code"], now).at(-1)!;
    expect(latest.tokens).toBe(400);
    expect(latest.segments.filter((segment) => segment.tokens > 0).map((segment) => [segment.sourceId, segment.color, segment.share])).toEqual([
      ["codex", "#7c6cff", 75],
      ["claude-code", "#3abfe9", 25],
    ]);
  });

  it("keeps per-source colors in daily, model, and project token bars", () => {
    const sources = createMockDashboardSnapshot("ready").deviceUsage!.sources;
    const daily = buildDailySourceTrend(sources, ["codex", "claude-code"], "last7Days");
    expect(daily.at(-1)?.segments.filter((segment) => segment.tokens > 0).map((segment) => segment.color)).toEqual([
      "#7c6cff",
      "#3abfe9",
    ]);
    const models = buildSourceDimensionRows(sources, ["codex", "claude-code"], "total", "byModel");
    expect(models.map((row) => row.segments[0].sourceId)).toEqual(["codex", "claude-code"]);

    const catalog = buildProjectCatalog(sources);
    const codex = catalog.find((member) => member.sourceId === "codex")!;
    const claude = catalog.find((member) => member.sourceId === "claude-code")!;
    const merged = buildProjectDimensionRows(sources, ["codex", "claude-code"], "total", [{
      id: "same-project",
      displayName: codex.projectLabel,
      members: [codex, claude],
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe(codex.projectLabel);
    expect(merged[0].mergedMemberCount).toBe(2);
    expect(merged[0].segments.map((segment) => segment.sourceId)).toEqual(["codex", "claude-code"]);
    const expected = sources
      .filter((source) => source.id === "codex" || source.id === "claude-code")
      .reduce((sum, source) => sum + source.ranges!.total.usage.totalTokens, 0);
    expect(merged[0].usage.totalTokens).toBe(expected);
  });

  it("keeps a cross-source merge rule while showing only the selected source contribution", () => {
    const sources = createMockDashboardSnapshot("ready").deviceUsage!.sources;
    const catalog = buildProjectCatalog(sources);
    const members = catalog.filter((member) => member.sourceId === "codex" || member.sourceId === "claude-code");
    const rows = buildProjectDimensionRows(sources, ["codex"], "last7Days", [{
      id: "filtered-project",
      displayName: members[1].projectLabel,
      members,
    }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe(members[1].projectLabel);
    expect(rows[0].mergedMemberCount).toBe(2);
    expect(rows[0].segments.map((segment) => segment.sourceId)).toEqual(["codex"]);
  });

  it("keeps all six sources in the billing panel regardless of source selection", () => {
    const usage = createMockDashboardSnapshot("ready").deviceUsage!;
    const todayRows = costDetailRows(usage.sources, "today");
    const totalRows = costDetailRows(usage.sources, "total");
    expect(todayRows).toHaveLength(6);
    expect(totalRows).toHaveLength(6);
    expect(todayRows.map((row) => row.source.id)).toEqual(usage.sources.map((source) => source.id));
    expect(todayRows.find((row) => row.source.id === "codex")!.cost).toEqual(
      usage.sources.find((source) => source.id === "codex")!.todayCost,
    );
    expect(aggregateCostRows(todayRows).unpricedTokens).toBeGreaterThan(0);
  });

  it("compares recent and previous seven-day averages for a trend signal", () => {
    const summary = structuredClone(createMockDashboardSnapshot("ready").deviceUsage!.ranges!.last30Days);
    summary.dailyUsage = Array.from({ length: 14 }, (_, index) => ({
      ...summary.dailyUsage[index % summary.dailyUsage.length],
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      usage: { ...summary.dailyUsage[index % summary.dailyUsage.length].usage, totalTokens: index < 7 ? 100 : 200 },
    }));
    const insight = buildUsageInsights(summary);
    expect(insight.trend).toBe("up");
    expect(insight.changePercent).toBe(100);
    expect(insight.confidence).toBe("medium");
  });

  it("marks a latest-day spike only after a seven-day baseline exists", () => {
    const summary = structuredClone(createMockDashboardSnapshot("ready").deviceUsage!.ranges!.last30Days);
    summary.dailyUsage = Array.from({ length: 7 }, (_, index) => ({
      ...summary.dailyUsage[index % summary.dailyUsage.length],
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      usage: { ...summary.dailyUsage[index % summary.dailyUsage.length].usage, totalTokens: index === 6 ? 180 : 100 },
    }));
    expect(buildUsageInsights(summary).anomaly).toBe("spike");
    summary.dailyUsage = summary.dailyUsage.slice(0, 1);
    expect(buildUsageInsights(summary).anomaly).toBe("insufficient");
  });
});
