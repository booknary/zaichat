import { createHash } from "node:crypto";
import console from "node:console";
import process from "node:process";
import { readFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "addon/content/runtime");
// Published source snapshots include the already validated, pinned runtime.
// Reuse it without inspecting or changing a developer's Python environment.
const bundledFiles = [
  [
    "zaichat-embedding-worker.exe",
    "44dad54c16773b484e00b04d03524872ec5778bff604b514ffc3ce0c2eed397e",
  ],
  [
    "THIRD_PARTY_NOTICES.txt",
    "020f130e511a32ea50ed023535560b6196496a1e94647b0083c58c5b9a41e29e",
  ],
];
let bundledReady = true;
for (const [name, hash] of bundledFiles) {
  try {
    if (
      createHash("sha256")
        .update(await readFile(join(output, name)))
        .digest("hex") !== hash
    )
      throw new Error(`Bundled runtime hash mismatch: ${name}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    bundledReady = false;
  }
}
if (bundledReady) {
  for (const license of [
    "licenses/Python.txt",
    "licenses/pyinstaller-distribution/COPYING.txt",
    "licenses/worker-dependencies/onnxruntime/LICENSE",
  ])
    await readFile(join(output, license));
  console.log(
    "Verified the existing pinned runtime and required license notices (models remain external).",
  );
  process.exit(0);
}
await mkdir(output, { recursive: true });
const assets = join(root, ".scaffold/semantic-release-candidate/assets");
for (const [source, target, hash] of [
  [
    "zaichat-embedding-worker-win-x64-0.8.0-worker.1.exe",
    "zaichat-embedding-worker.exe",
    "44dad54c16773b484e00b04d03524872ec5778bff604b514ffc3ce0c2eed397e",
  ],
  [
    "multilingual-e5-small-0e60b8d9d216-THIRD_PARTY_NOTICES.txt",
    "THIRD_PARTY_NOTICES.txt",
    "020f130e511a32ea50ed023535560b6196496a1e94647b0083c58c5b9a41e29e",
  ],
]) {
  const path = join(assets, source);
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== hash)
    throw new Error(`Pinned runtime asset mismatch: ${source}`);
  await copyFile(path, join(output, target));
}

// Redistribute license/notice texts only, never the development environment.
async function collectLicenses(directory, destination) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    const target = join(destination, entry.name);
    if (entry.isDirectory()) await collectLicenses(path, target);
    else if (
      /license|licence|copying|notice/i.test(entry.name) &&
      !/\.(dll|pyd|pyc|py)$/i.test(entry.name)
    ) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(path, target);
    }
  }
}
await collectLicenses(
  join(root, "prototypes/phase0/embedding/.python"),
  join(output, "licenses/worker-dependencies"),
);
await collectLicenses(
  "D:/Conda/envs/python_learn/Lib/site-packages/PyInstaller",
  join(output, "licenses/pyinstaller"),
);
await collectLicenses(
  "D:/Conda/envs/python_learn/Lib/site-packages/pyinstaller-6.12.0.dist-info",
  join(output, "licenses/pyinstaller-distribution"),
);
await mkdir(join(output, "licenses"), { recursive: true });
await copyFile(
  "D:/Conda/envs/python_learn/LICENSE_PYTHON.txt",
  join(output, "licenses/Python.txt"),
);
console.log("Verified and staged the Windows x64 runtime (models remain external).");
