import type { ContextEnvelope, PendingUserQuestion } from "../core/types";

export interface SteeringInput {
  id: string;
  text: string;
  context: ContextEnvelope;
}

export class SteeringInterruption extends Error {
  constructor() {
    super("Model request superseded by user guidance");
  }
}

/** Run-local input control; never abort an executing Zotero tool or transaction. */
export class RunInteraction {
  private pending: SteeringInput[] = [];
  private accepted = 0;
  private acceptedChars = 0;
  private requestController?: AbortController;
  private reply?: (text: string) => void;

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  submit(input: SteeringInput): void {
    if (!input.text.trim() || input.text.length > 6000)
      throw new Error("Guidance must contain 1–6000 characters");
    if (this.accepted >= 20)
      throw new Error("This run has received 20 updates; stop and start a new task");
    if (this.acceptedChars + input.text.length > 30000)
      throw new Error("Guidance exceeds 30000 characters; start a new task");
    this.accepted++;
    this.acceptedChars += input.text.length;
    this.pending.push(input);
    this.requestController?.abort(new SteeringInterruption());
    this.reply?.(input.text);
  }

  take(): SteeringInput[] {
    return this.pending.splice(0);
  }

  async request<T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>) {
    if (this.hasPending) throw new SteeringInterruption();
    const controller = new AbortController();
    this.requestController = controller;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const result = await action(controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.requestController === controller) this.requestController = undefined;
    }
  }

  async waitForReply(
    _question: PendingUserQuestion,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw signal.reason;
    if (this.hasPending) return this.pending.at(-1)!.text;
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        this.reply = undefined;
      };
      const abort = () => {
        cleanup();
        reject(signal.reason || new Error("Run cancelled"));
      };
      this.reply = (text) => {
        cleanup();
        resolve(text);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
