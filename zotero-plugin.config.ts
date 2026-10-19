import { defineConfig } from "zotero-plugin-scaffold";
import { fileURLToPath } from "node:url";
import pkg from "./package.json";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  xpiName: `zaichat-${pkg.version}`,
  // Zotero 9 rejects manifests without a non-empty update_url. The reserved
  // .invalid TLD makes this an explicit non-publishing placeholder.
  updateURL: "https://updates.zaichat.invalid/update.json",
  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: { prefix: pkg.config.prefsPrefix },
    esbuildOptions: [
      {
        absWorkingDir: projectRoot,
        entryPoints: ["./src/index.ts"],
        define: { __env__: `"${process.env.NODE_ENV || "production"}"` },
        bundle: true,
        target: "firefox115",
        outfile: ".scaffold/build/addon/content/scripts/zaichat.js",
      },
    ],
  },
  test: {
    entries: "test-zotero",
    waitForPlugin:
      "() => Zotero.ZaiChat?.data.initialized === true || Zotero.ZaiChat?.data.startupStage === 'failed'",
    watch: false,
    abortOnFail: true,
  },
});
