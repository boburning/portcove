import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const eslint = require("@eslint/js");
const jsxA11y = require("eslint-plugin-jsx-a11y");
const reactHooks = require("eslint-plugin-react-hooks");
const globals = require("globals");
const tseslint = require("typescript-eslint");

const typescriptFiles = [
  "apps/desktop/src/**/*.{ts,tsx}",
  "apps/desktop/vite.config.ts",
];

export default tseslint.config(
  {
    ignores: [
      "apps/desktop/dist/**",
      "apps/desktop/node_modules/**",
      "target/**",
      "work/**",
    ],
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    ...eslint.configs.recommended,
    files: [
      "eslint.config.mjs",
      "apps/desktop/*.config.mjs",
      "scripts/**/*.mjs",
      "apps/desktop/scripts/**/*.mjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.nodeBuiltin,
    },
  },
  {
    files: ["apps/desktop/scripts/desktop-*.mjs"],
    languageOptions: {
      globals: {
        ...globals.nodeBuiltin,
        ...globals.browser,
      },
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: typescriptFiles,
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.browser,
    },
  })),
  {
    files: ["apps/desktop/src/**/*.{ts,tsx}"],
    plugins: {
      "jsx-a11y": jsxA11y,
      "react-hooks": reactHooks,
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: [
      "apps/desktop/src/**/*.test.{ts,tsx}",
      "apps/desktop/vite.config.ts",
    ],
    languageOptions: {
      globals: globals.nodeBuiltin,
    },
    rules: {
      "@typescript-eslint/require-await": "off",
      // Error-boundary tests intentionally model Tauri's structured non-Error
      // rejection payloads so the UI preserves their recovery metadata.
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      // Vitest intentionally references mocked prototype methods without
      // invoking them; this does not create an unbound production call.
      "@typescript-eslint/unbound-method": "off",
    },
  },
);
