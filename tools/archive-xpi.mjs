import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { URL } from "node:url";
import process from "node:process";
import console from "node:console";
const directory = new URL("../releases/", import.meta.url);
await mkdir(directory, { recursive: true });
const build = new URL("../.scaffold/build/", import.meta.url);
let files;
try {
  files = await readdir(build);
} catch (error) {
  if (error.code === "ENOENT") process.exit(0);
  throw error;
}
for (const name of files.filter((name) => name.endsWith(".xpi"))) {
  const source = new URL(name, build);
  const bytes = await readFile(source);
  const hash = createHash("sha256").update(bytes).digest("hex");
  let destination = new URL(name, directory);
  try {
    const existing = await readFile(destination);
    if (existing.equals(bytes)) continue;
    destination = new URL(
      `${basename(name, ".xpi")}-${hash.slice(0, 12)}.xpi`,
      directory,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST" || !(await readFile(destination)).equals(bytes))
      throw error;
  }
  console.log(`Preserved ${destination.pathname.split("/").pop()}`);
}
