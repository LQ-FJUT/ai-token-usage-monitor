import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  AppServerClient,
  AppServerProcessExitError,
  AppServerProtocolError,
  AppServerRequestTimeoutError,
  AppServerRpcError,
  type AppServerProcessLike,
} from "../src/core/app-server/index.js";

type Message = Record<string, unknown>;

class FakeAppServerProcess
  extends EventEmitter
  implements AppServerProcessLike
{
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly clientMessages: Message[] = [];
  killed = false;

  private inputBuffer = "";
  private readonly messageWaiters: Array<(message: Message) => void> = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.inputBuffer += chunk.toString("utf8");
      let newline = this.inputBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.inputBuffer.slice(0, newline);
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line) as Message;
          this.clientMessages.push(message);
          this.messageWaiters.shift()?.(message);
        }
        newline = this.inputBuffer.indexOf("\n");
      }
    });
  }

  nextClientMessage(): Promise<Message> {
    // Tests always consume in order. Keep an independent cursor to avoid timing
    // assumptions about PassThrough's data event.
    if (this.listenerCursor < this.clientMessages.length) {
      const message = this.clientMessages[this.listenerCursor];
      this.listenerCursor += 1;
      return Promise.resolve(message);
    }
    return new Promise((resolve) => {
      this.messageWaiters.push((message) => {
        this.listenerCursor += 1;
        resolve(message);
      });
    });
  }

  private listenerCursor = 0;

  send(message: Message): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  exit(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", exitCode, signal);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.emit(
      "exit",
      null,
      typeof signal === "string" ? signal : ("SIGTERM" as NodeJS.Signals),
    );
    return true;
  }
}

async function connectFake(
  fake: FakeAppServerProcess,
  options: Parameters<typeof AppServerClient.connectToProcess>[1] = {},
): Promise<AppServerClient> {
  const connecting = AppServerClient.connectToProcess(fake, options);
  const initialize = await fake.nextClientMessage();
  expect(initialize).toMatchObject({
    method: "initialize",
    params: {
      capabilities: {
        experimentalApi: options.experimentalApi ?? false,
        requestAttestation: false,
      },
    },
  });
  fake.send({ id: initialize.id, result: { userAgent: "codex-test/1.0" } });
  const client = await connecting;
  expect(await fake.nextClientMessage()).toEqual({ method: "initialized" });
  return client;
}

