import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  AppServerError,
  AppServerProcessExitError,
  AppServerProtocolError,
  AppServerRequestTimeoutError,
  AppServerRpcError,
} from "./errors.js";

type RequestId = number;
type NotificationListener = (method: string, params: unknown) => void;

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface JsonObject {
  [key: string]: unknown;
}

export interface AppServerProcessLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface JsonLineTransportOptions {
  requestTimeoutMs?: number;
  maxStderrCharacters?: number;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toText(chunk: unknown, decoder: StringDecoder): string {
  if (Buffer.isBuffer(chunk)) {
    return decoder.write(chunk);
  }
  return typeof chunk === "string" ? chunk : String(chunk);
}

/** A small JSON-lines request/response transport for the App Server stdio API. */
export class JsonLineTransport {
  private readonly child: AppServerProcessLike;
  private readonly requestTimeoutMs: number;
  private readonly maxStderrCharacters: number;
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stderrTruncated = false;
  private terminalError: Error | null = null;
  private closedByClient = false;

  constructor(
    child: AppServerProcessLike,
    options: JsonLineTransportOptions = {},
  ) {
    this.child = child;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maxStderrCharacters = Math.max(
      256,
      options.maxStderrCharacters ?? 16_384,
    );

    child.stdin.on("error", (error: Error) => {
      this.fail(
        new AppServerError("Could not write Codex App Server stdin.", {
          cause: error,
        }),
      );
    });
    child.stdout.on("data", (chunk: unknown) => {
      this.acceptStdout(toText(chunk, this.stdoutDecoder));
    });
    child.stdout.on("end", () => {
      this.acceptStdout(this.stdoutDecoder.end());
      this.flushFinalStdoutLine();
    });
    child.stdout.on("error", (error: Error) => {
      this.fail(
        new AppServerError("Could not read Codex App Server stdout.", {
          cause: error,
        }),
      );
    });
    child.stderr.on("data", (chunk: unknown) => {
      this.appendStderr(toText(chunk, this.stderrDecoder));
    });
    child.stderr.on("end", () => {
      this.appendStderr(this.stderrDecoder.end());
    });
    child.on("error", (error: Error) => {
      this.fail(
        new AppServerError("Could not start the Codex App Server process.", {
          cause: error,
        }),
      );
    });
    child.on(
      "exit",
      (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (this.closedByClient) {
          return;
        }
        this.fail(
          new AppServerProcessExitError({
            exitCode,
            signal,
            stderr: this.stderrBuffer.trim(),
            stderrTruncated: this.stderrTruncated,
          }),
        );
      },
    );
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async request<T>(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    this.assertOpen();
    const id = this.nextRequestId++;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      try {
        this.write({ method, id, ...(params === undefined ? {} : { params }) }, (error) => {
          if (!error) {
            return;
          }
          const pending = this.takePending(id);
          pending?.reject(
            new AppServerError(`Could not write App Server request "${method}".`, {
              cause: error,
            }),
          );
        });
      } catch (error) {
        const pending = this.takePending(id);
        pending?.reject(
          new AppServerError(`Could not encode App Server request "${method}".`, {
            cause: error,
          }),
        );
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.assertOpen();
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  close(): void {
    if (this.closedByClient) {
      return;
    }
    this.closedByClient = true;
    this.fail(new AppServerError("Codex App Server connection was closed."));
    if (!this.child.stdin.destroyed) {
      this.child.stdin.end();
    }
    try {
      this.child.kill();
    } catch {
      // The child may already have exited between the state check and kill.
    }
  }

  private assertOpen(): void {
    if (this.closedByClient) {
      throw new AppServerError("Codex App Server connection is closed.");
    }
    if (this.terminalError) {
      throw this.terminalError;
    }
  }

  private write(message: JsonObject, callback?: (error?: Error | null) => void): void {
    const line = `${JSON.stringify(message)}\n`;
    this.child.stdin.write(line, "utf8", callback);
  }

  private acceptStdout(text: string): void {
    if (!text || this.terminalError) {
      return;
    }
    this.stdoutBuffer += text;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.acceptLine(line);
      if (this.terminalError) {
        return;
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private flushFinalStdoutLine(): void {
    const line = this.stdoutBuffer.trim();
    this.stdoutBuffer = "";
    if (line) {
      this.acceptLine(line);
    }
  }

  private acceptLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.fail(
        new AppServerProtocolError("App Server emitted malformed JSON.", {
          cause: error,
        }),
      );
      return;
    }
    if (!isJsonObject(message)) {
      this.fail(new AppServerProtocolError("App Server emitted a non-object message."));
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.takePending(message.id);
      if (!pending) {
        return;
      }
      if (isJsonObject(message.error)) {
        pending.reject(new AppServerRpcError(pending.method, message.error));
        return;
      }
      if (!("result" in message)) {
        pending.reject(
          new AppServerProtocolError(
            `App Server response to "${pending.method}" has neither result nor error.`,
          ),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      for (const listener of this.notificationListeners) {
        try {
          listener(message.method, message.params);
        } catch {
          // Consumer callbacks cannot corrupt the protocol state machine.
        }
      }
      return;
    }

    this.fail(new AppServerProtocolError("App Server emitted an unrecognized message."));
  }

  private takePending(id: RequestId): PendingRequest | null {
    const pending = this.pending.get(id);
    if (!pending) {
      return null;
    }
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    return pending;
  }

  private appendStderr(text: string): void {
    if (!text) {
      return;
    }
    const combined = this.stderrBuffer + text;
    if (combined.length > this.maxStderrCharacters) {
      this.stderrBuffer = combined.slice(-this.maxStderrCharacters);
      this.stderrTruncated = true;
      return;
    }
    this.stderrBuffer = combined;
  }

  private fail(error: Error): void {
    if (this.terminalError === null) {
      this.terminalError = error;
    }
    for (const [id] of this.pending) {
      this.takePending(id)?.reject(error);
    }
  }
}
