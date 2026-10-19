import { describe, expect, it, vi } from "vitest";
import { SemanticModelInstaller } from "../src/semantic/semanticModelInstaller";
import {
  e5Manifest,
  e5ModelID,
  E5_MODEL_IDS,
  modelIndexRoot,
} from "../src/semantic/modelCatalog";
import { createModelFingerprint } from "../src/semantic/fingerprint";
import { artifactIdentity } from "../src/semantic/semanticArtifactManager";
import { SEMANTIC_MODEL_MANIFEST } from "../src/semantic/releaseManifests";

describe("E5 deployment", () => {
  it("pins all three fingerprints and all large external weights", async () => {
    for (const id of E5_MODEL_IDS) {
      const manifest = e5Manifest(id);
      expect(await createModelFingerprint(manifest.model!)).toEqual(manifest.model);
      expect(
        manifest.files.every(
          (file) => file.size > 0 && /^[a-f0-9]{64}$/.test(file.sha256),
        ),
      ).toBe(true);
      for (const file of manifest.files.filter(
        (file) => file.relativePath !== "THIRD_PARTY_NOTICES.txt",
      )) {
        expect(file.url).toContain(
          `hf-mirror.com/${manifest.packageID}/resolve/${manifest.version}/`,
        );
      }
    }
    expect(
      e5Manifest("large").files.find(
        (file) => file.relativePath === "onnx/model.onnx_data",
      )?.size,
    ).toBe(2235363328);
    expect(() => e5ModelID("untrusted/model")).toThrow("Unknown");
  });
  it("keeps small installation identity while isolating new indexes", () => {
    expect(artifactIdentity(e5Manifest("small"))).toBe(
      artifactIdentity(SEMANTIC_MODEL_MANIFEST),
    );
    const join = (...parts: string[]) => parts.join("/");
    const paths = E5_MODEL_IDS.map((id) =>
      modelIndexRoot("/profile", e5Manifest(id), join),
    );
    expect(paths[0]).toBe("/profile/zaichat/semantic");
    expect(new Set(paths).size).toBe(3);
    expect(paths.slice(1).every((path) => !path.startsWith(paths[0] + "/"))).toBe(true);
  });
  it("only persists a selection after installation and encoder self-test", async () => {
    const target = {
      installRequired: vi.fn(async () => undefined),
      probeRuntime: vi.fn(async () => undefined),
    };
    const save = vi.fn();
    const installer = new SemanticModelInstaller(
      "small",
      () => target as any,
      save,
      () => true,
    );
    await expect(installer.install("base", false)).rejects.toThrow("confirmation");
    expect(target.installRequired).not.toHaveBeenCalled();
    await installer.install("base", true);
    expect(target.installRequired).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ startAfterInstall: false }),
    );
    expect(target.probeRuntime).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("base");
    expect(installer.activeModel).toBe("small");
    expect(installer.busy).toBe(false);
  });
  it("preserves active selection on cancellation, probe failure and unsupported hosts", async () => {
    const save = vi.fn();
    let unblock!: () => void;
    const target = {
      installRequired: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            unblock = resolve;
          }),
      ),
      probeRuntime: vi.fn(async () => undefined),
    };
    const installer = new SemanticModelInstaller(
      "small",
      () => target as any,
      save,
      () => true,
    );
    const task = installer.install("large", true);
    await expect(installer.install("base", true)).rejects.toThrow("running");
    installer.cancel();
    unblock();
    await expect(task).rejects.toThrow("cancelled");
    expect(save).not.toHaveBeenCalled();
    expect(target.probeRuntime).not.toHaveBeenCalled();
    target.installRequired.mockResolvedValue(undefined);
    target.probeRuntime.mockRejectedValue(new Error("encoder failed"));
    await expect(installer.install("base", true)).rejects.toThrow("encoder failed");
    expect(save).not.toHaveBeenCalled();
    const unsupported = new SemanticModelInstaller(
      "small",
      () => target as any,
      save,
      () => false,
    );
    await expect(unsupported.install("base", true)).rejects.toThrow("Windows x64");
    await expect(installer.deleteModel("small", true)).rejects.toThrow("active model");
  });
});
