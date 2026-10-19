import {
  EmbeddingProcess,
  EmbeddingProcessLaunch,
  EmbeddingProcessLauncher,
} from "./runtimeTypes";

export class ZoteroSubprocessLauncher implements EmbeddingProcessLauncher {
  async launch(options: EmbeddingProcessLaunch): Promise<EmbeddingProcess> {
    if (!options.command.trim()) throw new Error("Subprocess command is required");
    const imported = (ChromeUtils as any).importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    );
    const Subprocess = imported?.Subprocess;
    if (typeof Subprocess?.call !== "function")
      throw new Error("Zotero Subprocess.sys.mjs is unavailable");
    return (await Subprocess.call({
      command: options.command,
      arguments: [...options.arguments],
      ...(options.environment ? { environment: options.environment } : {}),
      stderr: "pipe",
    })) as EmbeddingProcess;
  }
}
