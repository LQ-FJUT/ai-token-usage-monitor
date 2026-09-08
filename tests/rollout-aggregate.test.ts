import { Readable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateParsedRollouts,
  scanCodexRollouts,
  toSanitizedScanOutput,
} from "../src/core/rollout/aggregate.js";
import { discoverCodexHome, normalizeProjectPath } from "../src/core/rollout/paths.js";
import { parseRolloutChunks } from "../src/core/rollout/parser.js";
import type { RolloutScanResult } from "../src/core/rollout/types.js";

const record = (timestamp: string, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp, type, payload });

const totalUsage = (total: number) => ({
  input_tokens: total,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: total,
});

async function fixture(
  rolloutKey: string,
  timestamp: string,
  cwd: string,
  model: string,
  total: number,
) {
  const text = [
    record(timestamp, "session_meta", { cwd }),
    record(timestamp, "turn_context", { cwd, model, turn_id: `${rolloutKey}-turn` }),
    record(timestamp, "event_msg", {
      type: "token_count",
      info: { total_token_usage: totalUsage(total) },
      rate_limits: {
        primary: { used_percent: 10, window_minutes: 300, resets_at: 123 },
        account_id: "must-never-survive",
      },
    }),
  ].join("\n");
  return parseRolloutChunks(Readable.from([`${text}\n`]), { rolloutKey });
}

describe("rollout aggregation", () => {
  it("groups UTC events in the caller timezone and canonicalizes Windows paths", async () => {
    const first = await fixture(
      "first",
      "2026-08-26T16:30:00Z",
      "\\\\?\\C:\\Work\\Foo\\..\\Project\\",
      "GPT-X",
      10,
    );
    const second = await fixture(
      "second",
      "2026-08-27T01:00:00Z",
      "c:/work/project",
      "gpt-x",
      5,
    );
    const summary = aggregateParsedRollouts([first, second], {
      timeZone: "Asia/Singapore",
      now: new Date("2026-08-27T12:00:00Z"),
    });

    expect(summary.total.totalTokens).toBe(15);
    expect(summary.today.totalTokens).toBe(15);
    expect(summary.byModel).toHaveLength(1);
    expect(summary.byProject).toHaveLength(1);
    expect(summary.byProject[0]?.label).toBe("Project");
    expect(JSON.stringify(first.rateLimitEvents)).not.toContain("account_id");
    expect(JSON.stringify(first.rateLimitEvents)).not.toContain("must-never-survive");
  });

  it("deduplicates by rollout and ordinal", async () => {
    const parsed = await fixture("same-rollout", "2026-08-27T00:00:00Z", "/repo", "m", 8);
    const summary = aggregateParsedRollouts([parsed, parsed], {
      timeZone: "UTC",
      now: new Date("2026-08-27T01:00:00Z"),
    });
    expect(summary.total.totalTokens).toBe(8);
    expect(summary.indexedEvents).toBe(1);
    expect(summary.skippedEvents).toBe(1);
  });

  it("builds a CLI-safe view without paths, rollout ids, turn ids, or raw quota payloads", async () => {
    const parsed = await fixture(
      "private-rollout-id",
      "2026-08-27T00:00:00Z",
      "C:\\Users\\Private Name\\Secret Repo",
      "safe-model-label",
      8,
    );
    const summary = aggregateParsedRollouts([parsed], {
      timeZone: "UTC",
      now: new Date("2026-08-27T01:00:00Z"),
    });
    const result: RolloutScanResult = {
      codexHome: "C:\\Users\\Private Name\\.codex",
      timeZone: "UTC",
      summary,
      filesWithIncompleteTail: 0,
      latestRateLimits: parsed.rateLimitEvents[0] ?? null,
    };
    const defaults = toSanitizedScanOutput(result);
    const detailed = toSanitizedScanOutput(result, {
      includeModels: true,
      includeProjects: true,
    });

    expect(JSON.stringify(defaults)).not.toMatch(/Private|private-rollout|turn|account/i);
    expect(defaults).not.toHaveProperty("byModel");
    expect(defaults).not.toHaveProperty("byProject");
    expect(detailed.byProject).toEqual([
      { label: "Secret Repo", usage: expect.objectContaining({ totalTokens: 8 }) },
    ]);
    expect(JSON.stringify(detailed)).not.toContain("Private Name");
  });

  it("limits scans to the newest rollout files", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "codex-rollout-latest-"));
    try {
      const oldDirectory = path.join(codexHome, "sessions", "2026", "08", "26");
      const newDirectory = path.join(codexHome, "sessions", "2026", "08", "27");
      await mkdir(oldDirectory, { recursive: true });
      await mkdir(newDirectory, { recursive: true });

      const rolloutText = (timestamp: string, total: number) =>
        `${[
          record(timestamp, "session_meta", { cwd: "/repo" }),
          record(timestamp, "turn_context", { cwd: "/repo", model: "m", turn_id: "t" }),
          record(timestamp, "event_msg", {
            type: "token_count",
            info: { total_token_usage: totalUsage(total) },
          }),
        ].join("\n")}\n`;

      await writeFile(
        path.join(
          oldDirectory,
          "rollout-2026-08-26T00-00-00-00000000-0000-0000-0000-000000000001.jsonl",
        ),
        rolloutText("2026-08-26T00:00:00Z", 2),
      );
      await writeFile(
        path.join(
          newDirectory,
          "rollout-2026-08-27T00-00-00-00000000-0000-0000-0000-000000000002.jsonl",
        ),
        rolloutText("2026-08-27T00:00:00Z", 7),
      );

      const result = await scanCodexRollouts({ codexHome, maxFiles: 1, timeZone: "UTC" });
      expect(result.summary.sourceFiles).toBe(1);
      expect(result.summary.total.totalTokens).toBe(7);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

describe("rollout paths", () => {
  it("honors CODEX_HOME and otherwise uses the supplied home directory", () => {
    expect(
      discoverCodexHome({
        env: { CODEX_HOME: "D:\\CodexData" },
        homeDirectory: "C:\\Ignored",
        currentDirectory: "C:\\Current",
      }),
    ).toBe(path.resolve("C:\\Current", "D:\\CodexData"));
    expect(
      discoverCodexHome({ env: {}, homeDirectory: "C:\\Users\\Tester" }),
    ).toBe(path.resolve("C:\\Users\\Tester", ".codex"));
  });

  it("normalizes extended Windows paths for stable grouping", () => {
    const first = normalizeProjectPath("\\\\?\\C:\\Work\\Foo\\..\\Project\\");
    const second = normalizeProjectPath("c:/work/project");
    expect(first.key).toBe(second.key);
    expect(first.label).toBe("Project");
  });
});
