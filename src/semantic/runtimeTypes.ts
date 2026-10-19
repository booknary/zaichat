import { SemanticModelFingerprint } from "./types";

export type EmbeddingRuntimeState =
  | "stopped"
  | "starting"
  | "ready"
  | "stopping"
  | "crashed"
  | "backoff"
  | "incompatible";

export interface EmbeddingProcessExit {
  exitCode: number;
}

export interface EmbeddingProcess {
  stdin: {
    write(value: string): Promise<unknown>;
    close(): Promise<unknown>;
  };
  stdout: { readString(): Promise<string> };
  stderr?: { readString(): Promise<string> };
  wait(): Promise<EmbeddingProcessExit>;
  kill(timeout?: number): Promise<EmbeddingProcessExit>;
}

export interface EmbeddingProcessLaunch {
  command: string;
  arguments: string[];
  environment?: Record<string, string>;
}

export interface EmbeddingProcessLauncher {
  launch(options: EmbeddingProcessLaunch): Promise<EmbeddingProcess>;
}

export interface EmbeddingRuntimeConfiguration {
  runtimeVersion: string;
  protocolVersion: number;
  command: string;
  arguments: string[];
  modelDirectory: string;
  model: SemanticModelFingerprint;
  requestTimeoutMs: number;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  idleTimeoutMs: number;
  maxCrashRestarts: number;
  crashBackoffMs: number[];
}

export interface EmbeddingRuntimeStatus {
  state: EmbeddingRuntimeState;
  crashCount: number;
  pid?: number;
  lastError?: string;
}

export interface WorkerRequest {
  id?: string;
  command: string;
  [key: string]: unknown;
}

export interface WorkerResponse {
  id: string;
  ok: boolean;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}
