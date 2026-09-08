import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseRolloutChunks } from "../src/core/rollout/parser.js";

const line = (type: string, payload: Record<string, unknown>, timestamp = "2026-08-27T00:00:00Z") =>
  JSON.stringify({ timestamp, type, payload });

const usage = (total: number, input = total, output = 0) => ({
  input_tokens: input,
  cached_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: total,
});

async function parseFixture(
  records: string[],
  finalNewline = true,
  rolloutKey = "fixture",
  maxLineCharacters?: number,
) {
  const text = `${records.join("\n")}${finalNewline ? "\n" : ""}`;
  return parseRolloutChunks(Readable.from([text]), { rolloutKey, maxLineCharacters });
}

describe("rollout ownership and privacy", () => {
  it("uses the new subagent ordinal boundary and never retains conversation text", async () => {
    const parsed = await parseFixture([
      line("session_meta", {
        parent_thread_id: "parent-id",
        subagent_history_start_ordinal: 3,
        cwd: "C:\\Work\\Parent",
      }),
      line("session_meta", { cwd: "C:\\Work\\Parent" }),
      line("turn_context", { model: "parent-model", cwd: "C:\\Work\\Parent", turn_id: "p" }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(480) } }),
      // ordinal === boundary: baseline only, never child-owned usage.
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(500) } }),
      line("turn_context", { model: "child-model", cwd: "C:\\Work\\Child", turn_id: "c" }),
      line("response_item", { type: "message", role: "user", content: "TOP SECRET PROMPT" }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(510, 508, 2) } }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(515, 511, 4) } }),
    ]);

    expect(parsed.session.ownershipMode).toBe("ordinal");
    expect(parsed.usageEvents.map((event) => event.usage.totalTokens)).toEqual([10, 5]);
    expect(parsed.usageEvents[0]?.attribution).toMatchObject({
      modelLabel: "child-model",
      projectLabel: "Child",
      turnId: "c",
    });
    expect(parsed.usageEvents[0]?.id).toBe("fixture:o6");
    expect(parsed.warnings.map((warning) => warning.code)).not.toContain(
      "cumulative-counter-reset",
    );
    expect(JSON.stringify(parsed)).not.toContain("TOP SECRET PROMPT");
    expect(parsed.warnings.map((warning) => warning.code)).toContain("parent-history-filtered");
    expect(parsed.filteredParentEvents).toBe(2);
    expect(parsed.skippedEvents).toBe(0);
  });

  it("uses the legacy trigger marker conservatively and skips unresolved children", async () => {
    const owned = await parseFixture([
      line("session_meta", { parent_thread_id: "parent-id", cwd: "C:\\Repo" }),
      line("turn_context", { model: "legacy-model", cwd: "C:\\Repo", turn_id: "legacy" }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(900) } }),
      line("inter_agent_communication_metadata", { trigger_turn: true }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(907) } }),
    ]);
    expect(owned.session.ownershipMode).toBe("legacy-marker");
    expect(owned.usageEvents).toHaveLength(1);
    expect(owned.usageEvents[0]?.usage.totalTokens).toBe(7);
    expect(owned.usageEvents[0]?.attribution.modelLabel).toBe("legacy-model");
    expect(owned.warnings.map((warning) => warning.code)).not.toContain(
      "cumulative-counter-reset",
    );
    expect(owned.filteredParentEvents).toBe(1);

    const unresolved = await parseFixture([
      line("session_meta", { parent_thread_id: "parent-id" }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(100) } }),
    ]);
    expect(unresolved.usageEvents).toHaveLength(0);
    expect(unresolved.warnings.map((warning) => warning.code)).toContain(
      "legacy-subagent-boundary-missing",
    );
    expect(unresolved.filteredParentEvents).toBe(1);
  });
});

describe("rollout counters and streaming", () => {
  it("differences cumulative totals and opens a new segment after a reset", async () => {
    const parsed = await parseFixture([
      line("session_meta", { cwd: "/repo" }),
      line("turn_context", { model: "model-a", cwd: "/repo", turn_id: "turn-a" }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(10) } }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(15) } }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(4) } }),
    ]);
    expect(parsed.usageEvents.map((event) => event.usage.totalTokens)).toEqual([10, 5, 4]);
    expect(parsed.warnings.map((warning) => warning.code)).toContain("cumulative-counter-reset");
  });

  it("uses last_token_usage once without a baseline and does not sum repeated snapshots", async () => {
    const parsed = await parseFixture([
      line("session_meta", {}),
      line("event_msg", { type: "token_count", info: { last_token_usage: usage(3) } }),
      line("event_msg", { type: "token_count", info: { last_token_usage: usage(4) } }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(10) } }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(12) } }),
    ]);
    expect(parsed.usageEvents.map((event) => event.usage.totalTokens)).toEqual([3, 0, 2]);
    expect(parsed.usageEvents[0]?.source).toBe("last-fallback");
    expect(parsed.skippedEvents).toBe(1);
  });

  it("ignores a valid-looking but unterminated final line", async () => {
    const parsed = await parseFixture(
      [
        line("session_meta", {}),
        line("event_msg", { type: "token_count", info: { total_token_usage: usage(9) } }),
      ],
      false,
    );
    expect(parsed.usageEvents).toHaveLength(0);
    expect(parsed.ignoredIncompleteTail).toBe(true);
    expect(parsed.warnings.map((warning) => warning.code)).toContain("incomplete-tail");
  });

  it("keeps ordinal alignment across a damaged complete history record", async () => {
    const parsed = await parseFixture([
      line("session_meta", {
        parent_thread_id: "parent-id",
        subagent_history_start_ordinal: 1,
      }),
      "{damaged-history-record}",
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(500) } }),
      line("turn_context", { model: "owned", cwd: "/owned", turn_id: "owned" }),
      line("event_msg", { type: "token_count", info: { total_token_usage: usage(506) } }),
    ]);

    expect(parsed.usageEvents).toHaveLength(1);
    expect(parsed.usageEvents[0]?.usage.totalTokens).toBe(6);
    expect(parsed.usageEvents[0]?.ordinal).toBe(3);
  });

  it("counts an oversized complete line in the ownership ordinal exactly once", async () => {
    const oversizedHistory = JSON.stringify({
      timestamp: "2026-08-27T00:00:00Z",
      type: "response_item",
      payload: { type: "message", content: "x".repeat(2_000) },
    });
    const parsed = await parseFixture(
      [
        line("session_meta", {
          parent_thread_id: "parent-id",
          subagent_history_start_ordinal: 1,
        }),
        oversizedHistory,
        line("event_msg", { type: "token_count", info: { total_token_usage: usage(100) } }),
        line("turn_context", { model: "owned", cwd: "/owned", turn_id: "owned" }),
        line("event_msg", { type: "token_count", info: { total_token_usage: usage(106) } }),
      ],
      true,
      "oversized",
      400,
    );

    expect(parsed.usageEvents).toHaveLength(1);
    expect(parsed.usageEvents[0]).toMatchObject({ ordinal: 3, usage: { totalTokens: 6 } });
    expect(parsed.warnings.filter((warning) => warning.code === "invalid-json")).toHaveLength(1);
  });
});
