import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["en", "ar-XB"],
  extract: {
    input: ["src/localization.tsx", "src/components/LanguageSettings.tsx"],
    ignore: ["src/**/*.test.{ts,tsx}", "src/**/*.generated.d.ts", "src/design-compatibility/**"],
    output: "src/locales/{{language}}/{{namespace}}.json",
    defaultNS: "settings",
    primaryLanguage: "en",
    secondaryLanguages: ["ar-XB"],
    removeUnusedKeys: false,
    sort: true,
    extractFromComments: false,
    warnOnConflicts: true,
  },
  lint: {
    ignore: ["src/localization.tsx"],
    ignoredAttributes: ["aria-live"],
    acceptedTags: [],
    acceptedAttributes: [],
    checkInterpolationParams: true,
    checkConcatenation: "error",
  },
  types: {
    input: ["src/locales/en/*.json"],
    basePath: "src/locales/en",
    output: "src/i18next.generated.d.ts",
  },
});
