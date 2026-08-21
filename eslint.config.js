// The UI's TypeScript uses this flat config.
// Formatting is Prettier's job (`npm run format`), not this config's --
// only typescript-eslint's plain `recommended` (lint rules, not the
// `stylistic` variant) is used, so the two tools don't fight each other.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "dist/**",
      "sqlcipher/**",
      "ui/*.tsbuildinfo",
      "**/*.d.ts",
    ],
  },
  {
    files: ["ui/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Every module here re-exports its own domain types by design
      // (R2Client, ReaderDocument, VaultSession, ...) -- unused-vars
      // still catches real dead code, just needs to ignore the common
      // "imported only as a type, used only in a signature" pattern.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["ui/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // This plugin's "recommended" set is tuned for React Compiler
      // adoption (this app doesn't use it). set-state-in-effect as an
      // error would flag every data-fetching hook's ordinary "reset to
      // loading, then setState with the async result" pattern (see
      // useLibraryBooks.ts, useReaderDocument.ts) -- a real, deliberate
      // pattern here, not a bug, so it's a warning instead of a hard
      // failure.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
);
