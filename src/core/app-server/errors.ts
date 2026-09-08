export class AppServerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerError";
  }
}

export class CodexExecutableNotFoundError extends AppServerError {
  constructor() {
    super(
      "Could not find the Codex executable. Add it to PATH or configure an explicit executable path.",
    );
    this.name = "CodexExecutableNotFoundError";
  }
}

export class AppServerProtocolError extends AppServerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerProtocolError";
  }
}

export class AppServerRequestTimeoutError extends AppServerError {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`App Server request "${method}" timed out after ${timeoutMs} ms.`);
    this.name = "AppServerRequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class AppServerRpcError extends AppServerError {
  readonly code: number | string | null;
  readonly data: unknown;

  constructor(
    method: string,
    error: { code?: unknown; message?: unknown; data?: unknown },
  ) {
    const code =
      typeof error.code === "number" || typeof error.code === "string"
        ? error.code
        : null;
    const rpcMessage =
      typeof error.message === "string" && error.message.length > 0
        ? error.message
        : "Unknown RPC error";
    super(
      `App Server request "${method}" failed${code === null ? "" : ` (${String(code)})`}: ${rpcMessage}`,
    );
    this.name = "AppServerRpcError";
    this.code = code;
    this.data = error.data;
  }
}

export class AppServerProcessExitError extends AppServerError {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stderrTruncated: boolean;

  constructor(options: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stderrTruncated: boolean;
  }) {
    const reason =
      options.signal === null
        ? `exit code ${options.exitCode === null ? "unknown" : options.exitCode}`
        : `signal ${options.signal}`;
    const stderrSuffix = options.stderr
      ? ` Stderr${options.stderrTruncated ? " (truncated)" : ""}: ${options.stderr}`
      : "";
    super(`Codex App Server exited with ${reason}.${stderrSuffix}`);
    this.name = "AppServerProcessExitError";
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.stderr = options.stderr;
    this.stderrTruncated = options.stderrTruncated;
  }
}
