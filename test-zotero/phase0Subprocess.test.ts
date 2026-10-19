import { ZoteroSubprocessLauncher } from "../src/semantic/zoteroSubprocessLauncher";
import { EmbeddingProcessLauncher } from "../src/semantic/runtimeTypes";

type PrototypeProcess = {
  stdin: { write(value: string): Promise<unknown>; close(): Promise<unknown> };
  stdout: { readString(): Promise<string> };
  stderr?: { readString(): Promise<string> };
  wait(): Promise<{ exitCode: number }>;
  kill(timeout?: number): Promise<{ exitCode: number }>;
};

type SpawnResult = {
  process: PrototypeProcess;
  hello: Record<string, unknown>;
  startupMs: number;
};

describe("Phase 0 Zotero Subprocess prototype", function () {
  it("validates startup, NDJSON, shutdown, and crash recovery", async function () {
    if (Services.env.get("ZAICHAT_PHASE0_SUBPROCESS") !== "1") return;
    this.timeout(180000);

    const python = Services.env.get("ZAICHAT_PHASE0_PYTHON");
    const worker = Services.env.get("ZAICHAT_PHASE0_WORKER");
    const resultPath = Services.env.get("ZAICHAT_PHASE0_RESULT");
    if (!python || !worker || !resultPath)
      throw new Error("Phase 0 subprocess environment is incomplete");

    const launcher = new ZoteroSubprocessLauncher();

    const startupSamples: number[] = [];
    const shutdownSamples: number[] = [];
    const cycleCount = 100;
    for (let index = 0; index < cycleCount; index += 1) {
      const spawned = await spawn(launcher, python, worker);
      startupSamples.push(spawned.startupMs);
      const shutdownStarted = now();
      const shutdown = await request(spawned.process, {
        id: `shutdown-${index}`,
        command: "shutdown",
      });
      if (!shutdown.ok) throw new Error(`Shutdown ${index} was rejected`);
      const exit = await spawned.process.wait();
      if (exit.exitCode !== 0)
        throw new Error(`Shutdown ${index} exited with ${exit.exitCode}`);
      shutdownSamples.push(now() - shutdownStarted);
    }

    const throughputProcess = await spawn(launcher, python, worker);
    const messageCount = 10000;
    const messages = Array.from({ length: messageCount }, (_, index) =>
      JSON.stringify({
        id: `echo-${index}`,
        command: "echo",
        payload: { index, text: `消息 ${index} – genome novelty` },
      }),
    ).join("\n");
    const throughputStarted = now();
    const responsesPromise = readMessages(throughputProcess.process, messageCount);
    await throughputProcess.process.stdin.write(`${messages}\n`);
    const responses = await responsesPromise;
    const throughputMs = now() - throughputStarted;
    for (let index = 0; index < responses.length; index += 1) {
      const response = responses[index];
      if (response.id !== `echo-${index}` || response.payload?.index !== index)
        throw new Error(`NDJSON response ${index} was lost or reordered`);
    }
    await request(throughputProcess.process, {
      id: "throughput-shutdown",
      command: "shutdown",
    });
    const throughputExit = await throughputProcess.process.wait();

    const crashProcess = await spawn(launcher, python, worker);
    const crashStarted = now();
    await crashProcess.process.stdin.write(
      `${JSON.stringify({ id: "crash", command: "crash" })}\n`,
    );
    const crashExit = await crashProcess.process.wait();
    const crashDetectionMs = now() - crashStarted;
    const recoveryStarted = now();
    const recovered = await spawn(launcher, python, worker);
    const recoveryMs = now() - recoveryStarted;
    await request(recovered.process, { id: "recovered-shutdown", command: "shutdown" });
    const recoveryExit = await recovered.process.wait();

    const result = {
      prototype: "zotero-subprocess-ndjson",
      environment: {
        zoteroVersion: Zotero.version,
        platform: Zotero.platform,
        python,
        worker,
      },
      measurements: {
        cycleCount,
        startupMs: summarize(startupSamples),
        gracefulShutdownMs: summarize(shutdownSamples),
        messageCount,
        ndjsonRoundTripMs: throughputMs,
        messagesPerSecond: (messageCount * 1000) / throughputMs,
        crashDetectionMs,
        recoveryMs,
      },
      exits: {
        throughput: throughputExit.exitCode,
        intentionalCrash: crashExit.exitCode,
        recovered: recoveryExit.exitCode,
      },
      failures: [] as string[],
      decision:
        throughputExit.exitCode === 0 &&
        crashExit.exitCode !== 0 &&
        recoveryExit.exitCode === 0 &&
        percentile(startupSamples, 95) <= 15000 &&
        percentile(shutdownSamples, 95) <= 5000 &&
        crashDetectionMs <= 2000 &&
        recoveryMs <= 15000
          ? "go"
          : "no-go",
    };
    await IOUtils.writeUTF8(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    if (result.decision !== "go")
      throw new Error(`Subprocess prototype failed: ${JSON.stringify(result)}`);
  });
});

async function spawn(
  launcher: EmbeddingProcessLauncher,
  python: string,
  worker: string,
): Promise<SpawnResult> {
  const started = now();
  const process = (await launcher.launch({
    command: python,
    arguments: ["-u", worker],
  })) as PrototypeProcess;
  const hello = await request(process, { id: "hello", command: "hello" });
  const startupMs = now() - started;
  if (!hello.ok || hello.protocolVersion !== 1)
    throw new Error(`Worker handshake failed: ${JSON.stringify(hello)}`);
  return { process, hello, startupMs };
}

async function request(
  process: PrototypeProcess,
  message: Record<string, unknown>,
): Promise<any> {
  const responsePromise = readMessages(process, 1);
  await process.stdin.write(`${JSON.stringify(message)}\n`);
  return (await responsePromise)[0];
}

async function readMessages(process: PrototypeProcess, count: number): Promise<any[]> {
  const messages: any[] = [];
  let buffer = "";
  while (messages.length < count) {
    const chunk = await process.stdout.readString();
    if (!chunk)
      throw new Error(`Worker stdout closed after ${messages.length} messages`);
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) messages.push(JSON.parse(line));
      if (messages.length === count) return messages;
    }
  }
  return messages;
}

function now(): number {
  return Date.now();
}

function summarize(values: number[]): {
  min: number;
  p50: number;
  p95: number;
  max: number;
} {
  return {
    min: Math.min(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
  };
}

function percentile(values: number[], value: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((value / 100) * sorted.length) - 1),
  );
  return sorted[index];
}