describe("AppServerClient protocol lifecycle", () => {
  it("waits for a valid initialize response before sending initialized", async () => {
    const fake = new FakeAppServerProcess();
    const connecting = AppServerClient.connectToProcess(fake);

    const initialize = await fake.nextClientMessage();
    expect(initialize.method).toBe("initialize");
    expect(initialize).toMatchObject({
      params: { capabilities: { experimentalApi: false } },
    });
    expect(fake.clientMessages).toHaveLength(1);

    fake.send({ id: initialize.id, result: { userAgent: "codex-test/1.0" } });
    const client = await connecting;
    expect(await fake.nextClientMessage()).toEqual({ method: "initialized" });
    expect(client.serverUserAgent).toBe("codex-test/1.0");
    client.close();
    expect(fake.killed).toBe(true);
  });

  it("rejects an invalid initialize response without announcing initialized", async () => {
    const fake = new FakeAppServerProcess();
    const connecting = AppServerClient.connectToProcess(fake);
    const initialize = await fake.nextClientMessage();

    fake.send({ id: initialize.id, result: {} });
    await expect(connecting).rejects.toBeInstanceOf(AppServerProtocolError);
    expect(fake.clientMessages).toHaveLength(1);
    expect(fake.killed).toBe(true);
  });

  it("implements account, rate-limit, and usage reads", async () => {
    const fake = new FakeAppServerProcess();
    const client = await connectFake(fake);

    const readingAccount = client.accountRead();
    const accountRequest = await fake.nextClientMessage();
    expect(accountRequest).toMatchObject({
      method: "account/read",
      params: { refreshToken: false },
    });
    fake.send({
      id: accountRequest.id,
      result: {
        account: { type: "chatgpt", email: "hidden@example.test" },
        requiresOpenaiAuth: true,
      },
    });
    expect(await readingAccount).toMatchObject({
      account: { type: "chatgpt" },
      requiresOpenaiAuth: true,
    });

    const readingRateLimits = client.rateLimitsRead();
    const rateRequest = await fake.nextClientMessage();
    expect(rateRequest).toEqual({
      method: "account/rateLimits/read",
      id: rateRequest.id,
    });
    fake.send({
      id: rateRequest.id,
      result: {
        rateLimits: null,
        rateLimitsByLimitId: {
          codex: {
            primary: {
              usedPercent: 20,
              windowDurationMins: 300,
              resetsAt: 100,
            },
          },
        },
      },
    });
    expect(await readingRateLimits).toMatchObject({
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { windowDurationMins: 300 },
        },
      },
    });

    const readingUsage = client.usageRead();
    const usageRequest = await fake.nextClientMessage();
    expect(usageRequest).toMatchObject({
      method: "account/usage/read",
      params: {},
    });
    fake.send({
      id: usageRequest.id,
      result: {
        summary: { lifetimeTokens: 5 },
        dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 5 }],
      },
    });
    expect(await readingUsage).toMatchObject({
      summary: { lifetimeTokens: 5 },
      dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 5 }],
    });
    client.close();
  });

  it("requires an explicit experimental opt-in for thread-specific usage", async () => {
    const stableFake = new FakeAppServerProcess();
    const stableClient = await connectFake(stableFake);
    const messagesBeforeRead = stableFake.clientMessages.length;
    await expect(stableClient.usageRead("thread-1")).rejects.toThrow(
      "experimentalApi: true",
    );
    expect(stableFake.clientMessages).toHaveLength(messagesBeforeRead);
    stableClient.close();

    const experimentalFake = new FakeAppServerProcess();
    const experimentalClient = await connectFake(experimentalFake, {
      experimentalApi: true,
    });
    expect(experimentalClient.experimentalApiEnabled).toBe(true);
    const reading = experimentalClient.usageRead("thread-1");
    const request = await experimentalFake.nextClientMessage();
    expect(request).toMatchObject({
      method: "account/usage/read",
      params: { threadId: "thread-1" },
    });
    experimentalFake.send({
      id: request.id,
      result: {
        summary: null,
        dailyUsageBuckets: null,
        threadUsage: { estimated: true },
      },
    });
    await expect(reading).resolves.toMatchObject({
      threadUsage: { estimated: true },
    });
    experimentalClient.close();
  });

  it("treats rolling rate-limit notifications only as invalidation signals", async () => {
    const fake = new FakeAppServerProcess();
    const client = await connectFake(fake);
    let invalidations = 0;
    const notifications: string[] = [];
    client.onRateLimitsInvalidated(() => {
      invalidations += 1;
    });
    client.onNotification((notification) => {
      notifications.push(notification.method);
    });
    const messagesBeforeNotification = fake.clientMessages.length;

    fake.send({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 99 } } },
    });

    expect(invalidations).toBe(1);
    expect(notifications).toEqual(["account/rateLimits/updated"]);
    expect(fake.clientMessages).toHaveLength(messagesBeforeNotification);
    client.close();
  });

  it("times out individual requests and accepts later requests", async () => {
    const fake = new FakeAppServerProcess();
    const client = await connectFake(fake, { requestTimeoutMs: 20 });

    const timedOut = client.accountRead();
    await fake.nextClientMessage();
    await expect(timedOut).rejects.toBeInstanceOf(
      AppServerRequestTimeoutError,
    );

    const readingUsage = client.usageRead();
    const usageRequest = await fake.nextClientMessage();
    fake.send({
      id: usageRequest.id,
      result: { summary: null, dailyUsageBuckets: null },
    });
    await expect(readingUsage).resolves.toMatchObject({ summary: null });
    client.close();
  });

  it("surfaces JSON-RPC failures with their code", async () => {
    const fake = new FakeAppServerProcess();
    const client = await connectFake(fake);
    const reading = client.rateLimitsRead();
    const request = await fake.nextClientMessage();

    fake.send({
      id: request.id,
      error: { code: -32_001, message: "not authenticated" },
    });
    await expect(reading).rejects.toMatchObject({
      name: AppServerRpcError.name,
      code: -32_001,
    });
    client.close();
  });

  it("rejects pending work on exit and bounds captured stderr", async () => {
    const fake = new FakeAppServerProcess();
    const client = await connectFake(fake, { maxStderrCharacters: 256 });
    const reading = client.accountRead();
    await fake.nextClientMessage();
    fake.stderr.write("x".repeat(400));
    fake.exit(9);

    try {
      await reading;
      throw new Error("expected account/read to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(AppServerProcessExitError);
      expect(error).toMatchObject({
        exitCode: 9,
        stderrTruncated: true,
        stderr: "x".repeat(256),
      });
    }
    client.close();
  });
});
