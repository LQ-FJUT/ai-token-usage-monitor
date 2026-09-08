import {
  AppServerClient,
  normalizeRateLimits,
} from "../src/core/app-server/index.js";

interface ReadAttempt<T> {
  available: boolean;
  value: T | null;
}

async function attempt<T>(read: () => Promise<T>): Promise<ReadAttempt<T>> {
  try {
    return { available: true, value: await read() };
  } catch {
    return { available: false, value: null };
  }
}

function explicitCodexPath(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--codex") {
      return args[index + 1];
    }
    if (args[index].startsWith("--codex=")) {
      return args[index].slice("--codex=".length);
    }
  }
  return undefined;
}

function versionFromUserAgent(userAgent: string): string | null {
  return userAgent.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0] ?? null;
}

async function main(): Promise<void> {
  let client: AppServerClient | null = null;
  try {
    client = await AppServerClient.connect({
      explicitPath: explicitCodexPath(process.argv.slice(2)),
    });

    const [account, rateLimits, usage] = await Promise.all([
      attempt(() => client!.accountRead(false)),
      attempt(() => client!.rateLimitsRead()),
      attempt(() => client!.usageRead()),
    ]);
    const windows = rateLimits.value
      ? normalizeRateLimits(rateLimits.value)
      : [];
    const summaryFields = usage.value?.summary
      ? Object.entries(usage.value.summary)
          .filter(([, value]) => value !== null)
          .map(([name]) => name)
      : [];

    // Deliberately emit shape/compatibility facts only. Never serialize the
    // account object, quota percentages, credit balances, reset timestamps, or
    // usage totals from this diagnostic probe.
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          appServer: {
            executableSource: client.executableSource,
            codexVersion: versionFromUserAgent(client.serverUserAgent),
          },
          account: {
            readAvailable: account.available,
            accountPresent: account.value?.account != null,
            requiresOpenaiAuth: account.value?.requiresOpenaiAuth ?? null,
          },
          rateLimits: {
            readAvailable: rateLimits.available,
            bucketCount: new Set(windows.map((window) => window.limitId)).size,
            windows: windows.map((window) => ({
              lane: window.lane,
              windowDurationMins: window.windowDurationMins,
              label: window.label,
            })),
            resetCreditMetadataPresent:
              rateLimits.value?.rateLimitResetCredits != null,
          },
          usage: {
            readAvailable: usage.available,
            summaryFields,
            dailyBucketCount: usage.value?.dailyUsageBuckets?.length ?? null,
            threadUsageMetadataPresent: usage.value?.threadUsage != null,
          },
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    // Error messages can contain local paths or server stderr. Keep CLI output
    // useful without leaking those details into pasted diagnostics.
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          errorKind:
            error instanceof Error ? error.constructor.name : "UnknownError",
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

await main();
