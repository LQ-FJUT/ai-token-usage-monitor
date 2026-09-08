import { scanCodexRollouts, toSanitizedScanOutput } from "../src/core/rollout/index.js";

interface CliOptions {
  codexHome?: string;
  timeZone?: string;
  maxFiles?: number;
  includeModels: boolean;
  includeProjects: boolean;
}

function parseArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = { includeModels: false, includeProjects: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--models") options.includeModels = true;
    else if (argument === "--projects") options.includeProjects = true;
    else if (argument === "--codex-home") options.codexHome = arguments_[++index];
    else if (argument === "--time-zone") options.timeZone = arguments_[++index];
    else if (argument === "--max-files") {
      const value = Number(arguments_[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid-arguments");
      options.maxFiles = value;
    }
    else throw new Error("invalid-arguments");
  }
  return options;
}

async function main(): Promise<void> {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await scanCodexRollouts({
      codexHome: options.codexHome,
      timeZone: options.timeZone,
      maxFiles: options.maxFiles,
    });
    const safeOutput = toSanitizedScanOutput(result, options);
    process.stdout.write(`${JSON.stringify(safeOutput, null, 2)}\n`);
  } catch {
    // Deliberately omit exception messages: filesystem errors commonly contain
    // usernames and full private paths.
    process.stderr.write('{"ok":false,"error":"scan-failed"}\n');
    process.exitCode = 1;
  }
}

void main();
