import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  AppServerError,
  CodexExecutableNotFoundError,
} from "./errors.js";

export type CodexExecutableSource = "explicit" | "path" | "local-app-data";

export interface LocatedCodexExecutable {
  executablePath: string;
  source: CodexExecutableSource;
}

export interface CodexLocatorFileSystem {
  isFile(filePath: string): Promise<boolean>;
  listDirectories(directoryPath: string): Promise<string[]>;
  modifiedTimeMs(filePath: string): Promise<number>;
}

export interface LocateCodexOptions {
  explicitPath?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fileSystem?: CodexLocatorFileSystem;
}

const defaultFileSystem: CodexLocatorFileSystem = {
  async isFile(filePath) {
    try {
      await access(filePath);
      return (await stat(filePath)).isFile();
    } catch {
      return false;
    }
  },
  async listDirectories(directoryPath) {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  async modifiedTimeMs(filePath) {
    try {
      return (await stat(filePath)).mtimeMs;
    } catch {
      return 0;
    }
  },
};

function pathImplementation(platform: NodeJS.Platform): typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["codex.exe"] : ["codex"];
}

function cleanPathEntry(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function findOnPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform,
  fileSystem: CodexLocatorFileSystem,
): Promise<string | null> {
  if (!pathValue) {
    return null;
  }

  const pathApi = pathImplementation(platform);
  const delimiter = platform === "win32" ? ";" : ":";
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = cleanPathEntry(rawDirectory);
    if (!directory) {
      continue;
    }

    for (const name of executableNames(platform)) {
      const candidate = pathApi.resolve(directory, name);
      if (await fileSystem.isFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

async function findInLocalAppData(
  localAppData: string | undefined,
  platform: NodeJS.Platform,
  fileSystem: CodexLocatorFileSystem,
): Promise<string | null> {
  if (platform !== "win32" || !localAppData) {
    return null;
  }

  const pathApi = path.win32;
  const binDirectory = pathApi.join(localAppData, "OpenAI", "Codex", "bin");
  const directCandidate = pathApi.join(binDirectory, "codex.exe");
  if (await fileSystem.isFile(directCandidate)) {
    return directCandidate;
  }

  const directories = await fileSystem.listDirectories(binDirectory);
  const candidates: Array<{ executablePath: string; modifiedTimeMs: number }> = [];
  for (const directory of directories) {
    // Desktop builds use a content hash here. Restricting the fallback to hash-like
    // folders avoids selecting unrelated executables someone placed under bin.
    if (!/^[a-f\d]{8,}$/i.test(directory)) {
      continue;
    }
    const executablePath = pathApi.join(binDirectory, directory, "codex.exe");
    if (await fileSystem.isFile(executablePath)) {
      candidates.push({
        executablePath,
        modifiedTimeMs: await fileSystem.modifiedTimeMs(executablePath),
      });
    }
  }

  candidates.sort(
    (left, right) =>
      right.modifiedTimeMs - left.modifiedTimeMs ||
      right.executablePath.localeCompare(left.executablePath),
  );
  return candidates[0]?.executablePath ?? null;
}

/**
 * Resolves the Codex executable without invoking a shell. An explicit path is
 * treated as a user override; automatic discovery prefers PATH and then the
 * Windows desktop app's versioned local bin directory.
 */
export async function locateCodexExecutable(
  options: LocateCodexOptions = {},
): Promise<LocatedCodexExecutable> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const pathApi = pathImplementation(platform);

  if (options.explicitPath) {
    const executablePath = pathApi.resolve(options.explicitPath);
    if (!(await fileSystem.isFile(executablePath))) {
      throw new AppServerError(
        "The configured Codex executable path does not point to a file.",
      );
    }
    return { executablePath, source: "explicit" };
  }

  const pathCandidate = await findOnPath(
    env.PATH ?? env.Path,
    platform,
    fileSystem,
  );
  if (pathCandidate) {
    return { executablePath: pathCandidate, source: "path" };
  }

  const localCandidate = await findInLocalAppData(
    env.LOCALAPPDATA,
    platform,
    fileSystem,
  );
  if (localCandidate) {
    return { executablePath: localCandidate, source: "local-app-data" };
  }

  throw new CodexExecutableNotFoundError();
}
