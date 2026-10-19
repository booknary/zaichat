import { EmbeddingProcess, WorkerRequest, WorkerResponse } from "./runtimeTypes";

interface PendingRequest {
  resolve(value: WorkerResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class NDJSONWorkerClient {
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = "";
  private requestSequence = 0;
  private writeChain = Promise.resolve();
  private closed = false;
  private exitError?: Error;
  private readonly exitPromise: Promise<{ exitCode: number }>;

  constructor(
    private readonly process: EmbeddingProcess,
    private readonly defaultTimeoutMs: number,
    private readonly maxLineChars = 4 * 1024 * 1024,
  ) {
    this.exitPromise = process.wait();
    void this.readLoop();
    void this.drainStderr();
    void this.monitorExit();
  }

  async request<T extends WorkerResponse = WorkerResponse>(
    request: WorkerRequest,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T> {
    if (this.closed) throw this.exitError || new Error("Embedding worker is closed");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("Embedding worker request timeout must be positive");
    const id = request.id || `zaichat-${Date.now()}-${++this.requestSequence}`;
    if (this.pending.has(id)) throw new Error(`Duplicate embedding request ID: ${id}`);
    const response = new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Embedding worker request timed out: ${request.command}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    // Zotero's Subprocess string pipe and a frozen Windows Python worker can
    // disagree about the console encoding. Keep the NDJSON transport strictly
    // ASCII so multilingual text is reconstructed from JSON escapes in Python.
    const line = `${stringifyASCII({ ...request, id })}\n`;
    this.writeChain = this.writeChain.then(async () => {
      if (this.closed) throw this.exitError || new Error("Embedding worker is closed");
      await this.process.stdin.write(line);
    });
    try {
      await this.writeChain;
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(asError(error, "Embedding worker write failed"));
      }
    }
    const result = (await response) as T;
    if (!result.ok) {
      const code = cleanWorkerText(result.error?.code || "worker-error");
      const message = cleanWorkerText(result.error?.message || "Request rejected");
      throw new Error(`Embedding worker ${code}: ${message}`);
    }
    return result;
  }

  async wait(): Promise<{ exitCode: number }> {
    return this.exitPromise;
  }

  async kill(timeout?: number): Promise<{ exitCode: number }> {
    return this.process.kill(timeout);
  }

  async closeInput(): Promise<void> {
    await this.process.stdin.close();
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed) {
        const chunk = await this.process.stdout.readString();
        if (!chunk) break;
        this.buffer += chunk;
        if (this.buffer.length > this.maxLineChars && !this.buffer.includes("\n"))
          throw new Error("Embedding worker emitted an oversized NDJSON line");
        for (;;) {
          const newline = this.buffer.indexOf("\n");
          if (newline < 0) break;
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (line) this.acceptLine(line);
        }
      }
    } catch (error) {
      this.failAll(asError(error, "Embedding worker output failed"));
    }
  }

  private acceptLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      throw new Error("Embedding worker emitted invalid NDJSON");
    }
    if (!response || typeof response.id !== "string")
      throw new Error("Embedding worker response has no request ID");
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private async monitorExit(): Promise<void> {
    try {
      const exit = await this.exitPromise;
      this.failAll(new Error(`Embedding worker exited with code ${exit.exitCode}`));
    } catch (error) {
      this.failAll(asError(error, "Embedding worker exit monitoring failed"));
    }
  }

  private async drainStderr(): Promise<void> {
    if (!this.process.stderr) return;
    try {
      while (!this.closed) {
        const chunk = await this.process.stderr.readString();
        if (!chunk) return;
      }
    } catch {
      // Process exit closes stderr. Protocol errors are reported over stdout.
    }
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.exitError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function cleanWorkerText(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

function stringifyASCII(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function asError(error: unknown, prefix: string): Error {
  return error instanceof Error ? error : new Error(`${prefix}: ${String(error)}`);
}
