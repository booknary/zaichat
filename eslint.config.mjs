import zotero from "@zotero-plugin/eslint-config";

export default [
  {
    name: "zaichat/global-ignores",
    ignores: [
      ".scaffold/**",
      "node_modules/**",
      "addon/content/runtime/**",
      "coverage/**",
      ".deps-install/**",
      "prototypes/phase0/.cache/**",
      "prototypes/phase0/embedding/.python/**",
      "prototypes/phase0/scratch/**",
    ],
  },
  ...zotero({
    overrides: [
      {
        files: ["**/*.{ts,tsx}"],
        rules: {
          "@typescript-eslint/no-explicit-any": "off",
          "@typescript-eslint/no-unused-vars": [
            "error",
            { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
          ],
        },
      },
    ],
  }),
];
