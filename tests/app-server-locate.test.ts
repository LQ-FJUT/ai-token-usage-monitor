import { describe, expect, it } from "vitest";

import {
  AppServerError,
  CodexExecutableNotFoundError,
  locateCodexExecutable,
  type CodexLocatorFileSystem,
} from "../src/core/app-server/index.js";

function fakeFileSystem(options: {
  files?: string[];
  directories?: Record<string, string[]>;
  modifiedTimes?: Record<string, number>;
}): CodexLocatorFileSystem {
  const normalize = (value: string) => value.toLowerCase();
  const files = new Set((options.files ?? []).map(normalize));
  const directories = new Map(
    Object.entries(options.directories ?? {}).map(([key, value]) => [
      normalize(key),
      value,
    ]),
  );
  const modifiedTimes = new Map(
    Object.entries(options.modifiedTimes ?? {}).map(([key, value]) => [
      normalize(key),
      value,
    ]),
  );
  return {
    async isFile(filePath) {
      return files.has(normalize(filePath));
    },
    async listDirectories(directoryPath) {
      return directories.get(normalize(directoryPath)) ?? [];
    },
    async modifiedTimeMs(filePath) {
      return modifiedTimes.get(normalize(filePath)) ?? 0;
    },
  };
}

describe("locateCodexExecutable", () => {
  it("uses a valid explicit path as a deliberate override", async () => {
    const fileSystem = fakeFileSystem({
      files: ["D:\\Portable\\codex.exe", "C:\\Tools\\codex.exe"],
    });

    await expect(
      locateCodexExecutable({
        explicitPath: "D:\\Portable\\codex.exe",
        platform: "win32",
        env: { PATH: "C:\\Tools" },
        fileSystem,
      }),
    ).resolves.toEqual({
      executablePath: "D:\\Portable\\codex.exe",
      source: "explicit",
    });
  });

  it("prefers PATH during automatic Windows discovery", async () => {
    const fileSystem = fakeFileSystem({
      files: [
        "C:\\Tools\\codex.exe",
        "C:\\Local\\OpenAI\\Codex\\bin\\aaaaaaaa\\codex.exe",
      ],
      directories: {
        "C:\\Local\\OpenAI\\Codex\\bin": ["aaaaaaaa"],
      },
    });

    await expect(
      locateCodexExecutable({
        platform: "win32",
        env: { PATH: '"C:\\Tools"', LOCALAPPDATA: "C:\\Local" },
        fileSystem,
      }),
    ).resolves.toEqual({
      executablePath: "C:\\Tools\\codex.exe",
      source: "path",
    });
  });

  it("falls back to the newest hashed Codex Desktop bin", async () => {
    const oldPath =
      "C:\\Local\\OpenAI\\Codex\\bin\\aaaaaaaa\\codex.exe";
    const newPath =
      "C:\\Local\\OpenAI\\Codex\\bin\\bbbbbbbb\\codex.exe";
    const fileSystem = fakeFileSystem({
      files: [oldPath, newPath],
      directories: {
        "C:\\Local\\OpenAI\\Codex\\bin": [
          "not-a-hash",
          "aaaaaaaa",
          "bbbbbbbb",
        ],
      },
      modifiedTimes: { [oldPath]: 10, [newPath]: 20 },
    });

    await expect(
      locateCodexExecutable({
        platform: "win32",
        env: { PATH: "C:\\Missing", LOCALAPPDATA: "C:\\Local" },
        fileSystem,
      }),
    ).resolves.toEqual({
      executablePath: newPath,
      source: "local-app-data",
    });
  });

  it("does not silently ignore a broken configured path", async () => {
    await expect(
      locateCodexExecutable({
        explicitPath: "C:\\Missing\\codex.exe",
        platform: "win32",
        env: { PATH: "" },
        fileSystem: fakeFileSystem({}),
      }),
    ).rejects.toBeInstanceOf(AppServerError);
  });

  it("reports a dedicated not-found error", async () => {
    await expect(
      locateCodexExecutable({
        platform: "win32",
        env: {},
        fileSystem: fakeFileSystem({}),
      }),
    ).rejects.toBeInstanceOf(CodexExecutableNotFoundError);
  });
});
