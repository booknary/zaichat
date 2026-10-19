import { NDJSONWorkerClient } from "../src/semantic/ndjsonWorkerClient";
import { ZoteroSubprocessLauncher } from "../src/semantic/zoteroSubprocessLauncher";

describe("Packaged semantic runtime", function () {
  it("starts the self-contained worker through Zotero Subprocess", async function () {
    const executable = Services.env.get("ZAICHAT_PACKAGED_WORKER");
    if (!executable) return;
    this.timeout(30000);
    const process = await new ZoteroSubprocessLauncher().launch({
      command: executable,
      arguments: [],
    });
    const client = new NDJSONWorkerClient(process, 10000);
    try {
      const hello = await client.request({ command: "hello" });
      if (hello.protocolVersion !== 1 || hello.runtimeVersion !== "0.8.0-worker.1")
        throw new Error(
          `Unexpected packaged worker handshake: ${JSON.stringify(hello)}`,
        );
      await client.request({ command: "ping" });
      await client.request({ command: "shutdown" });
      const exit = await client.wait();
      if (exit.exitCode !== 0)
        throw new Error(`Packaged worker exited with ${exit.exitCode}`);
    } finally {
      await client.kill(1000).catch(() => undefined);
    }
  });
});
