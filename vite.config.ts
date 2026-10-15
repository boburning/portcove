import { defineConfig, type TestProjectConfiguration, type TestUserConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { playwright } from "vite-plus/test/browser-playwright";
import { createBrowserTraceRun } from "./scripts/browser-traces.ts";

const traceRun = createBrowserTraceRun(
  fileURLToPath(new URL(".", import.meta.url)),
  process.env.PORTCOVE_BROWSER_TRACE_DIR,
);
export const testReporters = ["default", traceRun.reporter] satisfies NonNullable<
  TestUserConfig["reporters"]
>;

process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(
  new URL("./work/browser-cache", import.meta.url),
);

// Each project loads the app's plugins from its config; root metadata never instantiates them.
export const desktopProjects = [
  {
    extends: fileURLToPath(new URL("./apps/desktop/vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("./apps/desktop", import.meta.url)),
    test: {
      name: "unit",
      include: ["src/**/*.test.{ts,tsx,js}", "scripts/**/*.test.{js,mjs}"],
      exclude: ["src/browser/**"],
      maxWorkers: 2,
    },
  },
  {
    extends: fileURLToPath(new URL("./apps/desktop/vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("./apps/desktop", import.meta.url)),
    test: {
      name: "browser",
      include: ["src/browser/**/*.browser.test.tsx"],
      browser: {
        enabled: true,
        headless: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        trace: {
          mode: "retain-on-failure",
          tracesDir: traceRun.directory,
        },
        screenshotFailures: true,
        screenshotDirectory: path.join(traceRun.directory, "screenshots"),
      },
    },
  },
] satisfies TestProjectConfiguration[];

export default defineConfig({
  defaultPackage: "./apps/desktop",
  fmt: {
    printWidth: 100,
    sortImports: false,
    sortPackageJson: true,
    ignorePatterns: [
      "apps/desktop/node_modules/**",
      "apps/desktop/dist/**",
      "apps/desktop/src-tauri/gen/**",
      "target/**",
      "work/**",
      "outputs/**",
      "release-assets/**",
      ".codex-remote-attachments/**",
      ".fallow/**",
      ".fallow-review/**",
      ".rscheck/**",
      ".tmp/**",
      "mutants.out/**",
      "mutants.out.old/**",
      "Portcove-CI-FiveMinutes/**",
      "**/*.generated.*",
      "apps/desktop/pnpm-lock.yaml",
      "integrations/playnite/packages.lock.json",
      "integrations/playnite/tests/packages.lock.json",
      "integrations/playnite/bin/**",
      "integrations/playnite/obj/**",
      "integrations/playnite/tests/bin/**",
      "integrations/playnite/tests/obj/**",
      "crates/portcove-core/catalog/*.json",
      "crates/**/tests/fixtures/**",
      "docs/archive/**",
      "docs/releases/[0-9]*.md",
      "Cargo.lock",
    ],
  },
  lint: {
    plugins: ["eslint", "react", "jsx-a11y", "oxc", "import", "vitest"],
    categories: {
      correctness: "error",
    },
    rules: {
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/anchor-has-content": "error",
      "jsx-a11y/anchor-is-valid": "error",
      "jsx-a11y/aria-activedescendant-has-tabindex": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-role": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/autocomplete-valid": "error",
      "jsx-a11y/click-events-have-key-events": "error",
      "jsx-a11y/heading-has-content": "error",
      "jsx-a11y/html-has-lang": "error",
      "jsx-a11y/iframe-has-title": "error",
      "jsx-a11y/img-redundant-alt": "error",
      "jsx-a11y/interactive-supports-focus": "error",
      "jsx-a11y/label-has-associated-control": "error",
      "jsx-a11y/media-has-caption": "error",
      "jsx-a11y/mouse-events-have-key-events": "error",
      "jsx-a11y/no-access-key": "error",
      "jsx-a11y/no-autofocus": "error",
      "jsx-a11y/no-distracting-elements": "error",
      "jsx-a11y/no-interactive-element-to-noninteractive-role": "error",
      "jsx-a11y/no-noninteractive-element-interactions": "error",
      "jsx-a11y/no-noninteractive-element-to-interactive-role": "error",
      "jsx-a11y/no-noninteractive-tabindex": "error",
      "jsx-a11y/no-redundant-roles": "error",
      "jsx-a11y/no-static-element-interactions": "error",
      "jsx-a11y/prefer-tag-over-role": "off",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
      "jsx-a11y/scope": "error",
      "jsx-a11y/tabindex-no-positive": "error",
      "no-array-constructor": "error",
      "no-undef": "error",
      "no-unused-expressions": "error",
      "no-unused-vars": "error",
      "react/exhaustive-deps": "error",
      "react/globals": "off",
      "react/react-in-jsx-scope": "off",
      "react/refs": "error",
      "react/rules-of-hooks": "error",
      "react/set-state-in-effect": "error",
      "vitest/require-mock-type-parameters": "off",
      "vitest/valid-expect": [
        "error",
        {
          maxArgs: 2,
        },
      ],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: [
      "apps/desktop/dist/**",
      "apps/desktop/node_modules/**",
      "apps/desktop/src-tauri/gen/**",
      "target/**",
      "work/**",
    ],
    overrides: [
      {
        files: ["**/*.mjs", "**/*.cjs", "**/*.config.{ts,mts}", "vite.config.ts"],
        env: {
          node: true,
        },
      },
      {
        files: ["apps/desktop/scripts/desktop-*.mjs", "apps/desktop/test/**/*.mjs"],
        env: {
          browser: true,
          node: true,
        },
      },
      {
        files: ["apps/desktop/src/**/*.{ts,tsx}"],
        env: {
          browser: true,
        },
      },
      {
        files: ["apps/desktop/src/**/*.test.{ts,tsx}"],
        env: {
          node: true,
        },
      },
      {
        files: ["**/*.{ts,tsx,mts,cts}"],
        plugins: ["typescript"],
        rules: {
          "typescript/await-thenable": "error",
          "typescript/ban-ts-comment": "error",
          "typescript/no-array-delete": "error",
          "typescript/no-base-to-string": "error",
          "typescript/no-duplicate-enum-values": "error",
          "typescript/no-duplicate-type-constituents": "error",
          "typescript/no-empty-object-type": "error",
          "typescript/no-explicit-any": "error",
          "typescript/no-extra-non-null-assertion": "error",
          "typescript/no-floating-promises": "error",
          "typescript/no-for-in-array": "error",
          "typescript/no-implied-eval": "error",
          "typescript/no-misused-new": "error",
          "typescript/no-misused-promises": "error",
          "typescript/no-namespace": "error",
          "typescript/no-non-null-asserted-optional-chain": "error",
          "typescript/no-redundant-type-constituents": "error",
          "typescript/no-require-imports": "error",
          "typescript/no-this-alias": "error",
          "typescript/no-unnecessary-type-assertion": "error",
          "typescript/no-unnecessary-type-constraint": "error",
          "typescript/no-unsafe-argument": "error",
          "typescript/no-unsafe-assignment": "error",
          "typescript/no-unsafe-call": "error",
          "typescript/no-unsafe-declaration-merging": "error",
          "typescript/no-unsafe-enum-comparison": "error",
          "typescript/no-unsafe-function-type": "error",
          "typescript/no-unsafe-member-access": "error",
          "typescript/no-unsafe-return": "error",
          "typescript/no-unsafe-unary-minus": "error",
          "typescript/no-wrapper-object-types": "error",
          "typescript/only-throw-error": "error",
          "typescript/prefer-as-const": "error",
          "typescript/prefer-namespace-keyword": "error",
          "typescript/restrict-plus-operands": "error",
          "typescript/restrict-template-expressions": "error",
          "typescript/triple-slash-reference": "error",
        },
      },
      {
        files: ["**/*.test.ts", "**/*.test.tsx"],
        plugins: ["typescript"],
        rules: {
          "typescript/unbound-method": "off",
        },
      },
    ],
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  test: { projects: desktopProjects, reporters: testReporters },
  staged: { "*": "vp check --fix" },
  run: {
    tasks: {
      "verify:frontend": {
        command:
          "vp run check && vp -C apps/desktop run check:content && vp -C apps/desktop test --project unit && vp -C apps/desktop run build",
        cache: false,
      },
      "test:native": { command: "vp -C apps/desktop run test:desktop", cache: false },
    },
  },
});
