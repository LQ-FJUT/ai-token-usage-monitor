import { spawn } from "node:child_process";

import type {
  AccountUsageReadResult,
  RateLimitsReadResult,
} from "../types.js";
import { AppServerError, AppServerProtocolError } from "./errors.js";
import {
  locateCodexExecutable,
  type CodexExecutableSource,
  type LocateCodexOptions,
} from "./locate.js";
import {
  coerceAccountUsageReadResult,
  coerceRateLimitsReadResult,
} from "./normalize.js";
import {
  JsonLineTransport,
  type AppServerProcessLike,
} from "./transport.js";

type UnknownRecord = Record<string, unknown>;

export interface AccountReadResult {
  account: unknown | null;
  requiresOpenaiAuth: boolean;
}

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerClientOptions extends LocateCodexOptions {
  requestTimeoutMs?: number;
  initializeTimeoutMs?: number;
  maxStderrCharacters?: number;
  /** Opt in only when a caller needs experimental App Server features. */
  experimentalApi?: boolean;
  clientName?: string;
  clientTitle?: string | null;
  clientVersion?: string;
  cwd?: string;
}

export interface AppServerProcessConnectionOptions {
  requestTimeoutMs?: number;
  initializeTimeoutMs?: number;
  maxStderrCharacters?: number;
  /** Opt in only when a caller needs experimental App Server features. */
  experimentalApi?: boolean;
  clientName?: string;
  clientTitle?: string | null;
  clientVersion?: string;
  executablePath?: string;
  executableSource?: CodexExecutableSource;
}

interface InitializeResponse {
  userAgent: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateInitializeResponse(value: unknown): InitializeResponse {
  if (!isRecord(value) || typeof value.userAgent !== "string") {
    throw new AppServerProtocolError(
      "Codex App Server returned an invalid initialize response.",
    );
  }
  return { userAgent: value.userAgent };
}

function validateAccountReadResponse(value: unknown): AccountReadResult {
  if (!isRecord(value) || typeof value.requiresOpenaiAuth !== "boolean") {
    throw new AppServerProtocolError(
      "Codex App Server returned an invalid account/read response.",
    );
  }
  return {
    account: value.account ?? null,
    requiresOpenaiAuth: value.requiresOpenaiAuth,
  };
}

export class AppServerClient {
  readonly executablePath: string | null;
  readonly executableSource: CodexExecutableSource | null;
  readonly serverUserAgent: string;
  readonly experimentalApiEnabled: boolean;

  private readonly transport: JsonLineTransport;

  private constructor(
    transport: JsonLineTransport,
    initializeResponse: InitializeResponse,
    executablePath: string | null,
    executableSource: CodexExecutableSource | null,
    experimentalApiEnabled: boolean,
  ) {
    this.transport = transport;
    this.serverUserAgent = initializeResponse.userAgent;
    this.executablePath = executablePath;
    this.executableSource = executableSource;
    this.experimentalApiEnabled = experimentalApiEnabled;
  }

  static async connect(options: AppServerClientOptions = {}): Promise<AppServerClient> {
    const located = await locateCodexExecutable(options);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(located.executablePath, ["app-server", "--stdio"], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new AppServerError("Could not launch the Codex App Server.", {
        cause: error,
      });
    }

    return await AppServerClient.connectToProcess(
      child as unknown as AppServerProcessLike,
      {
        ...options,
        executablePath: located.executablePath,
        executableSource: located.source,
      },
    );
  }

  /** Public for deterministic tests and embedders that own the child process. */
  static async connectToProcess(
    child: AppServerProcessLike,
    options: AppServerProcessConnectionOptions = {},
  ): Promise<AppServerClient> {
    const transport = new JsonLineTransport(child, {
      requestTimeoutMs: options.requestTimeoutMs,
      maxStderrCharacters: options.maxStderrCharacters,
    });

    try {
      const initializeResult = await transport.request<unknown>(
        "initialize",
        {
          clientInfo: {
            name: options.clientName ?? "codex-usage-monitor",
            title: options.clientTitle ?? "Codex Usage Monitor",
            version: options.clientVersion ?? "0.2.0",
          },
          capabilities: {
            experimentalApi: options.experimentalApi ?? false,
            requestAttestation: false,
          },
        },
        options.initializeTimeoutMs ?? options.requestTimeoutMs ?? 10_000,
      );
      const initializeResponse = validateInitializeResponse(initializeResult);

      // App Server's lifecycle requires this notification only after a valid
      // initialize response. Sending it optimistically races older servers.
      transport.notify("initialized");
      return new AppServerClient(
        transport,
        initializeResponse,
        options.executablePath ?? null,
        options.executableSource ?? null,
        options.experimentalApi ?? false,
      );
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    return this.transport.onNotification((method, params) => {
      listener({ method, params });
    });
  }

  /**
   * `account/rateLimits/updated` is sparse. Consumers receive only an
   * invalidation signal and must call rateLimitsRead() for a fresh snapshot.
   */
  onRateLimitsInvalidated(listener: () => void): () => void {
    return this.transport.onNotification((method) => {
      if (method === "account/rateLimits/updated") {
        listener();
      }
    });
  }

  async accountRead(refreshToken = false): Promise<AccountReadResult> {
    const result = await this.transport.request<unknown>("account/read", {
      refreshToken,
    });
    return validateAccountReadResponse(result);
  }

  async rateLimitsRead(): Promise<RateLimitsReadResult> {
    const result = await this.transport.request<unknown>(
      "account/rateLimits/read",
    );
    return coerceRateLimitsReadResult(result);
  }

  async usageRead(threadId?: string | null): Promise<AccountUsageReadResult> {
    if (typeof threadId === "string" && !this.experimentalApiEnabled) {
      throw new AppServerError(
        "Thread-specific account usage requires connecting with experimentalApi: true.",
      );
    }
    const params = threadId === undefined ? {} : { threadId };
    const result = await this.transport.request<unknown>("account/usage/read", params);
    return coerceAccountUsageReadResult(result);
  }

  close(): void {
    this.transport.close();
  }
}
