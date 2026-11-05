import { expect, it, vi } from "vitest";
import { RunInteraction, SteeringInterruption } from "../src/agent/runInteraction";

const input = (id: string, text = "Use the abbreviated name") => ({
  id,
  text,
  context: {
    refs: { items: [], attachments: [], notes: [], annotations: [], collections: [] },
  },
});

it("aborts only the current model request, not the Agent run", async () => {
  const interaction = new RunInteraction();
  const run = new AbortController();
  let request!: AbortSignal;
  const result = interaction
    .request(run.signal, (signal) => {
      request = signal;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    })
    .catch((error) => error);
  interaction.submit(input("a"));
  expect(await result).toBeInstanceOf(SteeringInterruption);
  expect(request.aborted).toBe(true);
  expect(run.signal.aborted).toBe(false);
  expect(interaction.take().map((entry) => entry.id)).toEqual(["a"]);
});

it("does not accept a late response from a transport that ignored cancellation", async () => {
  const interaction = new RunInteraction();
  let resolve!: (text: string) => void;
  const result = interaction
    .request(
      new AbortController().signal,
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    )
    .catch((error) => error);
  interaction.submit(input("a"));
  resolve("obsolete");
  expect(await result).toBeInstanceOf(SteeringInterruption);
});

it("collects ordered inputs during local tool work without aborting the tool", () => {
  const interaction = new RunInteraction();
  interaction.submit(input("a"));
  interaction.submit(input("b", "Only first authors"));
  expect(interaction.take().map((entry) => entry.id)).toEqual(["a", "b"]);
  expect(interaction.hasPending).toBe(false);
});

it("waits for clarification without making model requests and consumes the real reply", async () => {
  const interaction = new RunInteraction();
  const result = interaction.waitForReply(
    { id: "q", question: "Which scope?", choices: [] },
    new AbortController().signal,
  );
  let resolved = false;
  void result.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);
  interaction.submit(input("a", "Only first authors"));
  expect(await result).toBe("Only first authors");
  expect(interaction.take()[0].text).toBe("Only first authors");
});

it("cancels clarification and detaches its abort listener", async () => {
  const interaction = new RunInteraction();
  const run = new AbortController();
  const remove = vi.spyOn(run.signal, "removeEventListener");
  const result = interaction
    .waitForReply({ id: "q", question: "Scope?", choices: [] }, run.signal)
    .catch((error) => error);
  run.abort("cancelled");
  expect(await result).toBe("cancelled");
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("bounds guidance without consuming invalid messages or recharging tool budgets", () => {
  const interaction = new RunInteraction();
  expect(() => interaction.submit(input("empty", " "))).toThrow();
  expect(() => interaction.submit(input("large", "x".repeat(6001)))).toThrow();
  for (let index = 0; index < 20; index++) {
    interaction.submit(input(String(index)));
    interaction.take();
  }
  expect(() => interaction.submit(input("extra"))).toThrow("20 updates");
});

it("bounds cumulative guidance even after earlier updates were consumed", () => {
  const interaction = new RunInteraction();
  for (let index = 0; index < 5; index++) {
    interaction.submit(input(String(index), "x".repeat(6000)));
    interaction.take();
  }
  expect(() => interaction.submit(input("extra", "x"))).toThrow("30000");
  expect(interaction.hasPending).toBe(false);
});
